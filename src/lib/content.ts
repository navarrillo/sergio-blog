import { z } from 'zod';
import { marked } from 'marked';
import sanitize from 'sanitize-html';
import { db, transaction } from './db';
import { now } from './config';
export const safeURL = z
  .string()
  .max(2048)
  .refine((s) => !s || /^https?:\/\//i.test(s), 'Use an http(s) URL');
export const imageURL = z
  .string()
  .max(2048)
  .refine(
    (s) => !s || /^\/uploads\/[a-f0-9-]+\.webp$/.test(s),
    'Upload an image first',
  );
export const PostInput = z.object({
  title: z.string().trim().min(1).max(240),
  slug: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .max(180),
  summary: z.string().max(1000).default(''),
  body: z.string().max(200000).default(''),
  type: z.enum(['article', 'note', 'x_post']).default('article'),
  status: z.enum(['draft', 'published', 'trash']).default('draft'),
  tags: z
    .array(
      z
        .string()
        .regex(/^[a-z0-9-]+$/)
        .max(50),
    )
    .max(30)
    .default([]),
  image: imageURL.default(''),
  featured: z.boolean().default(false),
  source_url: safeURL.default(''),
  published_at: z.iso.datetime().nullable().optional(),
});
export type Post = ReturnType<typeof hydrate>;
function hydrate(row: any) {
  return row
    ? { ...row, tags: JSON.parse(row.tags), featured: Boolean(row.featured) }
    : undefined;
}
export function renderMarkdown(body: string) {
  return sanitize(marked.parse(body, { async: false }) as string, {
    allowedTags: sanitize.defaults.allowedTags.concat(['img']),
    allowedAttributes: {
      ...sanitize.defaults.allowedAttributes,
      img: ['src', 'alt', 'width', 'height', 'loading'],
      a: ['href', 'title', 'rel'],
    },
    allowedSchemes: ['http', 'https'],
    allowProtocolRelative: false,
    transformTags: {
      a: sanitize.simpleTransform('a', { rel: 'noopener noreferrer' }),
    },
  });
}
export function plain(body: string) {
  return sanitize(renderMarkdown(body), {
    allowedTags: [],
    allowedAttributes: {},
  });
}
export const getPost = (slug: string) =>
  hydrate(
    db()
      .prepare(
        "SELECT * FROM posts WHERE slug=? AND status='published' AND published_at<=?",
      )
      .get(slug, now()),
  );
export const getDraft = (id: number) =>
  hydrate(db().prepare('SELECT * FROM posts WHERE id=?').get(id));
export function queryPosts(params: URLSearchParams) {
  const limit = Math.min(
    100,
    Math.max(1, Number(params.get('limit') || 20) || 20),
  );
  const where = ["p.status='published'", 'p.published_at<=?'];
  const values: any[] = [now()];
  let join = '';
  const q = (params.get('q') || '').trim().slice(0, 300);
  if (q) {
    join = 'JOIN posts_fts f ON f.rowid=p.id';
    where.push('posts_fts MATCH ?');
    values.push(
      q
        .split(/\s+/)
        .map((s) => '"' + s.replaceAll('"', '""') + '"')
        .join(' AND '),
    );
  }
  for (const field of ['type', 'since', 'tag']) {
    const value = params.get(field);
    if (!value) continue;
    if (field === 'type') {
      where.push('p.type=?');
      values.push(value);
    }
    if (field === 'tag') {
      where.push('EXISTS (SELECT 1 FROM json_each(p.tags) WHERE value=?)');
      values.push(value);
    }
    if (field === 'since') {
      if (!Number.isFinite(Date.parse(value)))
        throw new Error('Invalid since date');
      where.push('p.published_at>=?');
      values.push(new Date(value).toISOString());
    }
  }
  const cursor = params.get('cursor');
  if (cursor) {
    let decoded;
    try {
      decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString());
    } catch {
      throw new Error('Invalid cursor');
    }
    if (
      !Array.isArray(decoded) ||
      decoded.length !== 2 ||
      typeof decoded[0] !== 'string' ||
      !Number.isSafeInteger(decoded[1])
    )
      throw new Error('Invalid cursor');
    where.push('(p.published_at < ? OR (p.published_at=? AND p.id<?))');
    values.push(decoded[0], decoded[0], decoded[1]);
  }
  const rows = db()
    .prepare(
      `SELECT p.* FROM posts p ${join} WHERE ${where.join(' AND ')} ORDER BY p.published_at DESC,p.id DESC LIMIT ?`,
    )
    .all(...values, limit + 1)
    .map(hydrate);
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    next_cursor: hasMore
      ? Buffer.from(JSON.stringify([last.published_at, last.id])).toString(
          'base64url',
        )
      : null,
  };
}
export function tags() {
  return db()
    .prepare(
      "SELECT j.value AS tag,count(*) AS count FROM posts p,json_each(p.tags) j WHERE status='published' AND published_at<=? GROUP BY j.value ORDER BY count DESC,j.value",
    )
    .all(now());
}
export const projects = () =>
  db().prepare('SELECT * FROM projects ORDER BY id DESC').all();
export function savePost(input: unknown, id?: number) {
  const p = PostInput.parse(input);
  return transaction(() => {
    const old = id ? getDraft(id) : undefined;
    if (id && !old) throw new Error('Post not found');
    if (
      db()
        .prepare('SELECT slug FROM redirects WHERE slug=? AND post_id<>?')
        .get(p.slug, id || 0)
    )
      throw new Error('Slug is reserved by a previous URL');
    if (old) {
      db()
        .prepare(
          'INSERT INTO revisions(post_id,snapshot,created_at) VALUES(?,?,?)',
        )
        .run(id!, JSON.stringify(old), now());
      if (old.slug !== p.slug) {
        db()
          .prepare('INSERT OR REPLACE INTO redirects VALUES(?,?)')
          .run(old.slug, id!);
        db()
          .prepare('DELETE FROM redirects WHERE slug=? AND post_id=?')
          .run(p.slug, id!);
      }
    }
    const published =
      p.status === 'published'
        ? p.published_at || old?.published_at || now()
        : p.published_at || old?.published_at || null;
    const values = [
      p.title,
      p.slug,
      p.summary,
      p.body,
      p.type,
      p.status,
      JSON.stringify(p.tags),
      p.image,
      Number(p.featured),
      p.source_url,
      published,
      now(),
    ];
    if (id) {
      db()
        .prepare(
          'UPDATE posts SET title=?,slug=?,summary=?,body=?,type=?,status=?,tags=?,image=?,featured=?,source_url=?,published_at=?,updated_at=? WHERE id=?',
        )
        .run(...values, id);
      return id;
    }
    return Number(
      db()
        .prepare(
          'INSERT INTO posts(title,slug,summary,body,type,status,tags,image,featured,source_url,published_at,updated_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
        )
        .run(...values, now()).lastInsertRowid,
    );
  });
}
export function restoreRevision(postId: number, revisionId: number) {
  const row = db()
    .prepare('SELECT snapshot FROM revisions WHERE id=? AND post_id=?')
    .get(revisionId, postId) as any;
  if (!row) throw new Error('Revision not found');
  const snapshot = JSON.parse(row.snapshot);
  return savePost({ ...snapshot, status: 'draft' }, postId);
}
export function redirectFor(slug: string) {
  return db()
    .prepare(
      "SELECT p.slug FROM redirects r JOIN posts p ON p.id=r.post_id WHERE r.slug=? AND p.status='published' AND p.published_at<=?",
    )
    .get(slug, now()) as { slug: string } | undefined;
}
