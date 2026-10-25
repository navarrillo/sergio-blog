import { z } from 'zod';
import { db, transaction } from './db';
import { now } from './config';
import { getDraft, PostInput, savePost } from './content';

export const EditableInput = PostInput.omit({
  status: true,
  featured: true,
  published_at: true,
});
export type Editable = z.infer<typeof EditableInput>;
export function editable(post: any): Editable {
  return EditableInput.parse(post);
}
export class EditorialError extends Error {
  constructor(
    message: string,
    public status = 400,
    public fields: Record<string, string> = {},
  ) {
    super(message);
  }
}
export function workingPost(id: number) {
  const post = getDraft(id);
  if (!post) return undefined;
  const copy = db()
    .prepare('SELECT content,updated_at FROM working_copies WHERE post_id=?')
    .get(id) as any;
  return {
    ...post,
    ...(copy ? JSON.parse(copy.content) : {}),
    live_slug: post.slug,
    has_changes: Boolean(copy),
    working_updated_at: copy?.updated_at || post.updated_at,
  };
}
export function visibility(post: any) {
  if (post.status === 'published') {
    if (post.published_at > now()) return 'Scheduled';
    return post.has_changes ? 'Published · unpublished changes' : 'Published';
  }
  return post.status === 'trash' ? 'Trash' : 'Draft';
}
function checkVersion(id: number, expected: number) {
  const post = getDraft(id);
  if (!post) throw new EditorialError('Post not found', 404);
  if (!Number.isSafeInteger(expected) || expected !== post.edit_version)
    throw new EditorialError(
      'This post changed in another tab or through the bot. Your text is still here. Copy your changes or download them before reloading.',
      409,
    );
  return post;
}
function availableSlug(slug: string, id?: number) {
  if (
    db()
      .prepare(
        "SELECT id FROM posts WHERE slug=? AND id<>? UNION ALL SELECT post_id FROM redirects WHERE slug=? AND post_id<>? UNION ALL SELECT post_id FROM working_copies WHERE json_extract(content,'$.slug')=? AND post_id<>?",
      )
      .get(slug, id || 0, slug, id || 0, slug, id || 0)
  )
    throw new EditorialError(
      'This URL is already used or reserved. Choose another slug.',
      400,
      { slug: 'This URL is already used or reserved. Choose another slug.' },
    );
}
function checkpoint(
  id: number,
  snapshot: any,
  automatic: boolean,
  kind = 'working',
) {
  const previous = db()
    .prepare(
      'SELECT snapshot FROM revisions WHERE post_id=? ORDER BY id DESC LIMIT 1',
    )
    .get(id) as any;
  if (previous) {
    try {
      const parsed = EditableInput.safeParse(JSON.parse(previous.snapshot));
      if (
        parsed.success &&
        JSON.stringify(parsed.data) === JSON.stringify(editable(snapshot))
      )
        return;
    } catch {
      /* An old incomplete revision must not prevent new saves. */
    }
  }
  if (automatic) {
    const latest = db()
      .prepare(
        'SELECT created_at FROM revisions WHERE post_id=? ORDER BY id DESC LIMIT 1',
      )
      .get(id) as any;
    if (latest && Date.now() - Date.parse(latest.created_at) < 300000) return;
  }
  db()
    .prepare(
      'INSERT INTO revisions(post_id,snapshot,created_at,kind) VALUES(?,?,?,?)',
    )
    .run(id, JSON.stringify(snapshot), now(), kind);
}
export function saveWorking(
  input: unknown,
  id?: number,
  expected?: number,
  automatic = false,
  creationKey?: string,
) {
  const content = editable(input);
  return transaction(() => {
    if (!id && creationKey) {
      const created = db()
        .prepare(
          'SELECT post_id,edit_version FROM editor_creations WHERE request_key=?',
        )
        .get(creationKey) as any;
      if (created)
        return {
          ...workingPost(created.post_id),
          edit_version: created.edit_version,
          creation_replayed: true,
        };
    }
    const live = id ? checkVersion(id, expected!) : undefined;
    if (live?.status === 'trash')
      throw new EditorialError('Restore this post to drafts before editing.');
    availableSlug(content.slug, id);
    if (!id) {
      const post = workingPost(savePost({ ...content, status: 'draft' }))!;
      if (creationKey)
        db()
          .prepare(
            'INSERT INTO editor_creations(request_key,post_id,edit_version) VALUES(?,?,?)',
          )
          .run(creationKey, post.id, post.edit_version);
      return post;
    }
    const current = workingPost(id)!;
    if (JSON.stringify(content) === JSON.stringify(editable(current))) {
      if (!automatic) checkpoint(id, current, false);
      return current;
    }
    checkpoint(id, current, automatic);
    if (live!.status === 'published') {
      if (JSON.stringify(content) === JSON.stringify(editable(live)))
        db().prepare('DELETE FROM working_copies WHERE post_id=?').run(id);
      else
        db()
          .prepare(
            'INSERT INTO working_copies(post_id,content,updated_at) VALUES(?,?,?) ON CONFLICT(post_id) DO UPDATE SET content=excluded.content,updated_at=excluded.updated_at',
          )
          .run(id, JSON.stringify(content), now());
      // A private save must not change the live modified date or public search index.
      db()
        .prepare('UPDATE posts SET edit_version=edit_version+1 WHERE id=?')
        .run(id);
    } else savePost({ ...live, ...content }, id, false);
    return workingPost(id);
  });
}
export function postAction(
  id: number,
  intent: string,
  expected: number,
  scheduledAt?: string,
) {
  return transaction(() => {
    const live = checkVersion(id, expected);
    const current = workingPost(id)!;
    if (intent === 'publish' || intent === 'schedule') {
      if (live.status === 'trash')
        throw new EditorialError('Restore to drafts before publishing.');
      if (
        live.status === 'published' &&
        live.published_at <= now() &&
        intent === 'schedule'
      )
        throw new EditorialError(
          'Updates to live articles publish immediately.',
        );
      let publication = live.published_at;
      if (intent === 'schedule') {
        if (
          !scheduledAt ||
          !Number.isFinite(Date.parse(scheduledAt)) ||
          Date.parse(scheduledAt) <= Date.now()
        )
          throw new EditorialError('Choose a future publication date.');
        publication = new Date(scheduledAt).toISOString();
      } else if (live.status !== 'published' || live.published_at > now())
        publication =
          live.published_at && live.published_at <= now()
            ? live.published_at
            : now();
      availableSlug(current.slug, id);
      // Read pin/ownership from the live row; working copies never own these fields.
      checkpoint(id, current, false, 'working');
      savePost(
        {
          ...live,
          ...editable(current),
          status: 'published',
          published_at: publication,
        },
        id,
      );
      db().prepare('DELETE FROM working_copies WHERE post_id=?').run(id);
    } else if (
      intent === 'unpublish' ||
      intent === 'trash' ||
      intent === 'restore'
    ) {
      if (intent === 'unpublish' && live.status !== 'published')
        throw new EditorialError('This post is not published.');
      if (intent === 'restore' && live.status !== 'trash')
        throw new EditorialError('Only trashed posts can be restored.');
      savePost(
        {
          ...live,
          ...editable(current),
          status: intent === 'trash' ? 'trash' : 'draft',
        },
        id,
      );
      db().prepare('DELETE FROM working_copies WHERE post_id=?').run(id);
    } else throw new EditorialError('Unknown post action');
    return workingPost(id)!;
  });
}
export function restoreWorkingRevision(
  id: number,
  revisionId: number,
  expected: number,
) {
  return transaction(() => {
    const live = checkVersion(id, expected);
    if (live.status === 'trash')
      throw new EditorialError(
        'Restore to drafts before restoring a revision.',
      );
    const revision = db()
      .prepare('SELECT snapshot FROM revisions WHERE post_id=? AND id=?')
      .get(id, revisionId) as any;
    if (!revision) throw new EditorialError('Revision not found', 404);
    return saveWorking(editable(JSON.parse(revision.snapshot)), id, expected);
  });
}
export function setPinned(id: number, pinned: boolean) {
  if (!getDraft(id)) throw new EditorialError('Post not found', 404);
  db()
    .prepare('UPDATE posts SET featured=? WHERE id=?')
    .run(Number(pinned), id);
}
export function adminTags() {
  return db()
    .prepare(
      `WITH usage AS (
    SELECT p.id,j.value AS tag,CASE WHEN p.status='published' AND p.published_at<=? THEN 1 ELSE 0 END AS published,
      CASE WHEN p.status='draft' OR (p.status='published' AND p.published_at>?) THEN 1 ELSE 0 END AS drafts
      FROM posts p,json_each(p.tags) j
    UNION ALL SELECT w.post_id,j.value AS tag,0 AS published,1 AS drafts FROM working_copies w,json_each(json_extract(w.content,'$.tags')) j
  ) SELECT tag,count(DISTINCT CASE WHEN published=1 THEN id END) AS published,
    count(DISTINCT CASE WHEN drafts=1 THEN id END) AS drafts,count(DISTINCT id) AS count
    FROM usage GROUP BY tag ORDER BY tag`,
    )
    .all(now(), now()) as any[];
}
export function changeTag(old: string, replacement: string) {
  z.string()
    .regex(/^[a-z0-9-]+$/)
    .max(50)
    .parse(old);
  z.string()
    .regex(/^[a-z0-9-]*$/)
    .max(50)
    .parse(replacement);
  return transaction(() => {
    let count = 0;
    for (const row of db().prepare('SELECT id FROM posts').all() as any[]) {
      const live = getDraft(row.id)!;
      const current = workingPost(row.id)!;
      const replace = (tags: string[]) => [
        ...new Set(
          tags.flatMap((t) =>
            t === old ? (replacement ? [replacement] : []) : [t],
          ),
        ),
      ];
      if (!live.tags.includes(old) && !current.tags.includes(old)) continue;
      // Tag management is an explicit global metadata edit. Keep live and pending tags in sync.
      savePost({ ...live, tags: replace(live.tags) }, row.id);
      if (current.has_changes)
        db()
          .prepare(
            'UPDATE working_copies SET content=?,updated_at=? WHERE post_id=?',
          )
          .run(
            JSON.stringify({
              ...editable(current),
              tags: replace(current.tags),
            }),
            now(),
            row.id,
          );
      count++;
    }
    return count;
  });
}
export function listAdminPosts(params: URLSearchParams) {
  const page = Math.max(1, Math.floor(Number(params.get('page')) || 1));
  const where: string[] = [];
  const values: (string | number)[] = [];
  const q = (params.get('q') || '').trim().slice(0, 300);
  if (q) {
    where.push(
      "(COALESCE(json_extract(w.content,'$.title'),p.title) LIKE ? ESCAPE '\\' OR COALESCE(json_extract(w.content,'$.body'),p.body) LIKE ? ESCAPE '\\')",
    );
    const term = '%' + q.replace(/[\\%_]/g, '\\$&') + '%';
    values.push(term, term);
  }
  const status = params.get('status');
  if (status === 'scheduled') {
    where.push("p.status='published' AND p.published_at>?");
    values.push(now());
  } else if (status === 'published') {
    where.push("p.status='published' AND p.published_at<=?");
    values.push(now());
  } else if (status === 'changes') where.push('w.post_id IS NOT NULL');
  else if (status === 'draft' || status === 'trash') {
    where.push('p.status=?');
    values.push(status);
  } else where.push("p.status<>'trash'");
  if (['article', 'note', 'x_post'].includes(params.get('type') || '')) {
    where.push("COALESCE(json_extract(w.content,'$.type'),p.type)=?");
    values.push(params.get('type')!);
  }
  if (params.get('tag')) {
    where.push(
      "EXISTS(SELECT 1 FROM json_each(COALESCE(json_extract(w.content,'$.tags'),p.tags)) WHERE value=?)",
    );
    values.push(params.get('tag')!);
  }
  if (params.get('pinned') === '1') where.push('p.featured=1');
  if (params.get('bot') === '1')
    where.push('p.created_by_token_id IS NOT NULL');
  const from =
    'FROM posts p LEFT JOIN working_copies w ON w.post_id=p.id WHERE ' +
    where.join(' AND ');
  const total = Number(
    (
      db()
        .prepare('SELECT count(*) AS count ' + from)
        .get(...values) as any
    ).count,
  );
  const pages = Math.max(1, Math.ceil(total / 20));
  const currentPage = Math.min(page, pages);
  const sort = params.get('sort');
  const order =
    sort === 'title'
      ? "COALESCE(json_extract(w.content,'$.title'),p.title) COLLATE NOCASE,p.id"
      : sort === 'oldest'
        ? 'p.created_at ASC,p.id ASC'
        : 'COALESCE(w.updated_at,p.updated_at) DESC,p.id DESC';
  const rows = db()
    .prepare(
      'SELECT p.id ' + from + ' ORDER BY ' + order + ' LIMIT 20 OFFSET ?',
    )
    .all(...values, (currentPage - 1) * 20) as any[];
  return {
    items: rows.map((row) => workingPost(row.id)!),
    total,
    page: currentPage,
    pages,
  };
}
