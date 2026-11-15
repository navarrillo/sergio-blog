import type { APIRoute } from 'astro';
import { allow, cookieName, sessionCookieOptions } from '../../../../lib/auth';
import { config } from '../../../../lib/config';
import {
  finishAuthentication,
  readJson,
  signInError,
} from '../../../../lib/passkeys';

export const POST: APIRoute = async ({ request, locals, cookies }) => {
  if (request.headers.get('origin') !== config.origin || !locals.ip)
    return signInError();
  if (!allow('login:' + locals.ip, 6, 600000)) return signInError(429);
  const token = await finishAuthentication(await readJson(request));
  if (!token) return signInError();
  cookies.set(cookieName(), token, sessionCookieOptions());
  return Response.json({ ok: true, redirect: '/admin' });
};
