import type { APIRoute } from 'astro';
import { db } from '../lib/db';
export const GET: APIRoute = () => {
  try {
    db().prepare('SELECT count(*) FROM posts').get();
    return Response.json({ status: 'ok' });
  } catch {
    return Response.json({ status: 'unavailable' }, { status: 503 });
  }
};
