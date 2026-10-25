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
const root = mkdtempSync(path.join(tmpdir(), 'blog-editorial-migration-'));
Object.assign(process.env, {
  DATA_DIR: root + '/data',
  BACKUPS_DIR: root + '/backups',
});
mkdirSync(root + '/data');
const previous = new DatabaseSync(root + '/data/blog.db');
previous.exec(
  readFileSync(new URL('./fixtures/schema-v1.sql', import.meta.url), 'utf8'),
);
previous.exec(`CREATE TABLE agent_tokens(id INTEGER PRIMARY KEY,name TEXT,token_hash TEXT,created_at TEXT,last_used_at TEXT,revoked_at TEXT);
ALTER TABLE posts ADD COLUMN created_by_token_id INTEGER REFERENCES agent_tokens(id);
ALTER TABLE posts ADD COLUMN agent_access_revoked_at TEXT;
INSERT INTO posts(id,title,slug,body,status,featured,published_at,created_at,updated_at) VALUES(1,'Existing live','existing-live','existing text','published',1,'2025-01-01T00:00:00.000Z','2025-01-01T00:00:00.000Z','2025-01-01T00:00:00.000Z');
INSERT INTO redirects(slug,post_id) VALUES('older-url',1);
INSERT INTO revisions(post_id,snapshot,created_at) VALUES(1,'{"title":"Previous"}','2025-01-01T00:00:00.000Z');
PRAGMA user_version=2;`);
previous.close();
const { db, migrate } = await import('../src/lib/db');
const { saveWorking, workingPost } = await import('../src/lib/editorial');
afterAll(() => {
  db().close();
  rmSync(root, { recursive: true, force: true });
});
test('v2 migration preserves live content, pins, history and URLs, backs up, and runs once', async () => {
  await migrate();
  await migrate();
  expect((db().prepare('PRAGMA user_version').get() as any).user_version).toBe(
    3,
  );
  expect(workingPost(1)).toMatchObject({
    title: 'Existing live',
    body: 'existing text',
    featured: true,
    edit_version: 1,
    has_changes: false,
  });
  expect(
    db().prepare('SELECT post_id FROM redirects WHERE slug=?').get('older-url'),
  ).toMatchObject({ post_id: 1 });
  expect(
    db().prepare('SELECT kind FROM revisions WHERE post_id=1').get(),
  ).toMatchObject({ kind: 'saved' });
  const backups = readdirSync(root + '/backups');
  expect(backups).toHaveLength(1);
  const snapshot = new DatabaseSync(root + '/backups/' + backups[0], {
    readOnly: true,
  });
  expect(
    (snapshot.prepare('PRAGMA user_version').get() as any).user_version,
  ).toBe(2);
  snapshot.close();
  saveWorking({ ...workingPost(1), body: 'private migration test' }, 1, 1);
  expect(workingPost(1)?.has_changes).toBe(true);
  expect(
    (db().prepare('SELECT body FROM posts WHERE id=1').get() as any).body,
  ).toBe('existing text');
});
