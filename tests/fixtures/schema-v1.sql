-- Schema shipped before the private agent API (user_version 1).
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
PRAGMA user_version=1;
