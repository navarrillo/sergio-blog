import type { APIRoute } from 'astro';
import { zipSync, strToU8 } from 'fflate';
import { readdir, readFile } from 'node:fs/promises';
import { db } from '../../../lib/db';
import { config } from '../../../lib/config';
export const GET: APIRoute = async () => {
  const posts = db().prepare('SELECT * FROM posts').all() as any[];
  const files: Record<string, Uint8Array> = {
    'content.json': strToU8(
      JSON.stringify(
        {
          version: 1,
          posts,
          projects: db().prepare('SELECT * FROM projects').all(),
          settings: db()
            .prepare("SELECT * FROM settings WHERE key<>'analytics_cache'")
            .all(),
          revisions: db().prepare('SELECT * FROM revisions').all(),
          redirects: db().prepare('SELECT * FROM redirects').all(),
          x_imports: db().prepare('SELECT * FROM x_imports').all(),
        },
        null,
        2,
      ),
    ),
  };
  for (const p of posts)
    files[`posts/${p.slug}.md`] = strToU8(
      `---\nmetadata: ${JSON.stringify({ ...p, body: undefined })}\n---\n\n${p.body}`,
    );
  for (const name of await readdir(config.uploads).catch(() => [])) {
    if (/^[a-f0-9-]+\.webp$/.test(name))
      files['uploads/' + name] = new Uint8Array(
        await readFile(config.uploads + '/' + name),
      );
  }
  return new Response(new Uint8Array(zipSync(files)), {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': 'attachment; filename="blog-export.zip"',
      'Cache-Control': 'no-store',
    },
  });
};
