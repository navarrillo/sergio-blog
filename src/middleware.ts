import { defineMiddleware } from 'astro:middleware';
import { session, clientIP, allow } from './lib/auth';
import { config } from './lib/config';
export const onRequest = defineMiddleware(async (context, next) => {
  let path: string;
  try {
    path = decodeURIComponent(context.url.pathname)
      .replaceAll('\\', '/')
      .replace(/\/+/g, '/');
  } catch {
    return new Response('Invalid path', { status: 400 });
  }
  context.locals.ip = clientIP(context.clientAddress, context.request.headers);
  if (path.startsWith('/admin') || path.startsWith('/api/admin')) {
    context.locals.session = session(context.request);
    if (
      path !== '/admin/login' &&
      path !== '/api/admin/login' &&
      !context.locals.session
    )
      return path.startsWith('/api/')
        ? new Response('Unauthorized', { status: 401 })
        : context.redirect('/admin/login', 303);
  }
  if (
    (path.startsWith('/api/v1/') || path === '/mcp') &&
    !allow('public:' + context.locals.ip, 60)
  )
    return new Response('Rate limit exceeded', {
      status: 429,
      headers: { 'Retry-After': '60' },
    });
  const response = await next();
  // Security headers are owned exclusively by the application, not Caddy.
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=()',
  );
  response.headers.set(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' https://analytics.sergionavarro.me; style-src 'self'; img-src 'self' https: data:; connect-src 'self' https://analytics.sergionavarro.me; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  );
  if (config.secure)
    response.headers.set('Strict-Transport-Security', 'max-age=31536000');
  if (path.startsWith('/admin') || path.startsWith('/api/admin')) {
    response.headers.set('Cache-Control', 'no-store');
    response.headers.set('X-Robots-Tag', 'noindex, nofollow');
  }
  return response;
});
