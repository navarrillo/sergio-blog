import type { APIRoute } from 'astro';
import { queryPosts } from '../lib/content';
import { config } from '../lib/config';
export const xml = (s: string) =>
  s.replace(
    /[<>&"']/g,
    (c) =>
      ({
        '<': '&lt;',
        '>': '&gt;',
        '&': '&amp;',
        '"': '&quot;',
        "'": '&apos;',
      })[c]!,
  );
export const GET: APIRoute = ({ url }) => {
  const p = new URLSearchParams({ limit: '100' });
  if (url.searchParams.get('type') === 'article') p.set('type', 'article');
  const posts = queryPosts(p).items;
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Sergio Navarro</title><link>${xml(config.origin)}</link><description>Articles and notes</description>${posts.map((p) => `<item><title>${xml(p.title)}</title><link>${xml(config.origin + '/posts/' + p.slug)}</link><guid>${xml(config.origin + '/posts/' + p.slug)}</guid><description>${xml(p.summary)}</description><pubDate>${new Date(p.published_at).toUTCString()}</pubDate></item>`).join('')}</channel></rss>`,
    { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' } },
  );
};
