import type { APIRoute } from 'astro';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../../lib/config';
import { uploadPathPattern } from '../../lib/upload-path.mjs';

export const GET: APIRoute = async ({ params }) => {
  if (!uploadPathPattern.test('/uploads/' + (params.name || '')))
    return new Response('Not found', { status: 404 });
  let file;
  try {
    file = await open(path.join(config.uploads, params.name!), constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!(await file.stat()).isFile()) return new Response('Not found', {status:404});
    return new Response(new Uint8Array(await file.readFile()), {
      headers: {
        'Content-Type': 'image/webp',
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch {
    return new Response('Not found', { status: 404 });
  } finally {
    await file?.close();
  }
};
