import type { APIRoute } from 'astro';
import { authenticateAgent, allow, retryAfter } from '../../../lib/auth';
import {
  agentInput,
  agentSave,
  ownedDraft,
  agentReply,
  agentReadReply,
  listAgentDrafts,
  AgentError,
} from '../../../lib/agent';
import { db } from '../../../lib/db';
import { now } from '../../../lib/config';

const json = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) =>
  Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    },
  });
export const ALL: APIRoute = async ({ request, params, locals, url }) => {
  if (process.env.AGENT_API_ENABLED !== 'true')
    return json({ error: 'Not found' }, 404);
  let token;
  try {
    token = authenticateAgent(request.headers.get('authorization'));
  } catch {
    return json({ error: 'Unavailable' }, 503);
  }
  if (!token) {
    const key = 'agent-auth:' + locals.ip;
    const allowed = allow(key, 20, 600000);
    console.warn('blog-agent-auth-failed ip=' + locals.ip);
    return json({ error: 'Unauthorized' }, allowed ? 401 : 429, {
      'WWW-Authenticate': 'Bearer',
      ...(!allowed ? { 'Retry-After': retryAfter(key) } : {}),
    });
  }
  const route = params.route || '';
  const match = /^v1\/drafts\/([1-9][0-9]*)$/.exec(route);
  const id = match ? Number(match[1]) : undefined;
  const create = route === 'v1/drafts' && request.method === 'POST';
  const list = route === 'v1/drafts' && request.method === 'GET';
  const read = (Boolean(match) || list) && request.method === 'GET';
  const patch = Boolean(match) && request.method === 'PATCH';
  if (
    (!create && !read && !patch) ||
    (id !== undefined && !Number.isSafeInteger(id))
  )
    return json({ error: 'Not found' }, 404);
  const key = `agent-${read ? 'read' : 'write'}:${token.id}`;
  if (!allow(key, read ? 120 : 30, 3600000))
    return json({ error: 'Rate limit exceeded' }, 429, {
      'Retry-After': retryAfter(key),
    });
  try {
    const listing = list ? listAgentDrafts(url.searchParams, token) : undefined;
    const post = list
      ? undefined
      : read
        ? ownedDraft(id!, token)
        : agentSave(await agentInput(request, patch), token, id);
    db()
      .prepare('UPDATE agent_tokens SET last_used_at=? WHERE id=?')
      .run(now(), token.id);
    const status = create ? 201 : 200;
    console.info(
      'blog-agent-call ' +
        JSON.stringify({
          token: token.name,
          method: request.method,
          path: url.pathname,
          draft_id: post?.id ?? null,
          status,
        }),
    );
    return json(
      listing || (read ? agentReadReply(post!) : agentReply(post!)),
      status,
    );
  } catch (error) {
    if (error instanceof AgentError)
      return json({ error: error.message }, error.status);
    // Do not log parser errors, which can contain Markdown or credentials.
    return json({ error: 'Invalid input' }, 400);
  }
};
