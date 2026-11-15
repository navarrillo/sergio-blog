import { test, expect, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import argon2 from 'argon2';

const root = mkdtempSync(path.join(tmpdir(), 'blog-passkey-migration-'));
const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const password = 'a sufficiently long password';
const hash = await argon2.hash(password);
Object.assign(process.env, {
  DATA_DIR: root + '/data',
  UPLOADS_DIR: root + '/uploads',
  BACKUPS_DIR: root + '/backups',
  COOKIE_SECURE: 'false',
  PUBLIC_ORIGIN: 'https://blog.example.test',
});
mkdirSync(root + '/data');
const previous = new DatabaseSync(root + '/data/blog.db');
previous.exec(
  readFileSync(new URL('./fixtures/schema-v1.sql', import.meta.url), 'utf8'),
);
previous.exec('PRAGMA user_version=3');
previous
  .prepare(
    'INSERT INTO admin(id,password_hash,totp_secret,last_totp) VALUES(1,?,?,0)',
  )
  .run(hash, secret);
previous
  .prepare('INSERT INTO sessions(token,csrf,expires) VALUES(?,?,?)')
  .run('legacy-session', 'legacy-csrf', Date.now() + 3_600_000);
previous
  .prepare(
    "INSERT INTO posts(title,slug,body,status,published_at,created_at,updated_at) VALUES('Kept','kept','still here','published','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')",
  )
  .run();
previous.close();
const { db, migrate } = await import('../src/lib/db');
const { login, totp } = await import('../src/lib/auth');
afterAll(() => {
  db().close();
  rmSync(root, { recursive: true, force: true });
});
test('v3 to v4 keeps the existing admin, session and post', async () => {
  await migrate();
  await migrate();
  expect((db().prepare('PRAGMA user_version').get() as any).user_version).toBe(
    4,
  );
  expect(
    db()
      .prepare('SELECT password_hash, totp_secret, last_totp FROM admin')
      .get(),
  ).toEqual({ password_hash: hash, totp_secret: secret, last_totp: 0 });
  expect(await argon2.verify(hash, password)).toBe(true);
  expect(
    db().prepare('SELECT token, csrf, authenticated_at FROM sessions').get(),
  ).toEqual({
    token: 'legacy-session',
    csrf: 'legacy-csrf',
    authenticated_at: 0,
  });
  expect(
    (db().prepare('SELECT body FROM posts WHERE slug=?').get('kept') as any)
      .body,
  ).toBe('still here');
  expect(
    (db().prepare('SELECT count(*) AS count FROM passkeys').get() as any).count,
  ).toBe(0);
  expect(
    db()
      .prepare(
        "SELECT name FROM sqlite_master WHERE name='webauthn_challenges'",
      )
      .get(),
  ).toBeTruthy();
  const backups = readdirSync(root + '/backups');
  expect(backups).toHaveLength(1);
  const snapshot = new DatabaseSync(root + '/backups/' + backups[0], {
    readOnly: true,
  });
  expect(
    (snapshot.prepare('PRAGMA user_version').get() as any).user_version,
  ).toBe(3);
  expect(
    (snapshot.prepare('SELECT totp_secret FROM admin').get() as any)
      .totp_secret,
  ).toBe(secret);
  expect(
    snapshot
      .prepare("SELECT name FROM sqlite_master WHERE name='passkeys'")
      .get(),
  ).toBeUndefined();
  snapshot.close();
  expect(await login(password, totp(secret))).toBeTruthy();
  expect(
    (db().prepare('SELECT last_totp FROM admin').get() as any).last_totp,
  ).toBeGreaterThan(0);
});
