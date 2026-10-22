// Explicitly opt in against disposable local Umami; never target a public host.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
if (process.env.UMAMI_SMOKE !== 'true')
  throw new Error(
    'Requires UMAMI_SMOKE=true and a disposable local Umami instance.',
  );
const origin = process.env.UMAMI_SMOKE_URL || 'http://127.0.0.1:8011';
if (new URL(origin).hostname !== '127.0.0.1')
  throw new Error('Local loopback only');
const request = async (p: string, init: RequestInit = {}) => {
  const r = await fetch(origin + p, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init.headers },
  });
  if (!r.ok) throw new Error(`Umami ${p}: ${r.status} ${await r.text()}`);
  return r.json();
};
const auth = await request('/api/auth/login', {
  method: 'POST',
  body: JSON.stringify({ username: 'admin', password: 'umami' }),
});
assert(auth.token);
const headers = { Authorization: 'Bearer ' + auth.token };
const website = await request('/api/websites', {
  method: 'POST',
  headers,
  body: JSON.stringify({
    name: 'Disposable blog integration ' + Date.now(),
    domain: 'localhost',
  }),
});
assert(website.id);
const root = mkdtempSync(path.join(tmpdir(), 'blog-umami-'));
Object.assign(process.env, {
  DATA_DIR: root + '/data',
  UPLOADS_DIR: root + '/uploads',
  BACKUPS_DIR: root + '/backups',
  COOKIE_SECURE: 'false',
  UMAMI_INTERNAL_URL: origin,
  UMAMI_USERNAME: 'admin',
  UMAMI_PASSWORD: 'umami',
  UMAMI_WEBSITE_ID: website.id,
});
mkdirSync(root + '/uploads');
const { migrate, db } = await import('../src/lib/db');
const { savePost } = await import('../src/lib/content');
const { analytics, publicStats } = await import('../src/lib/analytics');
try {
  await migrate();
  savePost({
    title: 'Analytics test',
    slug: 'analytics-test',
    status: 'published',
  });
  for (const name of [
    undefined,
    'project-click',
    'outbound-click',
    'search-no-results',
  ])
    await request('/api/send', {
      method: 'POST',
      headers: {
        'user-agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
      },
      body: JSON.stringify({
        type: 'event',
        payload: {
          website: website.id,
          hostname: 'localhost',
          url: '/posts/analytics-test',
          language: 'en-US',
          screen: '1440x900',
          title: 'Analytics test',
          ...(name ? { name, data: { test: 'local' } } : {}),
        },
      }),
    });
  // Give the analytics transaction a moment to finish, then compare the same API used by the dashboard.
  await new Promise((r) => setTimeout(r, 1000));
  const data = await analytics();
  assert(data?.updated_at);
  const pageviews = data.stats.pageviews?.value ?? data.stats.pageviews;
  assert.equal(pageviews, 1);
  const stats = await publicStats();
  assert.equal(stats.popular[0]?.path, '/posts/analytics-test');
  assert.equal(stats.popular[0]?.views, 1);
  const query = `startAt=${Date.now() - 86400000}&endAt=${Date.now() + 1000}&type=event`;
  const events = await request(`/api/websites/${website.id}/metrics?${query}`, {
    headers,
  });
  assert.equal(events.length, 3);
  console.log(
    'Umami smoke passed: actual page view, three named events, dashboard API and cached public aggregates agree.',
  );
} finally {
  db().close();
  rmSync(root, { recursive: true, force: true });
}
