import assert from 'node:assert/strict';
import { assertBuiltHtml, assertScriptPolicy } from './csp';
import { request as httpRequest } from 'node:http';
import sharp from 'sharp';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import argon2 from 'argon2';
import { unzipSync, strFromU8 } from 'fflate';
const root = mkdtempSync(path.join(tmpdir(), 'blog-integration-'));
Object.assign(process.env, {
  AGENT_API_ENABLED: 'true',
  AGENT_TOKEN_SECRET: 'fixture-agent-secret-with-at-least-32-bytes',
  DATA_DIR: root + '/data',
  UPLOADS_DIR: root + '/uploads',
  BACKUPS_DIR: root + '/backups',
  COOKIE_SECURE: 'false',
  PUBLIC_ORIGIN: 'http://127.0.0.1:44321',
  UMAMI_INTERNAL_URL: 'http://127.0.0.1:1',
  UMAMI_WEBSITE_ID: 'unavailable',
});
mkdirSync(root + '/uploads');
const { migrate, db, setSetting } = await import('../src/lib/db');
const { savePost, getDraft } = await import('../src/lib/content');
const { totp } = await import('../src/lib/auth');
await migrate();
const published = savePost({
  title: 'Public article',
  slug: 'public',
  body: '# A public idea',
  summary: 'Published summary',
  status: 'published',
  tags: ['test'],
});
savePost({
  title: 'Private secret',
  slug: 'secret',
  body: 'NEVER_EXPOSE_THIS',
});
const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
db()
  .prepare('INSERT INTO admin(id,password_hash,totp_secret) VALUES(1,?,?)')
  .run(await argon2.hash('a sufficiently long password'), secret);
let child: ReturnType<typeof spawn>;
let logs = '';
const base = 'http://127.0.0.1:44321';
async function start() {
  child = spawn(process.execPath, ['bin/server.mjs'], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: '44321' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (b) => {
    logs += b;
  });
  child.stderr?.on('data', (b) => {
    logs += b;
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(base + '/healthz')).ok) return;
    } catch {
      /* Wait for the server. */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('Server did not start: ' + logs);
}
async function stop() {
  if (child.exitCode === null) {
    child.kill('SIGTERM');
    await new Promise((r) => child.once('exit', r));
  }
}
const get = (p: string, init: RequestInit = {}) =>
  fetch(base + p, { redirect: 'manual', ...init });
try {
  await assertBuiltHtml();
  await start();
  for (const route of [
    '/',
    '/posts',
    '/posts/public',
    '/projects',
    '/stats',
    '/api',
    '/admin/login',
    '/healthz',
    '/rss.xml',
    '/sitemap.xml',
    '/llms.txt',
    '/openapi.json',
  ]) {
    const r = await get(route);
    assert.equal(r.status, 200, route);
    const html = await r.text();
    assert(!html.includes('NEVER_EXPOSE_THIS'), route);
    if (r.headers.get('content-type')?.includes('text/html'))
      assertScriptPolicy(
        html,
        r.headers.get('content-security-policy') || '',
        route,
      );
  }
  for (const route of [
    '/posts/secret',
    '/api/v1/posts/secret',
    '/api/v1/posts/secret.md',
    '/api/v1/posts/secret.txt',
    '/.env',
    '/blog.db',
    '/src/lib/auth.ts',
    '/_astro/example.js.map',
  ])
    assert.equal((await get(route)).status, 404, route);
  for (const route of [
    '/admin',
    '/admin/edit',
    '/admin/inbox',
    '/%61dmin',
    '/admin%2fedit',
  ])
    assert.equal((await get(route)).status, 303, route);
  assert.equal((await get('/api/admin/export')).status, 401);
  assert.equal((await get('/%61pi/admin/export')).status, 401);
  assert.equal(
    (
      await get('/api/admin/post', {
        method: 'POST',
        headers: { origin: base },
        body: new URLSearchParams(),
      })
    ).status,
    401,
  );
  const badLoginBodies: {
    name: string;
    contentType?: string;
    body?: string;
    status: number;
  }[] = [
    {
      name: 'JSON',
      contentType: 'application/json',
      body: '{"password":"anything","code":"123456"}',
      status: 415,
    },
    { name: 'empty body', status: 400 },
    {
      name: 'empty form',
      contentType: 'application/x-www-form-urlencoded',
      body: '',
      status: 400,
    },
    {
      name: 'broken multipart',
      contentType: 'multipart/form-data; boundary=broken',
      body: '--broken\r\ninvalid-part',
      status: 400,
    },
    {
      name: 'missing boundary',
      contentType: 'multipart/form-data',
      body: 'malformed',
      status: 400,
    },
    {
      name: 'missing password',
      contentType: 'application/x-www-form-urlencoded',
      body: 'code=123456',
      status: 400,
    },
    {
      name: 'missing code',
      contentType: 'application/x-www-form-urlencoded',
      body: 'password=anything',
      status: 400,
    },
    {
      name: 'malformed form field',
      contentType: 'application/x-www-form-urlencoded',
      body: 'password=anything&code=%E0%A4%A',
      status: 400,
    },
    {
      name: 'duplicate code',
      contentType: 'application/x-www-form-urlencoded',
      body: 'password=anything&code=123456&code=123456',
      status: 400,
    },
  ];
  for (const requestOrigin of [base, undefined]) {
    for (const invalid of badLoginBodies) {
      // Isolate the persisted limiter for each class of invalid input in this disposable DB.
      db().prepare('DELETE FROM limits WHERE key=?').run('login:127.0.0.1');
      for (let attempt = 0; attempt < 6; attempt++) {
        const response = await get('/api/admin/login', {
          method: 'POST',
          headers: {
            ...(requestOrigin ? { origin: requestOrigin } : {}),
            ...(invalid.contentType
              ? { 'content-type': invalid.contentType }
              : {}),
          },
          body: invalid.body,
        });
        assert.equal(response.status, invalid.status, invalid.name);
        assert.equal(await response.text(), 'Unable to sign in', invalid.name);
      }
      const limited = await get('/api/admin/login', {
        method: 'POST',
        headers: { origin: base },
        body: new URLSearchParams({ password: 'wrong', code: '123456' }),
      });
      assert.equal(
        limited.status,
        429,
        invalid.name + ' must consume the login budget',
      );
      assert.equal(await limited.text(), 'Unable to sign in');
    }
  }
  db().prepare('DELETE FROM limits WHERE key=?').run('login:127.0.0.1');
  const login = await get('/api/admin/login', {
    method: 'POST',
    headers: { origin: base },
    body: new URLSearchParams({
      password: 'a sufficiently long password',
      code: totp(secret),
    }),
  });
  assert.equal(login.status, 303);
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  assert.match(login.headers.get('set-cookie')!, /HttpOnly/i);
  assert.match(login.headers.get('set-cookie')!, /SameSite=Lax/i);
  const adminHtml = await (
    await get('/admin/edit?id=' + published, { headers: { cookie } })
  ).text();
  const csrf = adminHtml.match(/name="csrf" value="([^"]+)"/)![1];
  assertScriptPolicy(
    adminHtml,
    (await get('/admin/edit', { headers: { cookie } })).headers.get(
      'content-security-policy',
    ) || '',
    'admin editor',
  );
  for (const route of [
    '/admin',
    '/admin/projects',
    '/admin/settings',
    '/admin/inbox',
    '/admin/tags',
  ]) {
    const response = await get(route, { headers: { cookie } });
    assert.equal(response.status, 200, route);
    assertScriptPolicy(
      await response.text(),
      response.headers.get('content-security-policy') || '',
      route,
    );
  }
  const maliciousTitle =
    '</script><script>window.compromised=true</script><p> & café';
  savePost({
    title: maliciousTitle,
    slug: 'structured-title',
    status: 'published',
  });
  const structuredResponse = await get('/posts/structured-title');
  const structuredHtml = await structuredResponse.text();
  assertScriptPolicy(
    structuredHtml,
    structuredResponse.headers.get('content-security-policy') || '',
    'article JSON-LD',
  );
  const jsonLd = structuredHtml.match(
    /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/,
  )![1];
  assert(!jsonLd.includes('<'));
  assert.equal(JSON.parse(jsonLd).headline, maliciousTitle);

  for (const action of [
    'post',
    'revision',
    'preview',
    'upload',
    'rename-tag',
    'settings',
    'project',
    'delete-project',
    'import',
    'manual-x',
    'convert',
    'logout',
  ]) {
    for (const invalid of [
      badLoginBodies[0],
      badLoginBodies[3],
      badLoginBodies[1],
    ]) {
      const response = await get('/api/admin/' + action, {
        method: 'POST',
        headers: {
          cookie,
          origin: base,
          ...(invalid.contentType
            ? { 'content-type': invalid.contentType }
            : {}),
        },
        body: invalid.body,
      });
      assert(
        response.status >= 400 && response.status < 500,
        action + ' ' + invalid.name,
      );
    }
  }
  const exportPost = await get('/api/admin/export', {
    method: 'POST',
    headers: { cookie, origin: base, 'content-type': 'application/json' },
    body: '{invalid',
  });
  assert(
    [404, 405].includes(exportPost.status),
    'content export remains read-only',
  );
  for (const route of [
    'posts',
    'posts/public',
    'posts/public.md',
    'posts/public.txt',
    'tags',
    'projects',
    'stats',
  ]) {
    const response = await get('/api/v1/' + route, {
      method: 'POST',
      headers: { origin: base, 'content-type': 'application/json' },
      body: '{malformed',
    });
    assert(
      [404, 405].includes(response.status),
      route + ' must remain read-only without a server error',
    );
  }
  const image = await sharp({
    create: { width: 8, height: 8, channels: 3, background: 'blue' },
  })
    .png()
    .toBuffer();
  const uploadForm = new FormData();
  uploadForm.set('csrf', csrf);
  uploadForm.set(
    'file',
    new Blob([new Uint8Array(image)], { type: 'image/png' }),
    'sample.png',
  );
  const uploaded = await get('/api/admin/upload', {
    method: 'POST',
    headers: { cookie, origin: base },
    body: uploadForm,
  });
  assert.equal(uploaded.status, 200);
  const { path: imagePath } = await uploaded.json();
  assert.match(imagePath, /^\/uploads\/[a-f0-9-]+\.webp$/);
  const served = await get(imagePath);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'image/webp');
  assert.equal(
    served.headers.get('cache-control'),
    'public, max-age=31536000, immutable',
  );
  assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(
    (await sharp(Buffer.from(await served.arrayBuffer())).metadata()).format,
    'webp',
  );
  // Preserve the raw target: fetch/browser URL parsing would erase ../ before sending it.
  for (const target of [
    '/uploads/../posts/public',
    '/uploads/%2e%2e/posts/public',
    '/uploads/%252e%252e%252fposts/public',
    '/%75ploads/../posts/public',
    '/uploads%2f..%2fposts%2fpublic',
    '/uploads/..\\posts/public',
    '/uploads/not-an-image.webp',
    '/uploads/abcd.png',
    '/uploads/abcd.webp',
    '/uploads/%zz',
  ]) {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = httpRequest(base, { path: target }, (response) => {
        response.resume();
        resolve(response.statusCode);
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 404, target);
  }
  if (process.env.BROWSER_SMOKE === 'true') {
    setSetting(
      'links',
      JSON.stringify([
        { label: 'Fixture outbound', url: 'https://example.invalid/outbound' },
      ]),
    );
    db()
      .prepare(
        'INSERT INTO projects(name,description,status,url) VALUES(?,?,?,?)',
      )
      .run(
        'Browser fixture',
        'Disposable browser project',
        'active',
        base + '/posts/public',
      );
    const { browserSmoke } = await import('./browser-smoke');
    await browserSmoke(base, cookie, published, image);
  }
  const { agentIntegration } = await import('./agent-integration');
  const agentTokens = await agentIntegration(
    base,
    cookie,
    async () => {
      await stop();
      await start();
    },
    () => logs,
  );
  const badCsrf = await get('/api/admin/post', {
    method: 'POST',
    headers: { cookie, origin: base },
    body: new URLSearchParams({ csrf: 'wrong' }),
  });
  assert.equal(badCsrf.status, 403);
  const save = await get('/api/admin/post', {
    method: 'POST',
    headers: { cookie, origin: base },
    body: new URLSearchParams({
      csrf,
      id: String(published),
      title: 'Edited in browser',
      slug: 'new-public',
      body: 'Updated body',
      type: 'article',
      status: 'published',
      tags: 'test',
    }),
  });
  assert.equal(save.status, 303);
  assert.equal((await get('/posts/public')).status, 301);
  assert.equal((await get('/posts/new-public')).status, 200);
  const exported = await get('/api/admin/export', { headers: { cookie } });
  assert.equal(exported.status, 200);
  const archive = unzipSync(new Uint8Array(await exported.arrayBuffer()));
  assert(strFromU8(archive['content.json']).includes('NEVER_EXPOSE_THIS'));
  const client = new Client({ name: 'integration-test', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(base + '/mcp')),
  );
  assert.equal((await client.listTools()).tools.length, 4);
  const search = await client.callTool({
    name: 'search_posts',
    arguments: { q: 'Updated' },
  });
  assert(!JSON.stringify(search).includes('NEVER_EXPOSE_THIS'));
  const hidden = await client.callTool({
    name: 'get_post',
    arguments: { slug: 'secret' },
  });
  assert.equal(hidden.isError, true);
  const full = await client.callTool({
    name: 'get_post',
    arguments: { slug: 'new-public' },
  });
  assert(JSON.stringify(full).includes('Updated body'));
  await client.close();
  setSetting(
    'analytics_cache',
    JSON.stringify({
      updated_at: '2025-01-01T00:00:00.000Z',
      updated_ms: 0,
      stats: { pageviews: { value: 4 } },
      pages: [
        { x: '/posts/new-public', y: 4 },
        { x: '/posts/secret', y: 999 },
      ],
    }),
  );
  const stats = await (await get('/api/v1/stats')).json();
  assert.equal(stats.updated_at, '2025-01-01T00:00:00.000Z');
  assert.equal(stats.popular.length, 1);
  assert(!JSON.stringify(stats).includes('999'));
  for (let i = 0; i < 7; i++) {
    const r = await get('/api/admin/login', {
      method: 'POST',
      headers: { origin: base, 'X-Forwarded-For': `198.51.100.${i}` },
      body: new URLSearchParams({ password: 'wrong', code: '000000' }),
    });
    if (i >= 5) assert.equal(r.status, 429);
  }
  for (let i = 0; i < 65; i++)
    await get('/api/v1/posts', {
      headers: { 'X-Forwarded-For': `198.51.100.${i}` },
    });
  assert.equal((await get('/api/v1/posts')).status, 429);
  assert.equal((await get('/mcp', { method: 'POST' })).status, 429);
  assert.equal((await get('/healthz')).status, 200);
  await stop();
  await start();
  assert.equal((await get('/posts/new-public')).status, 200);
  assert.equal(getDraft(published).body, 'Updated body');
  await stop();
  const run = async (
    args: string[],
    env: Record<string, string | undefined> = process.env,
  ) => {
    const p = spawn(process.execPath, ['--import', 'tsx', ...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let text = '';
    p.stdout.on('data', (b) => (text += b));
    p.stderr.on('data', (b) => (text += b));
    await new Promise<void>((resolve, reject) =>
      p.on('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(text)),
      ),
    );
    return text;
  };
  const dumpOutput = await run(['bin/storage.ts', 'backup']);
  const dump = dumpOutput
    .split('\n')
    .find((s) => s.startsWith(root + '/backups/'))!;
  assert(dump);
  await run(['bin/storage.ts', 'restore', dump, root + '/restored']);
  const { DatabaseSync } = await import('node:sqlite');
  const restored = new DatabaseSync(root + '/restored/data/blog.db');
  assert.equal(
    (
      restored
        .prepare('SELECT body FROM posts WHERE id=?')
        .get(published) as any
    ).body,
    'Updated body',
  );
  restored.close();
  for (const token of agentTokens) {
    assert(!logs.includes(token));
    assert(
      !JSON.stringify(
        db().prepare('SELECT * FROM agent_tokens').all(),
      ).includes(token),
    );
    for (const file of [
      root + '/data/blog.db',
      root + '/data/blog.db-wal',
      dump + '/blog.db',
      root + '/restored/data/blog.db',
    ]) {
      assert(!readFileSync(file).includes(Buffer.from(token)), file);
    }
  }
  assert(readFileSync(root + '/restored/data/blog.db').length > 0);
  console.log(
    'Integration passed: routes, editorial actions, auth/CSRF, exports, SDK MCP client, privacy, analytics outage, spoof resistance, restart, backup and restore.',
  );
} finally {
  await stop();
  db().close();
  rmSync(root, { recursive: true, force: true });
}
