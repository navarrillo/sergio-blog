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
const root = mkdtempSync(path.join(tmpdir(), 'blog-agent-migration-'));
Object.assign(process.env, {
  DATA_DIR: root + '/data',
  BACKUPS_DIR: root + '/backups',
  AGENT_TOKEN_SECRET: 'test-key-with-at-least-32-random-bytes',
});
mkdirSync(root + '/data');
const previous = new DatabaseSync(root + '/data/blog.db');
previous.exec(
  readFileSync(new URL('./fixtures/schema-v1.sql', import.meta.url), 'utf8'),
);
previous
  .prepare(
    "INSERT INTO posts(title,slug,status,created_at,updated_at) VALUES('Existing','existing','draft','2026-10-24','2026-10-24')",
  )
  .run();
previous.close();
const { db, migrate } = await import('../src/lib/db');
const {
  createAgentToken,
  authenticateAgent,
  agentTokenHash,
  revokeAgentToken,
} = await import('../src/lib/auth');
afterAll(() => {
  db().close();
  rmSync(root, { recursive: true, force: true });
});
test('version-1 upgrade preserves content, backs up, remains readable/writable by the old schema contract', async () => {
  await migrate();
  await migrate();
  expect((db().prepare('PRAGMA user_version').get() as any).user_version).toBe(
    3,
  );
  expect(
    db()
      .prepare('SELECT title,created_by_token_id FROM posts WHERE id=1')
      .get(),
  ).toMatchObject({ title: 'Existing', created_by_token_id: null });
  const snapshots = readdirSync(root + '/backups');
  expect(snapshots).toHaveLength(1);
  const snapshot = new DatabaseSync(root + '/backups/' + snapshots[0]);
  expect(
    (snapshot.prepare('PRAGMA user_version').get() as any).user_version,
  ).toBe(1);
  expect(
    (snapshot.prepare('SELECT title FROM posts WHERE id=1').get() as any).title,
  ).toBe('Existing');
  snapshot.close();
  // The old release writes explicit columns and knows nothing about token ownership.
  const token = createAgentToken('old-writer');
  db()
    .prepare('UPDATE posts SET created_by_token_id=? WHERE id=1')
    .run(token.id);
  db()
    .prepare(
      "UPDATE posts SET title='Old writer',status='published' WHERE id=1",
    )
    .run();
  const revoked = (
    db()
      .prepare('SELECT agent_access_revoked_at FROM posts WHERE id=1')
      .get() as any
  ).agent_access_revoked_at;
  expect(revoked).toBeTruthy();
  db().prepare("UPDATE posts SET status='draft' WHERE id=1").run();
  expect(
    (
      db()
        .prepare('SELECT agent_access_revoked_at FROM posts WHERE id=1')
        .get() as any
    ).agent_access_revoked_at,
  ).toBe(revoked);
  expect(
    db()
      .prepare("SELECT rowid FROM posts_fts WHERE posts_fts MATCH 'writer'")
      .get(),
  ).toBeTruthy();
  db()
    .prepare(
      "INSERT INTO posts(title,slug,created_at,updated_at) VALUES('Old create','old-create','2026-10-24','2026-10-24')",
    )
    .run();
});
test('token hashes use a separate secret and revocation matches exactly one name or ID', () => {
  const a = createAgentToken('numeric-target');
  const b = createAgentToken(String(a.id));
  expect(a.token).toMatch(/^sbd_[A-Za-z0-9_-]{43}$/);
  expect(authenticateAgent('Bearer ' + a.token)).toEqual({
    id: a.id,
    name: 'numeric-target',
  });
  expect(authenticateAgent('Bearer ' + a.token + '\n')).toBeNull();
  expect(revokeAgentToken(String(a.id))).toBe(1);
  expect(authenticateAgent('Bearer ' + b.token)).toBeNull();
  expect(authenticateAgent('Bearer ' + a.token)).not.toBeNull();
  const key = process.env.AGENT_TOKEN_SECRET;
  delete process.env.AGENT_TOKEN_SECRET;
  expect(() => agentTokenHash(a.token)).toThrow(/AGENT_TOKEN_SECRET/);
  process.env.AGENT_TOKEN_SECRET = 'another-distinct-secret-with-32-bytes';
  expect(authenticateAgent('Bearer ' + a.token)).toBeNull();
  process.env.AGENT_TOKEN_SECRET = key;
});
