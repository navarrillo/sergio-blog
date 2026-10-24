import assert from 'node:assert/strict';
import { db } from '../src/lib/db';
import { createAgentToken } from '../src/lib/auth';
import { getDraft } from '../src/lib/content';

export async function agentBudgets(base: string, restart: () => Promise<void>) {
  const rate = createAgentToken('Rate test');
  const other = createAgentToken('Independent budget test');
  const request = (
    path = '',
    method = 'GET',
    body?: unknown,
    token = rate.token,
  ) =>
    fetch(base + '/api/agent/v1/drafts' + path, {
      method,
      headers: {
        authorization: 'Bearer ' + token,
        'content-type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const count = (kind: string) =>
    Number(
      (
        db()
          .prepare('SELECT count FROM limits WHERE key=?')
          .get('agent-' + kind + ':' + rate.id) as any
      )?.count || 0,
    );
  const limitedDraft = await (
    await request('', 'POST', { title: 'Rate draft' })
  ).json();
  assert.equal(count('write'), 1);
  const foreign = await (
    await request('', 'POST', { title: 'Other budget' }, other.token)
  ).json();
  assert.equal(
    (await request('/' + foreign.id, 'PATCH', { body: 'Not owned' })).status,
    404,
  );
  assert.equal(
    count('write'),
    1,
    'Ownership rejection must roll back the write reservation',
  );
  assert.equal(count('rejected-write'), 1);
  const headers = {
    authorization: 'Bearer ' + rate.token,
    'content-type': 'application/json',
  };
  for (const invalid of [
    { status: 400, body: '{}' },
    { status: 413, body: 'x'.repeat(1250001) },
    { status: 415, body: '{}', contentType: 'text/plain' },
  ]) {
    const r = await fetch(base + '/api/agent/v1/drafts', {
      method: 'POST',
      headers: {
        ...headers,
        'content-type': invalid.contentType || 'application/json',
      },
      body: invalid.body,
    });
    assert.equal(r.status, invalid.status);
    assert.equal(count('write'), 1);
  }
  assert.equal(count('rejected-write'), 4);
  for (const path of [
    '',
    '/' + limitedDraft.id,
    '?limit=1',
    '/' + limitedDraft.id,
  ])
    assert.equal((await request(path)).status, 200);
  assert.equal((await request('?unknown=x')).status, 400);
  assert.equal(count('read'), 5);
  assert.equal(count('write'), 1);
  assert.equal(
    count('rejected-write'),
    4,
    'Bad read queries use only the read bucket',
  );
  for (let i = 4; i < 60; i++)
    assert.equal((await request('', 'POST', {})).status, 400);
  const rejected = await request('', 'POST', {});
  assert.equal(rejected.status, 429);
  assert(Number(rejected.headers.get('retry-after')) > 0);
  assert.equal(count('rejected-write'), 60);
  assert.equal(count('write'), 1);
  // Exhausting rejected writes does not prevent a valid write using its independent allowance.
  for (let i = 0; i < 28; i++)
    assert.equal(
      (await request('/' + limitedDraft.id, 'PATCH', { body: 'Success ' + i }))
        .status,
      200,
    );
  assert.equal(count('write'), 29);
  const concurrent = await Promise.all(
    ['Final A', 'Final B'].map((body) =>
      request('/' + limitedDraft.id, 'PATCH', { body }),
    ),
  );
  assert.deepEqual(concurrent.map((r) => r.status).sort(), [200, 429]);
  const finalBody = getDraft(limitedDraft.id).body;
  assert(['Final A', 'Final B'].includes(finalBody));
  assert.equal(count('write'), 30);
  assert.equal(count('rejected-write'), 60);
  assert.equal(count('read'), 5);
  const revisions = (
    db()
      .prepare('SELECT count(*) AS n FROM revisions WHERE post_id=?')
      .get(limitedDraft.id) as any
  ).n;
  assert.equal(revisions, 29);
  const blocked = await request('/' + limitedDraft.id, 'PATCH', {
    body: 'Never saved',
  });
  assert.equal(blocked.status, 429);
  assert(Number(blocked.headers.get('retry-after')) > 0);
  assert.equal(getDraft(limitedDraft.id).body, finalBody);
  assert.equal(
    (await (await request('/' + limitedDraft.id)).json()).body,
    finalBody,
  );
  assert.equal(
    (await request('', 'POST', { title: 'Independent writes' }, other.token))
      .status,
    201,
  );
  for (let i = 6; i < 120; i++)
    assert.equal(
      (await request(i % 2 ? '' : '/' + limitedDraft.id)).status,
      200,
    );
  for (const path of ['', '/' + limitedDraft.id])
    assert.equal((await request(path)).status, 429);
  assert.equal(count('read'), 120);
  assert.equal(count('write'), 30);
  assert.equal(count('rejected-write'), 60);
  assert.equal((await request('', 'GET', undefined, other.token)).status, 200);
  await restart();
  for (const path of ['', '/' + limitedDraft.id])
    assert.equal((await request(path)).status, 429);
  assert.equal(
    (await request('', 'POST', { title: 'Still blocked' })).status,
    429,
  );
  assert.equal((await request('', 'POST', {})).status, 429);
  assert.equal(count('write'), 30);
  assert.equal(count('rejected-write'), 60);
  assert.equal(count('read'), 120);
  return { rate, limitedDraft, other };
}
