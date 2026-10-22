import type { APIRoute } from 'astro';
import {
  queryPosts,
  getPost,
  tags,
  projects,
  plain,
} from '../../../lib/content';
import { publicStats } from '../../../lib/analytics';
export const GET: APIRoute = async ({ params, url }) => {
  try {
    const path = params.path || '';
    if (path === 'posts') {
      const result = queryPosts(url.searchParams);
      return Response.json({
        ...result,
        items: result.items.map(({ body: _body, ...post }: any) => post),
      });
    }
    if (path === 'tags') return Response.json(tags());
    if (path === 'projects') return Response.json(projects());
    if (path === 'stats') return Response.json(await publicStats());
    if (path.startsWith('posts/')) {
      const slug = path.slice(6).replace(/\.(md|txt)$/, '');
      const post = getPost(slug);
      if (!post) return Response.json({ error: 'Not found' }, { status: 404 });
      if (path.endsWith('.md'))
        return new Response(post.body, {
          headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
        });
      if (path.endsWith('.txt'))
        return new Response(plain(post.body), {
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      return Response.json(post);
    }
    return Response.json({ error: 'Not found' }, { status: 404 });
  } catch {
    return Response.json({ error: 'Invalid query' }, { status: 400 });
  }
};
