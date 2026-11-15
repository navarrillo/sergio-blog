import { test, expect, beforeEach, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import argon2 from 'argon2';
import { SoftPasskey } from './soft-passkey';

const root = mkdtempSync(path.join(tmpdir(), 'blog-passkeys-'));
const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const PASSWORD = 'a sufficiently long password';
const ORIGIN = 'https://blog.example.test';
const RP_ID = 'blog.example.test';
Object.assign(process.env, {
  DATA_DIR: root + '/data',
  UPLOADS_DIR: root + '/uploads',
  BACKUPS_DIR: root + '/backups',
  COOKIE_SECURE: 'false',
  PUBLIC_ORIGIN: ORIGIN,
});
delete process.env.WEBAUTHN_REAUTH_SECONDS;
const { migrate, db } = await import('../src/lib/db');
const { login, totp, session, cookieName, isPublicAdminPath } =
  await import('../src/lib/auth');
const { CHALLENGE_TTL_MS } = await import('../src/lib/passkeys');
const { POST: authOptionsRoute } =
  await import('../src/pages/api/admin/login/passkey/options');
const { POST: authRoute } =
  await import('../src/pages/api/admin/login/passkey');
const { GET: listRoute, POST: registerRoute } =
  await import('../src/pages/api/admin/passkeys/index');
const { POST: registerOptionsRoute } =
  await import('../src/pages/api/admin/passkeys/options');
const { PATCH: renameRoute, DELETE: deleteRoute } =
  await import('../src/pages/api/admin/passkeys/[id]');
const { POST: passwordRoute } = await import('../src/pages/api/admin/[action]');
const hash = await argon2.hash(PASSWORD);
await migrate();
db()
  .prepare('INSERT INTO admin(id,password_hash,totp_secret) VALUES(1,?,?)')
  .run(hash, SECRET);
afterAll(() => {
  db().close();
  rmSync(root, { recursive: true, force: true });
});
beforeEach(() => {
  delete process.env.WEBAUTHN_REAUTH_SECONDS;
  db().exec(
    'DELETE FROM sessions; DELETE FROM passkeys; DELETE FROM webauthn_challenges; DELETE FROM limits',
  );
  db()
    .prepare('UPDATE admin SET last_totp=0, password_hash=?, totp_secret=?')
    .run(hash, SECRET);
});

function http(
  pathname: string,
  body?: unknown,
  headers: Record<string, string> = {},
  origin: string | null = ORIGIN,
) {
  return new Request(ORIGIN + pathname, {
    method: 'POST',
    headers: {
      ...(origin ? { origin } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function call(handler: any, request: Request, extras: any = {}) {
  const jar: { name: string; value: string; options: any }[] = [];
  const response: Response = await handler({
    request,
    params: extras.params || {},
    locals: {
      ip: extras.ip || '192.0.2.10',
      session: extras.session ?? null,
      scriptHashes: [],
    },
    cookies: {
      set(name: string, value: string, options: any) {
        jar.push({ name, value, options });
      },
      delete() {},
    },
    redirect: (location: string, status = 302) =>
      new Response(null, { status, headers: { location } }),
  });
  return { response, jar };
}
async function signInWithTotp() {
  db().prepare('UPDATE admin SET last_totp=0').run();
  const token = await login(PASSWORD, totp(SECRET));
  expect(token).toBeTruthy();
  const row = session(
    new Request(ORIGIN + '/admin', {
      headers: { cookie: cookieName() + '=' + token },
    }),
  );
  expect(row?.authenticated_at).toBeGreaterThan(0);
  return { token: token!, row: row! };
}
function challenges() {
  return db().prepare('SELECT * FROM webauthn_challenges').all() as any[];
}
function signCount(id: string) {
  return (
    db()
      .prepare('SELECT sign_count FROM passkeys WHERE credential_id=?')
      .get(id) as { sign_count: number } | undefined
  )?.sign_count;
}
async function register(row: any, name = 'Laptop', soft = new SoftPasskey()) {
  const started = await call(
    registerOptionsRoute,
    http('/api/admin/passkeys/options', undefined, { 'x-csrf': row.csrf }),
    { session: row },
  );
  expect(started.response.status).toBe(200);
  const options = await started.response.json();
  const credential = soft.register(options, ORIGIN);
  const saved = await call(
    registerRoute,
    http('/api/admin/passkeys', { name, credential }, { 'x-csrf': row.csrf }),
    { session: row },
  );
  expect(saved.response.status, await saved.response.clone().text()).toBe(200);
  return { soft, options, saved: await saved.response.json() };
}
async function loginOptions(ip = '192.0.2.10') {
  const started = await call(
    authOptionsRoute,
    http('/api/admin/login/passkey/options'),
    {
      ip,
    },
  );
  expect(started.response.status).toBe(200);
  return started.response.json();
}
async function passkeyLogin(assertion: unknown, ip = '192.0.2.10') {
  return call(authRoute, http('/api/admin/login/passkey', assertion), { ip });
}

test('public passkey routes are only the two login posts', () => {
  expect(isPublicAdminPath('/admin/login', 'GET')).toBe(true);
  expect(isPublicAdminPath('/api/admin/login', 'POST')).toBe(true);
  expect(isPublicAdminPath('/api/admin/login/passkey/options', 'POST')).toBe(
    true,
  );
  expect(isPublicAdminPath('/api/admin/login/passkey', 'POST')).toBe(true);
  expect(isPublicAdminPath('/api/admin/login/passkey/options', 'GET')).toBe(
    false,
  );
  expect(isPublicAdminPath('/api/admin/passkeys', 'POST')).toBe(false);
  expect(isPublicAdminPath('/api/admin/passkeys/options', 'POST')).toBe(false);
});
test('register, rename, delete, and sign in without a username', async () => {
  const { row } = await signInWithTotp();
  const started = await call(
    registerOptionsRoute,
    http('/api/admin/passkeys/options', undefined, { 'x-csrf': row.csrf }),
    { session: row },
  );
  const options = await started.response.json();
  expect(options.rp).toEqual({ name: 'Sergio Blog', id: RP_ID });
  expect(options.rp.id).not.toBe('example.test');
  expect(options.authenticatorSelection).toMatchObject({
    residentKey: 'required',
    authenticatorAttachment: 'platform',
    userVerification: 'required',
    requireResidentKey: true,
  });
  expect(options.hints).toEqual(['client-device']);
  expect(options.timeout).toBe(CHALLENGE_TTL_MS);
  expect(options.user.name).toBe('admin');
  expect(Buffer.from(options.user.id, 'base64url').toString()).not.toBe(
    'admin',
  );
  expect(JSON.stringify(challenges())).not.toContain(options.challenge);
  expect(challenges()[0]).toMatchObject({
    kind: 'registration',
    ip: '192.0.2.10',
    session_token: row.token,
  });
  const soft = new SoftPasskey();
  const saved = await call(
    registerRoute,
    http(
      '/api/admin/passkeys',
      { name: '  Laptop  ', credential: soft.register(options, ORIGIN) },
      { 'x-csrf': row.csrf },
    ),
    { session: row },
  );
  expect(saved.response.status, await saved.response.clone().text()).toBe(200);
  const savedText = JSON.stringify(await saved.response.json());
  expect(savedText).not.toContain('public_key');
  expect(savedText).not.toContain(SECRET);
  const listed = await call(
    listRoute,
    new Request(ORIGIN + '/api/admin/passkeys'),
    {
      session: row,
    },
  );
  const body = await listed.response.json();
  expect(body.can_register).toBe(true);
  expect(body.passkeys).toHaveLength(1);
  expect(Object.keys(body.passkeys[0]).sort()).toEqual([
    'created_at',
    'id',
    'last_used_at',
    'name',
  ]);
  expect(body.passkeys[0].name).toBe('Laptop');
  expect(body.passkeys[0].last_used_at).toBeNull();
  const renamed = await call(
    renameRoute,
    http(
      '/api/admin/passkeys/' + body.passkeys[0].id,
      { name: 'Desk' },
      { 'x-csrf': row.csrf },
    ),
    { session: row, params: { id: String(body.passkeys[0].id) } },
  );
  expect(renamed.response.status).toBe(200);
  expect((await renamed.response.json()).name).toBe('Desk');
  db().exec('DELETE FROM sessions');
  const ceremony = await loginOptions();
  expect(ceremony.rpId).toBe(RP_ID);
  expect(ceremony.userVerification).toBe('required');
  expect(ceremony.hints).toEqual(['client-device']);
  expect(ceremony.allowCredentials).toBeUndefined();
  expect(ceremony.username).toBeUndefined();
  const loggedIn = await passkeyLogin(soft.authenticate(ceremony, ORIGIN));
  expect(loggedIn.response.status).toBe(200);
  expect(loggedIn.jar[0]).toMatchObject({
    name: 'blog_dev_session',
    options: {
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      path: '/',
      maxAge: 43200,
    },
  });
  const passkeySession = session(
    new Request(ORIGIN + '/admin', {
      headers: { cookie: cookieName() + '=' + loggedIn.jar[0].value },
    }),
  );
  expect(passkeySession?.csrf).toBeTruthy();
  const after = await call(
    listRoute,
    new Request(ORIGIN + '/api/admin/passkeys'),
    {
      session: passkeySession,
    },
  );
  const listedAfter = await after.response.json();
  expect(listedAfter.passkeys[0].last_used_at).toBeTruthy();
  expect(signCount(soft.credentialId.toString('base64url'))).toBe(1);
  db().prepare('UPDATE admin SET last_totp=0').run();
  expect(await login(PASSWORD, totp(SECRET))).toBeTruthy();
  expect(
    (db().prepare('SELECT password_hash, totp_secret FROM admin').get() as any)
      .totp_secret,
  ).toBe(SECRET);
  const fresh = await signInWithTotp();
  const id = (
    await (
      await call(listRoute, new Request(ORIGIN + '/api/admin/passkeys'), {
        session: fresh.row,
      })
    ).response.json()
  ).passkeys[0].id;
  const removed = await call(
    deleteRoute,
    new Request(ORIGIN + '/api/admin/passkeys/' + id, {
      method: 'DELETE',
      headers: { origin: ORIGIN, 'x-csrf': fresh.row.csrf },
    }),
    { session: fresh.row, params: { id: String(id) } },
  );
  expect(removed.response.status).toBe(200);
  expect(
    (
      await (
        await call(listRoute, new Request(ORIGIN + '/api/admin/passkeys'), {
          session: fresh.row,
        })
      ).response.json()
    ).passkeys,
  ).toEqual([]);
  const refused = await passkeyLogin(
    soft.authenticate(await loginOptions(), ORIGIN),
  );
  expect(refused.response.status).toBe(401);
  expect(await refused.response.json()).toEqual({ error: 'Unable to sign in' });
  expect(refused.jar).toEqual([]);
});
test('a reused challenge cannot open a second session', async () => {
  const { row } = await signInWithTotp();
  const { soft } = await register(row);
  db().exec('DELETE FROM sessions');
  const options = await loginOptions();
  const assertion = soft.authenticate(options, ORIGIN);
  expect((await passkeyLogin(assertion)).response.status).toBe(200);
  db().exec('DELETE FROM sessions');
  const again = await passkeyLogin(assertion);
  expect(again.response.status).toBe(401);
  expect(await again.response.json()).toEqual({ error: 'Unable to sign in' });
  expect(again.jar).toEqual([]);
  expect(
    (db().prepare('SELECT count(*) AS count FROM sessions').get() as any).count,
  ).toBe(0);
  expect(challenges()).toEqual([]);
  expect(signCount(soft.credentialId.toString('base64url'))).toBe(1);
});
test('an expired challenge is rejected', async () => {
  const { row } = await signInWithTotp();
  const { soft } = await register(row);
  db().exec('DELETE FROM sessions');
  const options = await loginOptions();
  const assertion = soft.authenticate(options, ORIGIN);
  db()
    .prepare('UPDATE webauthn_challenges SET expires=?')
    .run(Date.now() - 1);
  const response = await passkeyLogin(assertion);
  expect(response.response.status).toBe(401);
  expect(await response.response.json()).toEqual({
    error: 'Unable to sign in',
  });
  expect(signCount(soft.credentialId.toString('base64url'))).toBe(0);
});
test('wrong origin and wrong RP ID are the same generic failure', async () => {
  const { row } = await signInWithTotp();
  const { soft } = await register(row);
  db().exec('DELETE FROM sessions');
  const id = soft.credentialId.toString('base64url');
  const options = await loginOptions();
  const wrongOrigin = await passkeyLogin(
    soft.authenticate(options, 'https://evil.example'),
  );
  expect(wrongOrigin.response.status).toBe(401);
  expect(await wrongOrigin.response.json()).toEqual({
    error: 'Unable to sign in',
  });
  expect(signCount(id)).toBe(0);
  const again = await loginOptions();
  const wrongRp = await passkeyLogin(
    soft.authenticate(again, ORIGIN, { rpId: 'example.test' }),
  );
  expect(wrongRp.response.status).toBe(401);
  expect(await wrongRp.response.json()).toEqual({ error: 'Unable to sign in' });
  expect(signCount(id)).toBe(0);
  expect(
    (await passkeyLogin(soft.authenticate(await loginOptions(), ORIGIN)))
      .response.status,
  ).toBe(200);
});
test('registration requires a recent TOTP or passkey sign-in', async () => {
  expect(
    (await call(registerOptionsRoute, http('/api/admin/passkeys/options')))
      .response.status,
  ).toBe(401);
  const { row } = await signInWithTotp();
  db()
    .prepare('UPDATE sessions SET authenticated_at=? WHERE token=?')
    .run(Date.now() - 301_000, row.token);
  const staleRow = { ...row, authenticated_at: Date.now() - 301_000 };
  const stale = await call(
    registerOptionsRoute,
    http('/api/admin/passkeys/options', undefined, { 'x-csrf': row.csrf }),
    { session: staleRow },
  );
  expect(stale.response.status).toBe(403);
  expect(await stale.response.json()).toEqual({
    error: 'Sign in again to add a passkey.',
  });
  expect(challenges()).toEqual([]);
  process.env.WEBAUTHN_REAUTH_SECONDS = '120';
  const older = { ...row, authenticated_at: Date.now() - 130_000 };
  expect(
    (
      await call(
        registerOptionsRoute,
        http('/api/admin/passkeys/options', undefined, { 'x-csrf': row.csrf }),
        { session: older },
      )
    ).response.status,
  ).toBe(403);
  const recent = { ...row, authenticated_at: Date.now() - 100_000 };
  expect(
    (
      await call(
        registerOptionsRoute,
        http('/api/admin/passkeys/options', undefined, { 'x-csrf': row.csrf }),
        { session: recent },
      )
    ).response.status,
  ).toBe(200);
  delete process.env.WEBAUTHN_REAUTH_SECONDS;
  db().exec('DELETE FROM sessions; DELETE FROM webauthn_challenges');
  const { soft } = await register(recent);
  db().exec('DELETE FROM sessions');
  const loggedIn = await passkeyLogin(
    soft.authenticate(await loginOptions(), ORIGIN),
  );
  expect(loggedIn.response.status).toBe(200);
  const passkeySession = session(
    new Request(ORIGIN + '/admin', {
      headers: { cookie: cookieName() + '=' + loggedIn.jar[0].value },
    }),
  );
  expect(
    (
      await call(listRoute, new Request(ORIGIN + '/api/admin/passkeys'), {
        session: passkeySession,
      })
    ).response.status,
  ).toBe(200);
  expect(
    (
      await call(
        registerOptionsRoute,
        http('/api/admin/passkeys/options', undefined, {
          'x-csrf': passkeySession!.csrf,
        }),
        { session: passkeySession },
      )
    ).response.status,
  ).toBe(200);
});
test('passkey failures share the login rate limit and stay generic', async () => {
  const ip = '192.0.2.77';
  const bogus = {
    id: 'aaaa',
    rawId: 'aaaa',
    type: 'public-key',
    clientExtensionResults: {},
    response: {
      clientDataJSON: 'e30',
      authenticatorData: 'aaaa',
      signature: 'aaaa',
    },
  };
  for (let attempt = 0; attempt < 6; attempt++) {
    const failed = await passkeyLogin(bogus, ip);
    expect(failed.response.status).toBe(401);
    expect(await failed.response.json()).toEqual({
      error: 'Unable to sign in',
    });
  }
  const limited = await passkeyLogin(bogus, ip);
  expect(limited.response.status).toBe(429);
  expect(limited.response.headers.get('retry-after')).toBe('600');
  expect(await limited.response.json()).toEqual({ error: 'Unable to sign in' });
  const password = await call(
    passwordRoute,
    new Request(ORIGIN + '/api/admin/login', {
      method: 'POST',
      headers: {
        origin: ORIGIN,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ password: PASSWORD, code: totp(SECRET) }),
    }),
    { ip, params: { action: 'login' } },
  );
  expect(password.response.status).toBe(429);
  expect(await password.response.text()).toBe('Unable to sign in');
});
test('missing user verification and a backwards counter are rejected; a zero counter is accepted', async () => {
  const { row } = await signInWithTotp();
  const { soft } = await register(row);
  const frozen = new SoftPasskey(true);
  await register(row, 'Phone', frozen);
  db().exec('DELETE FROM sessions');
  const id = soft.credentialId.toString('base64url');
  const unverified = await passkeyLogin(
    soft.authenticate(await loginOptions(), ORIGIN, { uv: false }),
  );
  expect(unverified.response.status).toBe(401);
  expect(signCount(id)).toBe(0);
  expect(
    (await passkeyLogin(soft.authenticate(await loginOptions(), ORIGIN)))
      .response.status,
  ).toBe(200);
  expect(signCount(id)).toBe(2);
  db()
    .prepare('UPDATE passkeys SET sign_count=5 WHERE credential_id=?')
    .run(id);
  db().exec('DELETE FROM sessions');
  const regressed = await passkeyLogin(
    soft.authenticate(await loginOptions(), ORIGIN),
  );
  expect(regressed.response.status).toBe(401);
  expect(signCount(id)).toBe(5);
  expect(regressed.jar).toEqual([]);
  db().prepare('DELETE FROM limits').run();
  const zeroId = frozen.credentialId.toString('base64url');
  expect(
    (await passkeyLogin(frozen.authenticate(await loginOptions(), ORIGIN)))
      .response.status,
  ).toBe(200);
  expect(signCount(zeroId)).toBe(0);
  db().exec('DELETE FROM sessions');
  expect(
    (await passkeyLogin(frozen.authenticate(await loginOptions(), ORIGIN)))
      .response.status,
  ).toBe(200);
  expect(signCount(zeroId)).toBe(0);
});
test('a cross-origin browser request is rejected before a challenge or a rate limit', async () => {
  const { row } = await signInWithTotp();
  const loginCross = await call(
    authOptionsRoute,
    http(
      '/api/admin/login/passkey/options',
      undefined,
      {},
      'https://evil.example',
    ),
  );
  expect(loginCross.response.status).toBe(401);
  expect(await loginCross.response.json()).toEqual({
    error: 'Unable to sign in',
  });
  const registerCross = await call(
    registerOptionsRoute,
    http(
      '/api/admin/passkeys/options',
      undefined,
      { 'x-csrf': row.csrf },
      'https://evil.example',
    ),
    { session: row },
  );
  expect(registerCross.response.status).toBe(403);
  expect(challenges()).toEqual([]);
  expect(db().prepare('SELECT count(*) AS count FROM limits').get()).toEqual({
    count: 0,
  });
  expect((await loginOptions()).rpId).toBe(RP_ID);
});
test('revoke-passkeys removes credentials only', async () => {
  const before = db()
    .prepare('SELECT password_hash, totp_secret FROM admin')
    .get();
  const { row } = await signInWithTotp();
  const { soft } = await register(row, 'Phone');
  const result = await new Promise<{ code: number | null; output: string }>(
    (resolve) => {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', 'bin/admin.ts', 'revoke-passkeys'],
        {
          cwd: fileURLToPath(new URL('..', import.meta.url)),
          env: process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let output = '';
      child.stdout.on('data', (chunk) => (output += chunk));
      child.stderr.on('data', (chunk) => (output += chunk));
      child.on('exit', (code) => resolve({ code, output }));
    },
  );
  expect(result.code).toBe(0);
  expect(result.output).toContain('Revoked 1 passkey.');
  expect(result.output).not.toContain(SECRET);
  expect(result.output).not.toContain(PASSWORD);
  db().exec('DELETE FROM sessions');
  expect(
    (await passkeyLogin(soft.authenticate(await loginOptions(), ORIGIN)))
      .response.status,
  ).toBe(401);
  expect(
    db().prepare('SELECT password_hash, totp_secret FROM admin').get(),
  ).toEqual(before);
  const fresh = await signInWithTotp();
  expect(
    (
      await (
        await call(listRoute, new Request(ORIGIN + '/api/admin/passkeys'), {
          session: fresh.row,
        })
      ).response.json()
    ).passkeys,
  ).toEqual([]);
  expect(
    (db().prepare('SELECT count(*) AS count FROM sessions').get() as any).count,
  ).toBeGreaterThan(0);
});
