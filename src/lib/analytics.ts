import { db, setting, setSetting } from './db';
import { tags } from './content';
import { now } from './config';
let pending: Promise<any> | null = null;
export async function analytics() {
  const cached = JSON.parse(setting('analytics_cache', 'null'));
  if (cached && Date.now() - cached.updated_ms < 900000) return cached;
  if (pending) return pending;
  pending = (async () => {
    try {
      const base = process.env.UMAMI_INTERNAL_URL;
      const website = process.env.UMAMI_WEBSITE_ID;
      if (!base || !website) return cached || null;
      const host = new URL(base).hostname;
      if (!['umami', 'localhost', '127.0.0.1', '[::1]'].includes(host))
        throw new Error('Umami must use an internal address');
      const request = async (path: string, init: RequestInit = {}) => {
        const r = await fetch(base + path, {
          ...init,
          signal: AbortSignal.timeout(2500),
        });
        if (!r.ok) throw new Error('Analytics unavailable');
        return r.json();
      };
      const auth = await request('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: process.env.UMAMI_USERNAME,
          password: process.env.UMAMI_PASSWORD,
        }),
      });
      const end = Date.now(),
        start = end - 30 * 86400000;
      const query = `startAt=${start}&endAt=${end}`;
      const headers = { Authorization: `Bearer ${auth.token}` };
      const [stats, pages] = await Promise.all([
        request(`/api/websites/${website}/stats?${query}`, { headers }),
        request(`/api/websites/${website}/metrics?${query}&type=path`, {
          headers,
        }),
      ]);
      const value = { updated_at: now(), updated_ms: end, stats, pages };
      setSetting('analytics_cache', JSON.stringify(value));
      return value;
    } catch {
      return cached || null;
    } finally {
      pending = null;
    }
  })();
  return pending;
}
export async function publicStats() {
  const a = await analytics();
  const published = db()
    .prepare(
      "SELECT type,count(*) count FROM posts WHERE status='published' AND published_at<=? GROUP BY type",
    )
    .all(now());
  const allowed = new Set(
    (
      db()
        .prepare(
          "SELECT slug FROM posts WHERE status='published' AND published_at<=?",
        )
        .all(now()) as any[]
    ).map((p) => '/posts/' + p.slug),
  );
  return {
    editorial: published,
    tags: tags(),
    popular: (a?.pages || [])
      .filter((p: any) => allowed.has(p.x))
      .slice(0, 10)
      .map((p: any) => ({ path: p.x, views: p.y })),
    updated_at: a?.updated_at || null,
  };
}
