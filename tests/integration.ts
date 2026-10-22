import assert from 'node:assert/strict';
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
    assert(!(await r.text()).includes('NEVER_EXPOSE_THIS'), route);
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
  assert(readFileSync(root + '/restored/data/blog.db').length > 0);
  console.log(
    'Integration passed: routes, editorial actions, auth/CSRF, exports, SDK MCP client, privacy, analytics outage, spoof resistance, restart, backup and restore.',
  );
} finally {
  await stop();
  db().close();
  rmSync(root, { recursive: true, force: true });
}
