import type { APIRoute } from 'astro';
import { csrfValid } from '../../../../lib/auth';
import {
  deletePasskey,
  passkeyError,
  passkeyId,
  readJson,
  renamePasskey,
} from '../../../../lib/passkeys';

function denied(request: Request, csrf: string) {
  return csrfValid(request, csrf, request.headers.get('x-csrf') || '')
    ? null
    : passkeyError(403);
}
export const PATCH: APIRoute = async ({ request, params, locals }) => {
  if (!locals.session) return new Response('Unauthorized', { status: 401 });
  const blocked = denied(request, locals.session.csrf);
  if (blocked) return blocked;
  const id = passkeyId(params.id);
  if (!id) return passkeyError(400);
  try {
    const body = await readJson(request);
    const name =
      body && typeof body === 'object' && !Array.isArray(body)
        ? (body as { name?: unknown }).name
        : undefined;
    const renamed = renamePasskey(id, name);
    return renamed ? Response.json({ id, name: renamed }) : passkeyError(400);
  } catch {
    return passkeyError(400);
  }
};
export const DELETE: APIRoute = async ({ request, params, locals }) => {
  if (!locals.session) return new Response('Unauthorized', { status: 401 });
  const blocked = denied(request, locals.session.csrf);
  if (blocked) return blocked;
  const id = passkeyId(params.id);
  if (!id || !deletePasskey(id)) return passkeyError(400);
  return Response.json({ ok: true });
};
