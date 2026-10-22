import type { APIRoute } from 'astro';
import { queryPosts } from '../lib/content';
import { config } from '../lib/config';
export const GET: APIRoute = () =>
  new Response(
    `# Sergio Navarro\n\nPublished articles and notes.\n\n- API: ${config.origin}/api\n- MCP: ${config.origin}/mcp\n\n## Recent posts\n${queryPosts(
      new URLSearchParams({ limit: '100' }),
    )
      .items.map(
        (p) =>
          `- [${p.title.replaceAll('\n', ' ')}](${config.origin}/api/v1/posts/${p.slug}.md): ${p.summary.replaceAll('\n', ' ')}`,
      )
      .join('\n')}`,
    { headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
  );
