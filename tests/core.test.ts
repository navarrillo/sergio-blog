import { test, expect, beforeAll } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import argon2 from 'argon2';
const root = mkdtempSync(path.join(tmpdir(), 'blog-test-'));
process.env.DATA_DIR = root + '/data';
process.env.UPLOADS_DIR = root + '/uploads';
process.env.BACKUPS_DIR = root + '/backups';
process.env.COOKIE_SECURE = 'false';
process.env.PUBLIC_ORIGIN = 'http://localhost:4321';
mkdirSync(process.env.UPLOADS_DIR);
const { migrate, db } = await import('../src/lib/db');
const {
  savePost,
  getPost,
  getDraft,
  queryPosts,
  redirectFor,
  renderMarkdown,
  tags,
} = await import('../src/lib/content');
const { restoreWorkingRevision, workingPost } =
  await import('../src/lib/editorial');
const { clientIP, allow, totp, validTotp, login, session, csrfValid } =
  await import('../src/lib/auth');
const { storeImage } = await import('../src/lib/media');
const { importArchive, createImportedDraft, parseArchive } =
  await import('../src/lib/importer');
beforeAll(async () => {
  await migrate();
});
test('drafts, future posts and trash are excluded from every shared query', () => {
  savePost({
    title: 'Private secret',
    slug: 'private',
    body: 'classified',
    tags: ['secret'],
  });
  savePost({
    title: 'Future',
    slug: 'future',
    status: 'published',
    published_at: '2099-01-01T00:00:00.000Z',
  });
  savePost({ title: 'Trash', slug: 'trash', status: 'trash' });
  expect(getPost('private')).toBeUndefined();
  expect(getPost('future')).toBeUndefined();
  expect(queryPosts(new URLSearchParams('q=classified')).items).toEqual([]);
  expect(tags()).not.toContainEqual(expect.objectContaining({ tag: 'secret' }));
});
test('publication, revisions, unpublication and slug chains preserve editorial data', () => {
  const id = savePost({
    title: 'First',
    slug: 'first',
    body: 'original',
    status: 'published',
  });
  expect(getPost('first')?.body).toBe('original');
  savePost({ ...getDraft(id), slug: 'second', body: 'updated' }, id);
  savePost({ ...getDraft(id), slug: 'third' }, id);
  expect(redirectFor('first')?.slug).toBe('third');
  expect(redirectFor('second')?.slug).toBe('third');
  expect(() => savePost({ title: 'Clash', slug: 'first' })).toThrow('reserved');
  const revision = db()
    .prepare('SELECT id FROM revisions WHERE post_id=? ORDER BY id LIMIT 1')
    .get(id) as any;
  restoreWorkingRevision(id, revision.id, getDraft(id).edit_version);
  expect(workingPost(id)?.body).toBe('original');
  expect(getDraft(id)?.status).toBe('published');
  expect(getPost('first')).toBeUndefined();
  expect(redirectFor('second')?.slug).toBe('third');
});
test('FTS handles punctuation and SQL-like input, filters, and stable pagination', () => {
  for (let i = 0; i < 5; i++)
    savePost({
      title: 'Search ' + i,
      slug: 'search-' + i,
      body: 'hello world',
      tags: ['testing'],
      type: 'note',
      status: 'published',
      published_at: '2026-01-01T00:00:00.000Z',
    });
  const first = queryPosts(
    new URLSearchParams('q=hello&type=note&tag=testing&limit=2'),
  );
  expect(first.items).toHaveLength(2);
  expect(first.next_cursor).toBeTruthy();
  const second = queryPosts(
    new URLSearchParams({ q: 'hello', limit: '2', cursor: first.next_cursor! }),
  );
  expect(new Set([...first.items, ...second.items].map((p) => p.id)).size).toBe(
    4,
  );
  expect(
    queryPosts(new URLSearchParams({ q: '" OR 1=1; -- () * :' })).items,
  ).toEqual([]);
  expect(() => queryPosts(new URLSearchParams('cursor=garbage'))).toThrow(
    'Invalid cursor',
  );
  expect(() => queryPosts(new URLSearchParams('since=garbage'))).toThrow(
    'Invalid since',
  );
});
test('untrusted forged forwarding headers cannot change the shared rate bucket', () => {
  for (let i = 0; i < 6; i++) {
    const ip = clientIP(
      '192.0.2.5',
      new Headers({ 'X-Forwarded-For': '198.51.100.' + i }),
      [],
    );
    expect(ip).toBe('192.0.2.5');
    expect(allow('spoof:' + ip, 5)).toBe(i < 5);
  }
  expect(
    clientIP('172.18.0.1', new Headers({ 'X-Forwarded-For': '192.0.2.3' }), [
      '172.18.0.1',
    ]),
  ).toBe('192.0.2.3');
  expect(
    clientIP('172.18.0.1', new Headers({ 'X-Forwarded-For': 'fake' }), [
      '172.18.0.1',
    ]),
  ).toBe('172.18.0.1');
  expect(
    clientIP(
      '172.18.0.1',
      new Headers({ 'X-Forwarded-For': '1.1.1.1, 192.0.2.5' }),
      ['172.18.0.1'],
    ),
  ).toBe('192.0.2.5');
});
test('TOTP matches RFC 6238 vector and rejects replay', () => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  expect(totp(secret, 1)).toBe('287082');
  const step = Math.floor(Date.now() / 30000);
  expect(validTotp(secret, totp(secret), step)).toBeNull();
  expect(validTotp(secret, totp(secret), 0)).toBe(step);
});
test('login requires password and TOTP, hashes sessions, and rejects reused codes', async () => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  const hash = await argon2.hash('a sufficiently long password');
  db()
    .prepare('INSERT INTO admin(id,password_hash,totp_secret) VALUES(1,?,?)')
    .run(hash, secret);
  expect(await login('wrong', totp(secret))).toBeNull();
  expect(await login('a sufficiently long password', '000000')).toBeNull();
  const token = await login('a sufficiently long password', totp(secret));
  expect(token).toBeTruthy();
  expect(await login('a sufficiently long password', totp(secret))).toBeNull();
  const request = new Request('http://localhost:4321/admin', {
    headers: { cookie: 'blog_dev_session=' + token },
  });
  expect(session(request)?.csrf.length).toBe(43);
  expect(
    db().prepare('SELECT * FROM sessions WHERE token=?').get(token!),
  ).toBeUndefined();
});
test('CSRF requires exact origin and session token', () => {
  const request = new Request('http://localhost:4321', {
    headers: { origin: 'http://localhost:4321' },
  });
  expect(csrfValid(request, 'abc', 'abc')).toBe(true);
  expect(csrfValid(request, 'abc', 'def')).toBe(false);
  expect(
    csrfValid(
      new Request('http://localhost:4321', {
        headers: { origin: 'https://evil.example' },
      }),
      'abc',
      'abc',
    ),
  ).toBe(false);
});
test('malicious Markdown cannot add scripts, event handlers or executable URLs', () => {
  const html = renderMarkdown(
    '<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n[bad](javascript:alert(1))\n<iframe src="https://evil.example"></iframe>',
  );
  expect(html).not.toMatch(/<script|onerror|href="javascript:|<iframe/);
  expect(renderMarkdown('**safe**')).toContain('<strong>safe</strong>');
});
test('image decoder rejects fake images and removes EXIF', async () => {
  await expect(
    storeImage(Buffer.from('<svg onload="alert(1)"></svg>')),
  ).rejects.toThrow();
  const sharp = (await import('sharp')).default;
  const original = await sharp({
    create: { width: 4, height: 4, channels: 3, background: 'green' },
  })
    .jpeg()
    .withMetadata()
    .toBuffer();
  const saved = await storeImage(original);
  const metadata = await sharp(
    root + '/uploads/' + saved.split('/').at(-1),
  ).metadata();
  expect(metadata.format).toBe('webp');
  expect(metadata.exif).toBeUndefined();
});
test('X import is private, deduplicated, preserves editorial edits and reports errors', async () => {
  const data = Buffer.from(
    'window.YTD.tweets.part0 = ' +
      JSON.stringify([
        {
          tweet: {
            id_str: '123',
            full_text: 'original source',
            created_at: '2025-01-01',
            extended_entities: {
              media: [{ media_url_https: 'https://example.com/missing.jpg' }],
            },
          },
        },
        { tweet: { id_str: 'invalid' } },
      ]),
  );
  const first = await importArchive(data);
  expect(first.imported).toBe(1);
  expect(first.errors).toHaveLength(2);
  const id = createImportedDraft(['123'], 'note', 'Imported note');
  savePost({ ...getDraft(id), body: 'edited version' }, id);
  const second = await importArchive(data);
  expect(second.duplicates).toBe(1);
  expect(getDraft(id).body).toBe('edited version');
  expect(getPost('x-123')).toBeUndefined();
  expect(() => createImportedDraft(['123'], 'note', 'Again')).toThrow();
  expect(() => parseArchive('broken')).toThrow();
});
