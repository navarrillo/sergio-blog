import { test, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const root = mkdtempSync(path.join(tmpdir(), 'blog-editorial-'));
Object.assign(process.env, {
  DATA_DIR: root + '/data',
  BACKUPS_DIR: root + '/backups',
  AGENT_TOKEN_SECRET: 'editorial-test-secret-with-at-least-32-bytes',
});
const { db, migrate } = await import('../src/lib/db');
const { savePost, getDraft, getPost, queryPosts, pinnedPosts, redirectFor } =
  await import('../src/lib/content');
const {
  saveWorking,
  workingPost,
  postAction,
  restoreWorkingRevision,
  setPinned,
  listAdminPosts,
  adminTags,
  changeTag,
  visibility,
} = await import('../src/lib/editorial');
const { createAgentToken } = await import('../src/lib/auth');
const { agentSave, ownedDraft } = await import('../src/lib/agent');
const { repairEditorIndentation, sourceRequiresMarkdown } =
  await import('../src/lib/editor-markdown');
beforeAll(migrate);
afterAll(() => {
  db().close();
  rmSync(root, { recursive: true, force: true });
});
test('private saves leave live text, date, search, tags and slug redirects unchanged until publication', () => {
  const id = savePost({
    title: 'Live title',
    slug: 'live-title',
    body: 'public vocabulary',
    tags: ['live-tag'],
    status: 'published',
    published_at: '2025-01-01T00:00:00.000Z',
  });
  const original = getDraft(id);
  const pending = saveWorking(
    {
      ...original,
      title: 'Private pending title',
      slug: 'pending-url',
      body: 'unreleasedword',
      tags: ['pending-tag'],
    },
    id,
    original.edit_version,
  )!;
  expect(pending.has_changes).toBe(true);
  expect(visibility(pending)).toBe('Published · unpublished changes');
  expect(getDraft(id).updated_at).toBe(original.updated_at);
  expect(getPost('live-title')?.body).toBe('public vocabulary');
  expect(getPost('pending-url')).toBeUndefined();
  expect(redirectFor('live-title')).toBeUndefined();
  expect(
    queryPosts(new URLSearchParams('q=unreleasedword')).items,
  ).toHaveLength(0);
  expect(queryPosts(new URLSearchParams('tag=pending-tag')).items).toHaveLength(
    0,
  );
  expect(getPost('live-title')).not.toHaveProperty('edit_version');
  setPinned(id, true);
  const published = postAction(id, 'publish', pending.edit_version);
  expect(getPost('pending-url')?.body).toBe('unreleasedword');
  expect(redirectFor('live-title')?.slug).toBe('pending-url');
  expect(published.published_at).toBe(original.published_at);
  expect(published.featured).toBe(true);
  expect(published.has_changes).toBe(false);
});
test('stale saves, actions, revision restoration and bot edits cannot silently overwrite another editor', () => {
  const token = {
    ...createAgentToken('editorial-test-bot'),
    name: 'editorial-test-bot',
  };
  const draft = agentSave({ title: 'Owned draft', body: 'first' }, token);
  const staleVersion = draft.edit_version;
  agentSave({ body: 'bot changed text' }, token, draft.id);
  expect(() =>
    saveWorking({ ...draft, body: 'stale human text' }, draft.id, staleVersion),
  ).toThrow('another tab');
  expect(() => postAction(draft.id, 'publish', staleVersion)).toThrow(
    'another tab',
  );
  const current = workingPost(draft.id)!;
  const revision = db()
    .prepare('SELECT id FROM revisions WHERE post_id=? LIMIT 1')
    .get(draft.id) as any;
  expect(() =>
    restoreWorkingRevision(draft.id, revision.id, staleVersion),
  ).toThrow('another tab');
  postAction(draft.id, 'publish', current.edit_version);
  const privateCopy = saveWorking(
    { ...workingPost(draft.id), body: 'private update' },
    draft.id,
    getDraft(draft.id).edit_version,
  )!;
  const unpublished = postAction(
    draft.id,
    'unpublish',
    privateCopy.edit_version,
  );
  expect(unpublished.body).toBe('private update');
  expect(getPost(unpublished.slug)).toBeUndefined();
  expect(() => ownedDraft(draft.id, token)).toThrow('Not found');
});
test('restoring history stages a private working copy while retaining the live article', () => {
  const id = savePost({
    title: 'History',
    slug: 'history',
    body: 'original text',
    status: 'published',
  });
  const pending = saveWorking(
    { ...workingPost(id), body: 'current private text' },
    id,
    getDraft(id).edit_version,
  )!;
  const revision = db()
    .prepare('SELECT id FROM revisions WHERE post_id=? ORDER BY id LIMIT 1')
    .get(id) as any;
  const restored = restoreWorkingRevision(
    id,
    revision.id,
    pending.edit_version,
  )!;
  expect(getPost('history')?.body).toBe('original text');
  expect(getDraft(id).status).toBe('published');
  expect(restored.body).toBe('original text');
  expect(
    db()
      .prepare(
        "SELECT id FROM revisions WHERE post_id=? AND json_extract(snapshot,'$.body')='current private text'",
      )
      .get(id),
  ).toBeTruthy();
});
test('autosave history is coalesced, unchanged saves are idempotent, and explicit save checkpoints the latest copy', () => {
  const id = savePost({ title: 'Autosave', slug: 'autosave', body: 'first' });
  for (let i = 0; i < 4; i++)
    saveWorking(
      { ...workingPost(id), body: 'edit ' + i },
      id,
      getDraft(id).edit_version,
      true,
    );
  const count = () =>
    Number(
      (
        db()
          .prepare('SELECT count(*) AS n FROM revisions WHERE post_id=?')
          .get(id) as any
      ).n,
    );
  expect(count()).toBe(1);
  const version = getDraft(id).edit_version;
  saveWorking(workingPost(id), id, version, true);
  expect(getDraft(id).edit_version).toBe(version);
  saveWorking(workingPost(id), id, version, false);
  expect(count()).toBe(2);
  saveWorking(workingPost(id), id, version, false);
  expect(count()).toBe(2);
});
test('scheduling, unpublishing, trash and recovery retain private text and enforce public visibility', () => {
  const draft = saveWorking({
    title: 'Scheduled test',
    slug: 'scheduled-test',
    body: 'scheduled body',
  })!;
  expect(() =>
    postAction(draft.id, 'schedule', draft.edit_version, 'bad date'),
  ).toThrow('future');
  const scheduled = postAction(
    draft.id,
    'schedule',
    draft.edit_version,
    '2099-03-01T12:00:00.000Z',
  );
  expect(visibility(scheduled)).toBe('Scheduled');
  expect(getPost('scheduled-test')).toBeUndefined();
  const pending = saveWorking(
    { ...scheduled, body: 'latest scheduled text' },
    draft.id,
    scheduled.edit_version,
  )!;
  const trash = postAction(draft.id, 'trash', pending.edit_version);
  expect(trash.body).toBe('latest scheduled text');
  expect(trash.status).toBe('trash');
  expect(() => saveWorking(trash, draft.id, trash.edit_version)).toThrow(
    'Restore',
  );
  const restored = postAction(draft.id, 'restore', trash.edit_version);
  expect(restored.status).toBe('draft');
  expect(restored.body).toBe('latest scheduled text');
});
test('all public pins are found beyond the latest 100 posts; pin changes do not conflict with private edits', () => {
  const oldest = savePost({
    title: 'Old pinned',
    slug: 'old-pinned',
    status: 'published',
    featured: true,
    published_at: '2020-01-01T00:00:00.000Z',
  });
  for (let i = 0; i < 105; i++)
    savePost({
      title: 'Filler ' + i,
      slug: 'filler-' + i,
      status: 'published',
      featured: i < 3,
      published_at: '2025-02-01T00:00:00.000Z',
    });
  savePost({
    title: 'Future pin',
    slug: 'future-pin',
    status: 'published',
    featured: true,
    published_at: '2099-01-01T00:00:00.000Z',
  });
  savePost({ title: 'Private pin', slug: 'private-pin', featured: true });
  expect(pinnedPosts().some((p) => p.id === oldest)).toBe(true);
  expect(pinnedPosts().length).toBeGreaterThan(2);
  expect(
    pinnedPosts().some((p) => ['future-pin', 'private-pin'].includes(p.slug)),
  ).toBe(false);
  const version = getDraft(oldest).edit_version;
  setPinned(oldest, false);
  const saved = saveWorking(
    { ...workingPost(oldest), body: 'after pinning' },
    oldest,
    version,
  )!;
  expect(saved.featured).toBe(false);
});
test('admin filters search working copies, escape wildcard text, paginate and include private tag counts', () => {
  const id = savePost({
    title: 'Filtered',
    slug: 'filtered',
    status: 'published',
    tags: ['filter-test'],
  });
  saveWorking(
    {
      ...workingPost(id),
      title: 'Private 100% _title',
      tags: ['pending-only'],
    },
    id,
    getDraft(id).edit_version,
  );
  expect(
    listAdminPosts(
      new URLSearchParams('q=100%25+_title&status=changes'),
    ).items.map((p) => p.id),
  ).toContain(id);
  expect(
    listAdminPosts(
      new URLSearchParams('q=100%25+_title&status=changes&tag=pending-only'),
    ).total,
  ).toBe(1);
  expect(
    listAdminPosts(new URLSearchParams('page=2')).items.length,
  ).toBeLessThanOrEqual(20);
  expect(adminTags().find((t) => t.tag === 'pending-only')?.count).toBe(1);
  changeTag('pending-only', 'merged-tag');
  expect(workingPost(id)!.tags).toContain('merged-tag');
  expect(workingPost(id)!.body).toBe('');
  expect(workingPost(id)!.has_changes).toBe(true);
});
test('indent repair removes only exact legacy wrappers and preserves code, lists and special text', () => {
  const original =
    '\nParagraph & <text>\n\n    code\n\n- list\n  - nested\n\n```\n    code\n```\n';
  const wrap = (text: string) => ' '.repeat(18) + text + '\n' + ' '.repeat(16);
  expect(repairEditorIndentation(wrap(wrap(original)))).toEqual({
    text: original,
    removed: 2,
  });
  expect(
    repairEditorIndentation(
      ' '.repeat(18) + 'Paragraph\r\n\r\n    code' + '\r\n' + ' '.repeat(16),
    ),
  ).toEqual({ text: 'Paragraph\r\n\r\n    code', removed: 1 });
  expect(repairEditorIndentation('    intentional code\n')).toEqual({
    text: '    intentional code\n',
    removed: 0,
  });
  expect(sourceRequiresMarkdown('```html\n<div>code</div>\n```')).toBe(false);
  expect(
    sourceRequiresMarkdown(
      '<details><summary>Keep</summary>exact HTML</details>',
    ),
  ).toBe(true);
});
