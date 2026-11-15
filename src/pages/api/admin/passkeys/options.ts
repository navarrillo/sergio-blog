import type { APIRoute } from 'astro';
import { csrfValid } from '../../../../lib/auth';
import {
  passkeyError,
  registrationOptions,
  withinReauth,
} from '../../../../lib/passkeys';

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
  if (!locals.ip) return passkeyError(400);
  try {
    if (!withinReauth(locals.session.authenticated_at))
      return passkeyError(403, 'Sign in again to add a passkey.');
    const options = await registrationOptions(
      locals.session.token,
      locals.session.authenticated_at,
      locals.ip,
    );
    return options ? Response.json(options) : passkeyError(400);
  } catch {
    return passkeyError(400);
  }
};
