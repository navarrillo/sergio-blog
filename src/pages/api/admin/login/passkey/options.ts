import type { APIRoute } from 'astro';
import { allow } from '../../../../../lib/auth';
import { config } from '../../../../../lib/config';
import {
  authenticationOptions,
  signInError,
} from '../../../../../lib/passkeys';

export const POST: APIRoute = async ({ request, locals }) => {
  if (request.headers.get('origin') !== config.origin || !locals.ip)
    return signInError();
  if (!allow('login:' + locals.ip, 6, 600000)) return signInError(429);
  try {
    return Response.json(await authenticationOptions(locals.ip));
  } catch {
    return signInError();
  }
};
