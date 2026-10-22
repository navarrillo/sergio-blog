// Keep the official standalone adapter, but resolve proxy trust from the TCP peer
// before Astro inspects forwarding headers. Never infer trust from Host headers.
import { createServer } from 'node:http';
import { isIP } from 'node:net';
if (
  process.env.COOKIE_SECURE !== 'false' &&
  (!process.env.SESSION_SECRET || !process.env.CSRF_SECRET)
)
  throw new Error(
    'Secure mode requires SESSION_SECRET and CSRF_SECRET; run bin/setup.',
  );
process.env.ASTRO_NODE_AUTOSTART = 'disabled';
const { handler } = await import('../dist/server/entry.mjs');
const trusted = (process.env.TRUSTED_PROXIES || '')
  .split(',')
  .map((v) => v.trim())
  .filter(Boolean);
const server = createServer((request, response) => {
  const peer = (request.socket.remoteAddress || 'unknown').replace(
    /^::ffff:/,
    '',
  );
  if (!trusted.includes(peer))
    for (const name of [
      'x-forwarded-for',
      'x-real-ip',
      'x-forwarded-host',
      'x-forwarded-proto',
      'x-forwarded-port',
    ])
      delete request.headers[name];
  else {
    const chain = String(
      request.headers['x-forwarded-for'] || request.headers['x-real-ip'] || '',
    )
      .split(',')
      .map((v) => v.trim().replace(/^::ffff:/, ''));
    request.headers['x-forwarded-for'] = chain.every((ip) => isIP(ip))
      ? chain.reverse().find((ip) => !trusted.includes(ip)) || peer
      : peer;
  }
  handler(request, response);
});
server.requestTimeout = 30000;
server.headersTimeout = 10000;
server.listen(
  Number(process.env.PORT || 8080),
  process.env.HOST || '127.0.0.1',
  () =>
    console.log(
      `Blog listening on http://${process.env.HOST || '127.0.0.1'}:${process.env.PORT || 8080}`,
    ),
);
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  });
