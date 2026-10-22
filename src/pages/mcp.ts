import type { APIRoute } from 'astro';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { queryPosts, getPost, tags, projects } from '../lib/content';
import { config } from '../lib/config';
export const POST: APIRoute = async ({ request }) => {
  if (
    request.headers.has('origin') &&
    request.headers.get('origin') !== config.origin
  )
    return new Response('Forbidden', { status: 403 });
  const server = new McpServer({ name: 'sergio-blog', version: '0.1.0' });
  const result = (data: unknown) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(data) }],
  });
  server.registerTool(
    'search_posts',
    {
      description:
        'Search published posts. Use get_post to read the full text.',
      inputSchema: {
        q: z.string().max(300).optional(),
        tag: z.string().optional(),
        type: z.enum(['article', 'note', 'x_post']).optional(),
        since: z.string().optional(),
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async (input) => {
      const p = new URLSearchParams(
        Object.entries(input).map(([k, v]) => [k, String(v)]),
      );
      const found = queryPosts(p);
      return result({
        ...found,
        items: found.items.map(({ body: _body, ...post }: any) => post),
      });
    },
  );
  server.registerTool(
    'get_post',
    {
      description: 'Read a published post by slug.',
      inputSchema: { slug: z.string() },
    },
    async ({ slug }) => {
      const post = getPost(slug);
      return post
        ? result(post)
        : { ...result({ error: 'Not found' }), isError: true };
    },
  );
  server.registerTool(
    'list_tags',
    { description: 'List tags with published post counts.', inputSchema: {} },
    async () => result(tags()),
  );
  server.registerTool(
    'list_projects',
    { description: 'List public projects.', inputSchema: {} },
    async () => result(projects()),
  );
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    await server.close();
  }
};
export const GET: APIRoute = () =>
  new Response('Streamable HTTP: send POST requests.', {
    status: 405,
    headers: { Allow: 'POST' },
  });
export const DELETE = GET;
