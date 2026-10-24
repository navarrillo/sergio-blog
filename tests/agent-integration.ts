import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { db } from '../src/lib/db';
import { savePost, getDraft } from '../src/lib/content';
import {
  createAgentToken,
  agentTokenHash,
  listAgentTokens,
  revokeAgentToken,
} from '../src/lib/auth';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { unzipSync, strFromU8 } from 'fflate';

export async function agentIntegration(
  base: string,
  cookie: string,
  restart: () => Promise<void>,
  logs: () => string,
) {
  const a = createAgentToken('Writer A');
  const b = createAgentToken('Writer B');
  const tokens = [a.token, b.token];
  const request = (route: string, init: RequestInit = {}) =>
    fetch(base + route, { redirect: 'manual', ...init });
  const api = (route = '', method = 'GET', body?: unknown, token = a.token) =>
    request('/api/agent/v1/drafts' + route, {
      method,
      headers: {
        authorization: 'Bearer ' + token,
        'content-type': 'application/json',
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  const reset = () =>
    db().prepare("DELETE FROM limits WHERE key LIKE 'agent-%'").run();
  const input = {
    title: 'Agent café draft',
    summary: 'Private summary',
    body: 'AGENT_PRIVATE_MARKDOWN',
    tags: ['agent-private'],
    type: 'article',
  };
  const created = await api('', 'POST', input);
  assert.equal(created.status, 201);
  const draft = await created.json();
  assert.deepEqual(
    Object.keys(draft).sort(),
    ['id', 'slug', 'status', 'preview_url', 'updated_at'].sort(),
  );
  assert.equal(draft.status, 'draft');
  assert.equal(draft.slug, 'agent-cafe-draft');
  assert.equal(draft.preview_url, '/admin/edit?id=' + draft.id);
  const row = db()
    .prepare('SELECT * FROM agent_tokens WHERE id=?')
    .get(a.id) as any;
  assert.equal(row.token_hash, agentTokenHash(a.token));
  assert.match(row.token_hash, /^[a-f0-9]{64}$/);
  assert.equal(getDraft(draft.id).created_by_token_id, a.id);
  assert(row.last_used_at);
  assert(!JSON.stringify(listAgentTokens()).includes(row.token_hash));
  for (const route of [
    '/',
    '/posts',
    '/rss.xml',
    '/sitemap.xml',
    '/api/v1/posts',
    '/api/v1/posts?tag=agent-private',
    '/llms.txt',
    '/openapi.json',
  ]) {
    const response = await request(route);
    assert.equal(response.status, 200, route);
    const text = await response.text();
    assert(!text.includes(input.body), route);
    assert(!text.includes(draft.slug), route);
    if (route === '/llms.txt' || route === '/openapi.json')
      assert(!text.includes('/api/agent'), route);
  }
  for (const route of ['/posts/', '/api/v1/posts/']) {
    for (const extension of ['', '.md', '.txt'])
      assert.equal((await request(route + draft.slug + extension)).status, 404);
  }
  const mcp = new Client({ name: 'agent-privacy-test', version: '1.0.0' });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp')));
  assert.equal(
    (await mcp.callTool({ name: 'get_post', arguments: { slug: draft.slug } }))
      .isError,
    true,
  );
  assert(
    !JSON.stringify(
      await mcp.callTool({
        name: 'search_posts',
        arguments: { q: 'AGENT_PRIVATE_MARKDOWN' },
      }),
    ).includes(input.body),
  );
  assert.equal((await mcp.listTools()).tools.length, 4);
  await mcp.close();
  for (const route of ['/admin', draft.preview_url]) {
    const html = await (await request(route, { headers: { cookie } })).text();
    assert(html.includes('Created by Writer A'), route);
    assert(html.includes(input.title), route);
  }
  const duplicate = await (await api('', 'POST', input)).json();
  assert.equal(duplicate.slug, draft.slug + '-2');
  assert.equal(
    (await api('', 'POST', { title: 'Reserved', slug: draft.slug })).status,
    201,
  );
  assert.equal((await api('', 'POST', { title: '中文' })).status, 201);

  const longSlug = 'a'.repeat(180);
  const long = await (
    await api('', 'POST', { title: 'Long slug', slug: longSlug })
  ).json();
  assert.equal(long.slug, longSlug);
  const longCollision = await (
    await api('', 'POST', { title: 'Long slug collision', slug: longSlug })
  ).json();
  assert.equal(longCollision.slug, 'a'.repeat(178) + '-2');
  assert.equal(
    (await (await api('/' + long.id, 'PATCH', { body: 'Keep URL' })).json())
      .slug,
    longSlug,
  );
  const boundary = await api('', 'POST', {
    title: 't'.repeat(200),
    summary: 's'.repeat(500),
    body: 'é'.repeat(100000),
    tags: Array(10).fill('a'.repeat(40)),
    type: 'note',
  });
  assert.equal(boundary.status, 201);
  assert.equal((await api('', 'POST')).status, 400);
  for (const key of [
    'status',
    'published_at',
    'featured',
    'image',
    'source_url',
    'unknown',
    'created_by_token_id',
    'agent_access_revoked_at',
  ]) {
    for (const method of ['POST', 'PATCH']) {
      reset();
      assert.equal(
        (
          await api(method === 'PATCH' ? '/' + draft.id : '', method, {
            ...input,
            [key]: 'published',
          })
        ).status,
        400,
        key + method,
      );
    }
  }
  for (const invalid of [
    null,
    [],
    {},
    { title: '' },
    { title: 'x'.repeat(201) },
    { title: 'ok', summary: 'x'.repeat(501) },
    { title: 'ok', body: 'x'.repeat(200001) },
    { title: 'ok', body: 'é'.repeat(100001) },
    { title: 'ok', tags: Array(11).fill('x') },
    { title: 'ok', tags: ['x'.repeat(41)] },
    { title: 'ok', type: 'x_post' },
    { title: 'ok', slug: '../outside' },
  ]) {
    reset();
    assert.equal(
      (await api('', 'POST', invalid)).status,
      400,
      JSON.stringify(invalid)?.slice(0, 80),
    );
  }
  assert.equal((await api('/' + draft.id, 'PATCH', {})).status, 400);
  const headers = {
    authorization: 'Bearer ' + a.token,
    'content-type': 'application/json',
  };
  for (const invalid of ['{', '', 'null', '"body"'])
    assert.equal(
      (
        await request('/api/agent/v1/drafts', {
          method: 'POST',
          headers,
          body: invalid,
        })
      ).status,
      400,
    );
  assert.equal(
    (
      await request('/api/agent/v1/drafts', {
        method: 'POST',
        headers: { ...headers, 'content-type': 'text/plain' },
        body: '{}',
      })
    ).status,
    415,
  );
  assert.equal(
    (
      await request('/api/agent/v1/drafts', {
        method: 'POST',
        headers,
        body: 'x'.repeat(1250001),
      })
    ).status,
    413,
  );
  // Actual stream without Content-Length exercises the byte cap independently of that header.
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('x'.repeat(1250001)));
      controller.close();
    },
  });
  assert.equal(
    (
      await request('/api/agent/v1/drafts', {
        method: 'POST',
        headers,
        body: stream,
        duplex: 'half',
      } as RequestInit)
    ).status,
    413,
  );
  reset();
  for (const auth of [
    undefined,
    'Bearer wrong',
    'Bearer sbd_short',
    'Basic anything',
    'Bearer ' + a.token + ' extra',
    'Bearer sbd_' + 'a'.repeat(43),
  ]) {
    const r = await request('/api/agent/v1/drafts', {
      method: 'POST',
      headers: { ...(auth ? { authorization: auth } : {}), cookie },
    });
    assert.equal(r.status, 401);
    assert.deepEqual(await r.json(), { error: 'Unauthorized' });
  }
  assert.equal((await request('/admin', { headers })).status, 303);
  for (const route of ['/api/admin/export', '/api/admin/post'])
    assert.equal(
      (
        await request(route, {
          method: route.endsWith('post') ? 'POST' : 'GET',
          headers,
        })
      ).status,
      401,
    );
  for (const path of [
    '/api/agent/v1/uploads',
    '/api/agent/v1/publish',
    '/api/agent/v1/settings',
    '/api/agent/v1/projects',
  ])
    assert.equal(
      (await request(path, { method: 'POST', headers, body: '{}' })).status,
      404,
    );
  for (const method of ['DELETE', 'PUT', 'POST'])
    assert.equal((await api('/' + draft.id, method)).status, 404);

  const foreign = await (
    await api('', 'POST', { title: 'B private' }, b.token)
  ).json();
  const adminId = savePost({ title: 'Admin draft', slug: 'admin-owned-draft' });
  for (const id of [foreign.id, adminId, 999999]) {
    assert.equal((await api('/' + id)).status, 404);
    assert.equal(
      (await api('/' + id, 'PATCH', { title: 'Stolen' })).status,
      404,
    );
  }
  const { agentReading } = await import('./agent-reading');
  tokens.push(await agentReading(base, foreign.id, adminId));
  const count = () =>
    Number(
      (
        db()
          .prepare('SELECT count(*) AS count FROM revisions WHERE post_id=?')
          .get(draft.id) as any
      ).count,
    );
  const before = count();
  const updated = await api('/' + draft.id, 'PATCH', {
    title: 'Updated title',
    body: 'AGENT_REVISED_MARKDOWN',
  });
  assert.equal(updated.status, 200);
  assert.deepEqual(
    Object.keys(await updated.json()).sort(),
    Object.keys(draft).sort(),
  );
  assert.equal(count(), before + 1);
  assert.equal(
    (await (await api('/' + draft.id)).json()).body,
    'AGENT_REVISED_MARKDOWN',
  );
  assert.equal(getDraft(draft.id).summary, input.summary);
  assert.equal(getDraft(draft.id).status, 'draft');
  assert.equal(
    JSON.parse(
      (
        db()
          .prepare(
            'SELECT snapshot FROM revisions WHERE post_id=? ORDER BY id DESC LIMIT 1',
          )
          .get(draft.id) as any
      ).snapshot,
    ).body,
    input.body,
  );
  // Real admin publishing still requires the existing cookie + CSRF flow.
  const html = await (
    await request(draft.preview_url, { headers: { cookie } })
  ).text();
  const csrf = html.match(/name="csrf" value="([^"]+)"/)![1];
  const publish = await request('/api/admin/post', {
    method: 'POST',
    headers: { cookie, origin: base },
    body: new URLSearchParams({
      csrf,
      id: String(draft.id),
      title: 'Human approved',
      slug: draft.slug,
      body: 'Human approved text',
      type: 'article',
      status: 'published',
      tags: '',
    }),
  });
  assert.equal(publish.status, 303);
  assert.equal(getDraft(draft.id).status, 'published');
  assert(
    !(await (await api('?limit=50')).json()).items.some(
      (p: any) => p.id === draft.id,
    ),
  );
  assert.equal((await api('/' + draft.id)).status, 404);
  assert.equal(
    (await api('/' + draft.id, 'PATCH', { title: 'Take back' })).status,
    404,
  );
  const publicPost = await (
    await request('/api/v1/posts/' + draft.slug)
  ).json();
  assert.equal(publicPost.title, 'Human approved');
  assert(!('created_by_token_id' in publicPost));
  assert(!('agent_access_revoked_at' in publicPost));
  // Status trigger also covers a previous-release writer after rollback.
  db().prepare("UPDATE posts SET status='draft' WHERE id=?").run(draft.id);
  assert.equal((await api('/' + draft.id)).status, 404);
  reset();
  db().prepare("UPDATE posts SET status='trash' WHERE id=?").run(foreign.id);
  assert.equal(
    (await api('/' + foreign.id, 'GET', undefined, b.token)).status,
    404,
  );
  assert.equal(
    (await api('/' + foreign.id, 'PATCH', { title: 'Restore' }, b.token))
      .status,
    404,
  );
  assert(getDraft(foreign.id).agent_access_revoked_at);

  const { agentBudgets } = await import('./agent-budgets');
  const { rate, limitedDraft, other } = await agentBudgets(base, restart);
  tokens.push(rate.token, other.token);
  reset();
  for (let i = 0; i < 21; i++) {
    const r = await request('/api/agent/v1/drafts', {
      headers: {
        authorization: 'Bearer invalid',
        'X-Forwarded-For': '198.51.100.' + i,
      },
    });
    assert.equal(r.status, i < 20 ? 401 : 429);
  }
  assert.equal(
    (
      db()
        .prepare(
          "SELECT count(*) AS count FROM limits WHERE key LIKE 'agent-auth:%'",
        )
        .get() as any
    ).count,
    1,
  );
  assert(
    db()
      .prepare("SELECT key FROM limits WHERE key='agent-auth:127.0.0.1'")
      .get(),
  );
  assert(!logs().includes('blog-agent-auth-failed ip=198.51.100.'));
  assert(logs().includes('blog-agent-auth-failed ip=127.0.0.1'));
  // A valid token still works when its peer has exhausted failed-auth attempts.
  assert.equal(
    (await api('/' + limitedDraft.id, 'GET', undefined, rate.token)).status,
    200,
  );
  reset();
  assert(revokeAgentToken(String(rate.id)));
  assert.equal(
    (await api('/' + limitedDraft.id, 'GET', undefined, rate.token)).status,
    401,
  );
  assert.equal(
    (
      await api(
        '/' + limitedDraft.id,
        'PATCH',
        { title: 'Revoked' },
        rate.token,
      )
    ).status,
    401,
  );
  assert(revokeAgentToken('Writer B'));
  assert.equal(
    (await api('', 'POST', { title: 'Revoked B' }, b.token)).status,
    401,
  );
  // CLI refuses non-TTY creation before inserting anything; list never returns hashes.
  for (const command of [['create', 'Non interactive'], ['list']]) {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'bin/admin.ts', 'agent-token', ...command],
      { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    child.stdout.on('data', (b) => (output += b));
    child.stderr.on('data', (b) => (output += b));
    const exit = await new Promise<number | null>((resolve) =>
      child.on('exit', resolve),
    );
    assert.equal(exit, command[0] === 'create' ? 1 : 0);
    assert(!output.includes(row.token_hash));
    assert(!output.includes(a.token));
  }
  assert(
    !db()
      .prepare("SELECT id FROM agent_tokens WHERE name='Non interactive'")
      .get(),
  );
  // Exercise successful creation behind a real pseudo-TTY without persisting or printing its output.
  const ttyArgs =
    process.platform === 'darwin'
      ? [
          '-q',
          '/dev/null',
          process.execPath,
          '--import',
          'tsx',
          'bin/admin.ts',
          'agent-token',
          'create',
          'tty-writer',
        ]
      : [
          '-q',
          '-e',
          '-c',
          'node --import tsx bin/admin.ts agent-token create tty-writer',
          '/dev/null',
        ];
  const tty = spawn('script', ttyArgs, {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let ttyOutput = '';
  tty.stdout.on('data', (b) => (ttyOutput += b));
  tty.stderr.on('data', (b) => (ttyOutput += b));
  const ttyExit = await new Promise<number | null>((resolve) =>
    tty.on('exit', resolve),
  );
  assert.equal(ttyExit, 0, 'TTY creation must succeed');
  const ttyTokens = ttyOutput.match(/sbd_[A-Za-z0-9_-]{43}/g) || [];
  assert(ttyTokens.length === 1, 'TTY must show the token exactly once');
  const ttyToken = ttyTokens[0];
  tokens.push(ttyToken);
  assert.equal(
    (await api('', 'POST', { title: 'TTY-created credential' }, ttyToken))
      .status,
    201,
  );
  const revoker = spawn(
    process.execPath,
    ['--import', 'tsx', 'bin/admin.ts', 'agent-token', 'revoke', 'tty-writer'],
    { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  assert.equal(
    await new Promise<number | null>((resolve) => revoker.on('exit', resolve)),
    0,
  );
  assert.equal(
    (await api('', 'POST', { title: 'Revoked through CLI' }, ttyToken)).status,
    401,
  );
  const exported = await request('/api/admin/export', { headers: { cookie } });
  const zip = unzipSync(new Uint8Array(await exported.arrayBuffer()));
  const exportText = strFromU8(zip['content.json']);
  for (const token of tokens) assert(!exportText.includes(token));
  assert(!exportText.includes(row.token_hash));
  assert(
    logs().includes(
      'blog-agent-call {"token":"Writer A","method":"POST","path":"/api/agent/v1/drafts","draft_id":',
    ),
  );
  assert(!logs().includes(input.body));
  for (const token of tokens) assert(!logs().includes(token));
  // Feature flag is evaluated for the entire namespace, irrespective of method/path/auth.
  process.env.AGENT_API_ENABLED = 'false';
  await restart();
  for (const path of [
    '/api/agent',
    '/api/agent/',
    '/api/agent/v1/drafts',
    '/api/agent/v1/drafts?limit=50',
    '/api/agent/v1/drafts/' + draft.id,
    '/api/agent/v2/anything',
    '/%61pi/agent/v1/drafts',
  ])
    for (const method of ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'])
      assert.equal(
        (await request(path, { method, headers })).status,
        404,
        method + path,
      );
  process.env.AGENT_API_ENABLED = 'true';
  await restart();
  reset();
  console.log(
    'Agent integration passed: draft isolation, revisions, strict inputs, bearer/cookie separation, revocation, persistent per-token budgets, spoof resistance, CLI and secret hygiene.',
  );
  return tokens;
}
