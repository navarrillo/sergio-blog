import type { APIRoute } from 'astro';
import { db } from '../lib/db';
import { config, now } from '../lib/config';
import { xml } from './rss.xml';
export const GET: APIRoute = () =>
  new Response(
    `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${['/', '/posts', '/projects', '/stats', '/api', ...(db().prepare("SELECT slug FROM posts WHERE status='published' AND published_at<=?").all(now()) as any[]).map((p) => '/posts/' + p.slug)].map((p) => `<url><loc>${xml(config.origin + p)}</loc></url>`).join('')}</urlset>`,
    { headers: { 'Content-Type': 'application/xml' } },
  );
