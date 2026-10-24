import { z } from 'zod';
import { db, transaction } from './db';
import { getDraft, savePost } from './content';
import { slugify } from './slug';
import type { AgentToken } from './auth';

const fields = z
  .object({
    title: z.string().trim().min(1).max(200),
    summary: z.string().max(500),
    body: z.string().refine((s) => Buffer.byteLength(s, 'utf8') <= 200000),
    tags: z
      .array(
        z
          .string()
          .min(1)
          .max(40)
          .regex(/^[a-z0-9-]+$/),
      )
      .max(10),
    type: z.enum(['article', 'note']),
    slug: z
      .string()
      .max(180)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  })
  .strict();
const createInput = fields.partial().required({ title: true });
const patchInput = fields.partial().refine((v) => Object.keys(v).length > 0);
export class AgentError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function agentInput(request: Request, patch: boolean) {
  if (
    request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !==
    'application/json'
  )
    throw new AgentError(415, 'Invalid input');
  // Bound bytes while streaming too: Content-Length is optional and untrusted.
  const reader = request.body?.getReader();
  if (!reader) throw new AgentError(400, 'Invalid input');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      // JSON can escape each Markdown byte as six bytes (\\u0000).
      if (length > 1250000) {
        await reader.cancel();
        throw new AgentError(413, 'Invalid input');
      }
      chunks.push(value);
    }
    const raw = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
    );
    return (patch ? patchInput : createInput).parse(raw);
  } catch (error) {
    if (error instanceof AgentError) throw error;
    throw new AgentError(400, 'Invalid input');
  } finally {
    reader.releaseLock();
  }
}
export function ownedDraft(id: number, token: AgentToken) {
  const row = db()
    .prepare(
      `SELECT p.* FROM posts p JOIN agent_tokens t ON t.id=p.created_by_token_id
    WHERE p.id=? AND t.id=? AND t.revoked_at IS NULL AND p.status='draft' AND p.agent_access_revoked_at IS NULL`,
    )
    .get(id, token.id) as any;
  if (!row) throw new AgentError(404, 'Not found');
  return {
    ...row,
    tags: JSON.parse(String(row.tags)),
    featured: Boolean(row.featured),
  };
}
function uniqueSlug(wanted: string, id?: number) {
  const base = wanted.slice(0, 180).replace(/-+$/, '') || 'draft';
  let slug = base;
  let suffix = 2;
  while (
    db()
      .prepare(
        'SELECT id FROM posts WHERE slug=? AND id<>? UNION ALL SELECT post_id FROM redirects WHERE slug=? AND post_id<>?',
      )
      .get(slug, id || 0, slug, id || 0)
  ) {
    const ending = '-' + suffix++;
    slug = base.slice(0, 180 - ending.length).replace(/-+$/, '') + ending;
  }
  return slug;
}
export function agentSave(
  input: z.infer<typeof patchInput>,
  token: AgentToken,
  id?: number,
) {
  return transaction(() => {
    // Authentication happened before the asynchronous body read. Recheck revocation under the write lock.
    if (
      !db()
        .prepare(
          'SELECT id FROM agent_tokens WHERE id=? AND revoked_at IS NULL',
        )
        .get(token.id)
    )
      throw new AgentError(401, 'Unauthorized');
    const old = id ? ownedDraft(id, token) : undefined;
    const slug = uniqueSlug(
      input.slug || old?.slug || slugify(input.title!),
      id,
    );
    const saved = savePost({ ...old, ...input, slug, status: 'draft' }, id);
    if (!id)
      db()
        .prepare('UPDATE posts SET created_by_token_id=? WHERE id=?')
        .run(token.id, saved);
    return getDraft(saved)!;
  });
}
export function agentReply(post: ReturnType<typeof getDraft>) {
  return {
    id: post.id,
    slug: post.slug,
    status: 'draft',
    preview_url: '/admin/edit?id=' + post.id,
    updated_at: post.updated_at,
  };
}

const listQuery = z
  .object({
    limit: z
      .string()
      .regex(/^[1-9][0-9]?$/)
      .transform(Number)
      .refine((n) => n <= 50)
      .optional(),
    cursor: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
  })
  .strict();
export function listAgentDrafts(params: URLSearchParams, token: AgentToken) {
  try {
    for (const key of params.keys())
      if (params.getAll(key).length !== 1)
        throw new Error('Duplicate query parameter');
    const query = listQuery.parse(Object.fromEntries(params));
    const limit = query.limit ?? 20;
    const values: (string | number)[] = [token.id];
    let cursorWhere = '';
    if (query.cursor) {
      const bytes = Buffer.from(query.cursor, 'base64url');
      if (bytes.toString('base64url') !== query.cursor)
        throw new Error('Invalid cursor');
      const [date, id] = z
        .tuple([
          z.iso.datetime(),
          z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        ])
        .parse(JSON.parse(bytes.toString('utf8')));
      if (new Date(date).toISOString() !== date)
        throw new Error('Invalid cursor date');
      cursorWhere = ' AND (p.updated_at<? OR (p.updated_at=? AND p.id<?))';
      values.push(date, date, id);
    }
    const rows = db()
      .prepare(
        `SELECT p.id,p.title,p.slug,p.updated_at FROM posts p JOIN agent_tokens t ON t.id=p.created_by_token_id
      WHERE t.id=? AND t.revoked_at IS NULL AND p.status='draft' AND p.agent_access_revoked_at IS NULL
      ${cursorWhere} ORDER BY p.updated_at DESC,p.id DESC LIMIT ?`,
      )
      .all(...values, limit + 1) as any[];
    const items = rows
      .slice(0, limit)
      .map((post) => ({ ...post, preview_url: '/admin/edit?id=' + post.id }));
    const last = items.at(-1);
    return {
      items,
      next_cursor:
        rows.length > limit
          ? Buffer.from(JSON.stringify([last!.updated_at, last!.id])).toString(
              'base64url',
            )
          : null,
    };
  } catch {
    throw new AgentError(400, 'Invalid query');
  }
}
export function agentReadReply(post: ReturnType<typeof ownedDraft>) {
  return {
    ...agentReply(post),
    title: post.title,
    summary: post.summary,
    body: post.body,
    tags: post.tags,
    type: post.type,
  };
}
