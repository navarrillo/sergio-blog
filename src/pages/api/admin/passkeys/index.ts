import type { APIRoute } from 'astro';
import { csrfValid } from '../../../../lib/auth';
import {
  finishRegistration,
  listPasskeys,
  passkeyError,
  readJson,
  withinReauth,
} from '../../../../lib/passkeys';

export const GET: APIRoute = async ({ locals }) => {
  if (!locals.session) return new Response('Unauthorized', { status: 401 });
  let canRegister = false;
  try {
    canRegister = withinReauth(locals.session.authenticated_at);
  } catch {
    canRegister = false;
  }
  return Response.json({ passkeys: listPasskeys(), can_register: canRegister });
};
export const POST: APIRoute = async ({ request, locals }) => {
  if (!locals.session) return new Response('Unauthorized', { status: 401 });
  if (
    !csrfValid(
      request,
      locals.session.csrf,
      request.headers.get('x-csrf') || '',
    )
  )
    return passkeyError(403);
  try {
    if (!withinReauth(locals.session.authenticated_at))
      return passkeyError(403, 'Sign in again to add a passkey.');
    const body = await readJson(request);
    const name =
      body && typeof body === 'object' && !Array.isArray(body)
        ? (body as { name?: unknown }).name
        : undefined;
    const saved = await finishRegistration(
      body,
      name,
      locals.session.token,
      locals.session.authenticated_at,
    );
    return saved ? Response.json(saved) : passkeyError(400);
  } catch {
    return passkeyError(400);
  }
};
