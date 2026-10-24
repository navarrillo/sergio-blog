import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { config } from './config';
let singleton: DatabaseSync;
export function db() {
  if (singleton) return singleton;
  mkdirSync(config.data, { recursive: true, mode: 0o700 });
  singleton = new DatabaseSync(path.join(config.data, 'blog.db'));
  singleton.exec(
    'PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;',
  );
  // Schema changes are applied explicitly by bin/migrate.ts, never by requests.
  return singleton;
}
export async function migrate() {
  const database = db();
  const version = Number(
    (database.prepare('PRAGMA user_version').get() as any).user_version,
  );
  if (version >= 2) return;
  if (existsSync(path.join(config.data, 'blog.db')) && version < 2) {
    mkdirSync(config.backups, { recursive: true, mode: 0o700 });
    await backup(
      database,
      path.join(config.backups, `before-migration-${Date.now()}.db`),
    );
  }
  if (version < 1)
    database.exec(`BEGIN IMMEDIATE;
CREATE TABLE posts(id INTEGER PRIMARY KEY, title TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, summary TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '', type TEXT NOT NULL DEFAULT 'article' CHECK(type IN ('article','note','x_post')), status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','trash')), tags TEXT NOT NULL DEFAULT '[]', image TEXT NOT NULL DEFAULT '', featured INTEGER NOT NULL DEFAULT 0, source_url TEXT NOT NULL DEFAULT '', published_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE redirects(slug TEXT PRIMARY KEY, post_id INTEGER NOT NULL REFERENCES posts(id));
CREATE TABLE revisions(id INTEGER PRIMARY KEY, post_id INTEGER NOT NULL REFERENCES posts(id), snapshot TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE projects(id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', image TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active', url TEXT NOT NULL DEFAULT '', source_url TEXT NOT NULL DEFAULT '');
CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE admin(id INTEGER PRIMARY KEY CHECK(id=1), password_hash TEXT NOT NULL, totp_secret TEXT, last_totp INTEGER NOT NULL DEFAULT 0);
CREATE TABLE sessions(token TEXT PRIMARY KEY, csrf TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE limits(key TEXT PRIMARY KEY, count INTEGER NOT NULL, reset INTEGER NOT NULL);
CREATE TABLE x_imports(id TEXT PRIMARY KEY, original TEXT NOT NULL, text TEXT NOT NULL, date TEXT NOT NULL, url TEXT NOT NULL, media TEXT NOT NULL DEFAULT '[]', post_id INTEGER REFERENCES posts(id), created_at TEXT NOT NULL);
CREATE VIRTUAL TABLE posts_fts USING fts5(title, summary, body, content='posts', content_rowid='id');
CREATE TRIGGER posts_ai AFTER INSERT ON posts BEGIN INSERT INTO posts_fts(rowid,title,summary,body) VALUES(new.id,new.title,new.summary,new.body); END;
CREATE TRIGGER posts_ad AFTER DELETE ON posts BEGIN INSERT INTO posts_fts(posts_fts,rowid,title,summary,body) VALUES('delete',old.id,old.title,old.summary,old.body); END;
CREATE TRIGGER posts_au AFTER UPDATE ON posts BEGIN INSERT INTO posts_fts(posts_fts,rowid,title,summary,body) VALUES('delete',old.id,old.title,old.summary,old.body); INSERT INTO posts_fts(rowid,title,summary,body) VALUES(new.id,new.title,new.summary,new.body); END;
PRAGMA user_version=1; COMMIT;`);
  database.exec(`BEGIN IMMEDIATE;
CREATE TABLE agent_tokens(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT);
ALTER TABLE posts ADD COLUMN created_by_token_id INTEGER REFERENCES agent_tokens(id);
ALTER TABLE posts ADD COLUMN agent_access_revoked_at TEXT;
CREATE INDEX posts_agent_owner ON posts(created_by_token_id,status);
-- A status trigger updates only ownership metadata. Do not reindex that nested update:
-- the outer title/body update has not yet reached its FTS trigger.
DROP TRIGGER posts_au;
CREATE TRIGGER posts_au AFTER UPDATE OF title,summary,body ON posts BEGIN INSERT INTO posts_fts(posts_fts,rowid,title,summary,body) VALUES('delete',old.id,old.title,old.summary,old.body); INSERT INTO posts_fts(rowid,title,summary,body) VALUES(new.id,new.title,new.summary,new.body); END;
CREATE TRIGGER posts_agent_status AFTER UPDATE OF status ON posts
WHEN OLD.created_by_token_id IS NOT NULL AND OLD.status <> NEW.status
BEGIN UPDATE posts SET agent_access_revoked_at=COALESCE(agent_access_revoked_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE id=NEW.id; END;
PRAGMA user_version=2; COMMIT;`);
}
let depth = 0;
export function transaction<T>(fn: () => T): T {
  const level = depth++;
  const point = 'nested_' + level;
  db().exec(level ? 'SAVEPOINT ' + point : 'BEGIN IMMEDIATE');
  try {
    const result = fn();
    db().exec(level ? 'RELEASE SAVEPOINT ' + point : 'COMMIT');
    return result;
  } catch (e) {
    db().exec(level ? 'ROLLBACK TO SAVEPOINT ' + point : 'ROLLBACK');
    if (level) db().exec('RELEASE SAVEPOINT ' + point);
    throw e;
  } finally {
    depth--;
  }
}
export const setting = (key: string, fallback = '') =>
  String(
    (db().prepare('SELECT value FROM settings WHERE key=?').get(key) as any)
      ?.value ?? fallback,
  );
export const setSetting = (key: string, value: string) =>
  db()
    .prepare(
      'INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    )
    .run(key, value);
