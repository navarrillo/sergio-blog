import assert from 'node:assert/strict';
import { db } from '../src/lib/db';
import { savePost, getDraft } from '../src/lib/content';
import { createAgentToken } from '../src/lib/auth';

export async function agentReading(
  base: string,
  foreignId: number,
  adminId: number,
) {
  const token = createAgentToken('Reader and listing test');
  const request = (path = '', method = 'GET', body?: unknown) =>
    fetch(base + '/api/agent/v1/drafts' + path, {
      method,
      headers: {
        authorization: 'Bearer ' + token.token,
        'content-type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  assert.deepEqual(await (await request()).json(), {
    items: [],
    next_cursor: null,
  });
  const eligible: any[] = [];
  for (let i = 0; i < 25; i++) {
    const response = await request('', 'POST', {
      title: 'List draft ' + i,
      body: 'PRIVATE_LIST_BODY',
      summary: 'Summary',
      tags: ['private'],
      type: 'note',
    });
    assert.equal(response.status, 201);
    const post = await response.json();
    // Ties span multiple pages; a second timestamp exercises the date boundary too.
    const updated =
      i < 10 ? '2026-10-23T12:00:00.000Z' : '2026-10-24T12:00:00.000Z';
    db()
      .prepare('UPDATE posts SET updated_at=? WHERE id=?')
      .run(updated, post.id);
    eligible.push({ ...post, title: 'List draft ' + i, updated_at: updated });
  }
  const hidden = [foreignId, adminId];
  for (const status of ['published', 'trash', 'locked']) {
    const post = await (
      await request('', 'POST', { title: 'Ineligible ' + status })
    ).json();
    savePost(
      {
        ...getDraft(post.id),
        status: status === 'trash' ? 'trash' : 'published',
      },
      post.id,
    );
    if (status === 'locked')
      savePost({ ...getDraft(post.id), status: 'draft' }, post.id);
    hidden.push(post.id);
  }
  const target = eligible[0];
  savePost(
    {
      ...getDraft(target.id),
      featured: true,
      image: '/uploads/abcd.webp',
      source_url: 'https://example.com',
    },
    target.id,
  );
  eligible[0].updated_at = getDraft(target.id).updated_at;
  eligible.sort(
    (a, b) => b.updated_at.localeCompare(a.updated_at) || b.id - a.id,
  );
  const expectedIds = eligible.map((p) => p.id);
  const defaultPage = await (await request()).json();
  assert.equal(defaultPage.items.length, 20);
  assert.equal(typeof defaultPage.next_cursor, 'string');
  assert.deepEqual(
    defaultPage.items.map((p: any) => p.id),
    expectedIds.slice(0, 20),
  );
  const all = await (await request('?limit=50')).json();
  assert.equal(all.next_cursor, null);
  assert.deepEqual(
    all.items.map((p: any) => p.id),
    expectedIds,
  );
  for (const item of all.items) {
    assert.deepEqual(
      Object.keys(item).sort(),
      ['id', 'title', 'slug', 'updated_at', 'preview_url'].sort(),
    );
    assert(!hidden.includes(item.id));
    assert.equal(item.preview_url, '/admin/edit?id=' + item.id);
  }
  const paged: number[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const response = await request(
      '?limit=7' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''),
    );
    assert.equal(response.status, 200);
    const page = await response.json();
    paged.push(...page.items.map((p: any) => p.id));
    cursor = page.next_cursor;
    assert(++pages <= 4, 'Pagination must terminate');
  } while (cursor);
  assert.deepEqual(paged, expectedIds);
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  for (const query of [
    '?unknown=x',
    '?page=2',
    '?limit=',
    '?limit=0',
    '?limit=-1',
    '?limit=51',
    '?limit=1.5',
    '?limit=foo',
    '?limit=01',
    '?limit=1&limit=2',
    '?cursor=',
    '?cursor=***',
    '?cursor=a'.padEnd(530, 'a'),
    '?cursor=' + encode({}),
    '?cursor=' + encode(['bad', 1]),
    '?cursor=' + encode(['2026-10-24T12:00:00.000Z', -1]),
    '?cursor=' + encode(['2026-10-24T12:00:00.000Z', 1.5]),
    '?cursor=' +
      encode(['2026-10-24T12:00:00.000Z', Number.MAX_SAFE_INTEGER + 1]),
    '?cursor=' + encode(['2026-10-24T12:00:00.000Z', 1, 'extra']),
    '?cursor=' + defaultPage.next_cursor + '&cursor=' + defaultPage.next_cursor,
  ]) {
    assert.equal((await request(query)).status, 400, query);
  }
  for (const id of [
    ...hidden,
    '0',
    '-1',
    '01',
    '1.5',
    '1e2',
    'NaN',
    '9007199254740992',
    '999999999',
  ])
    assert.equal((await request('/' + id)).status, 404, String(id));
  const detail = await (await request('/' + target.id)).json();
  assert.deepEqual(
    Object.keys(detail).sort(),
    [
      'id',
      'title',
      'slug',
      'summary',
      'body',
      'tags',
      'type',
      'status',
      'preview_url',
      'updated_at',
    ].sort(),
  );
  assert.equal(detail.body, 'PRIVATE_LIST_BODY');
  assert.equal(detail.title, target.title);
  assert.equal(detail.summary, 'Summary');
  assert.deepEqual(detail.tags, ['private']);
  assert.equal(detail.type, 'note');
  assert.equal(detail.status, 'draft');
  assert.equal(
    (await request('/' + target.id, 'PATCH', { body: 'REVISED_LIST_BODY' }))
      .status,
    200,
  );
  assert.equal(
    (await (await request('/' + target.id)).json()).body,
    'REVISED_LIST_BODY',
  );
  // Status transitions exclude the same row from both reads, including a permanently locked draft.
  savePost({ ...getDraft(target.id), status: 'published' }, target.id);
  assert.equal((await request('/' + target.id)).status, 404);
  const afterPublish = await (await request('?limit=50')).json();
  assert(!afterPublish.items.some((p: any) => p.id === target.id));
  savePost({ ...getDraft(target.id), status: 'draft' }, target.id);
  assert.equal((await request('/' + target.id)).status, 404);
  assert(
    !(await (await request('?limit=50')).json()).items.some(
      (p: any) => p.id === target.id,
    ),
  );
  return token.token;
}
