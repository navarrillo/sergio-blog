import type { APIRoute } from 'astro';
import { z } from 'zod';
import { FormBodyError, readFormBody, loginFields } from '../../../lib/forms';
import { login, allow, cookieName, csrfValid } from '../../../lib/auth';
import { config } from '../../../lib/config';
import { db, setSetting, transaction } from '../../../lib/db';
import {
  savePost,
  getDraft,
  restoreRevision,
  renderMarkdown,
  safeURL,
  imageURL,
} from '../../../lib/content';
import { storeImage } from '../../../lib/media';
import { importArchive, createImportedDraft } from '../../../lib/importer';
export const POST: APIRoute = async ({
  request,
  params,
  locals,
  cookies,
  redirect,
}) => {
  const action = params.action;
  if (action === 'login') {
    if (!allow('login:' + locals.ip, 6, 600000))
      return new Response('Unable to sign in', {
        status: 429,
        headers: { 'Retry-After': '600' },
      });
    let fields;
    try {
      fields = loginFields(await readFormBody(request));
    } catch (error) {
      if (error instanceof FormBodyError)
        return new Response('Unable to sign in', { status: error.status });
      throw error;
    }
    if (request.headers.get('origin') !== config.origin)
      return new Response('Unable to sign in', { status: 401 });
    const token = await login(fields.password, fields.code);
    if (!token) return new Response('Unable to sign in', { status: 401 });
    cookies.set(cookieName(), token, {
      path: '/',
      secure: config.secure,
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 43200,
    });
    return redirect('/admin', 303);
  }
  if (!locals.session) return new Response('Unauthorized', { status: 401 });
  if (Number(request.headers.get('content-length') || 0) > 33 * 1024 * 1024)
    return new Response('Request too large', { status: 413 });
  try {
    const form = await readFormBody(request);
    if (
      !csrfValid(request, locals.session.csrf, String(form.get('csrf') || ''))
    )
      return new Response('Forbidden', { status: 403 });
    const str = (key: string) => String(form.get(key) || '');
    const id = Number(str('id')) || undefined;
    if (action === 'logout') {
      db()
        .prepare('DELETE FROM sessions WHERE token=?')
        .run(locals.session.token);
      cookies.delete(cookieName(), { path: '/' });
      return redirect('/admin/login', 303);
    }
    if (action === 'post') {
      const postId = savePost(
        {
          title: str('title'),
          slug: str('slug'),
          summary: str('summary'),
          body: str('body'),
          type: str('type'),
          status: str('status'),
          tags: str('tags')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
          image: str('image'),
          source_url: str('source_url'),
          featured: form.has('featured'),
          published_at: str('published_at')
            ? new Date(str('published_at')).toISOString()
            : undefined,
        },
        id,
      );
      return redirect('/admin/edit?id=' + postId + '&saved=1', 303);
    }
    if (action === 'revision') {
      restoreRevision(id!, Number(str('revision')));
      return redirect('/admin/edit?id=' + id, 303);
    }
    if (action === 'preview')
      return new Response(renderMarkdown(str('body')), {
        headers: { 'Content-Type': 'text/html' },
      });
    if (action === 'upload') {
      const file = form.get('file');
      if (!(file instanceof File)) throw new Error('Choose an image');
      const path = await storeImage(new Uint8Array(await file.arrayBuffer()));
      return Response.json({ path });
    }
    if (action === 'rename-tag') {
      const old = z
        .string()
        .regex(/^[a-z0-9-]+$/)
        .parse(str('old'));
      const replacement = z
        .string()
        .regex(/^[a-z0-9-]*$/)
        .parse(str('new'));
      transaction(() => {
        for (const row of db()
          .prepare(
            'SELECT id FROM posts WHERE EXISTS(SELECT 1 FROM json_each(tags) WHERE value=?)',
          )
          .all(old) as any[]) {
          const p = getDraft(row.id);
          savePost(
            {
              ...p,
              tags: [
                ...new Set(
                  p.tags.flatMap((t: string) =>
                    t === old ? (replacement ? [replacement] : []) : [t],
                  ),
                ),
              ],
            },
            row.id,
          );
        }
      });
      return redirect('/admin/tags', 303);
    }
    if (action === 'settings') {
      for (const key of [
        'bio',
        'photo',
        'site_title',
        'description',
        'links',
      ]) {
        const value = str(key);
        if (key === 'photo') imageURL.parse(value);
        if (key === 'links')
          z.array(z.object({ label: z.string().max(100), url: safeURL }))
            .max(20)
            .parse(JSON.parse(value || '[]'));
        if (value.length > 10000) throw new Error('Setting too long');
        setSetting(key, value);
      }
      return redirect('/admin/settings?saved=1', 303);
    }
    if (action === 'project') {
      const p = z
        .object({
          name: z.string().min(1).max(200),
          description: z.string().max(2000),
          image: imageURL,
          status: z.enum(['active', 'completed', 'paused']),
          url: safeURL,
          source_url: safeURL,
        })
        .parse(
          Object.fromEntries(
            ['name', 'description', 'image', 'status', 'url', 'source_url'].map(
              (k) => [k, str(k)],
            ),
          ),
        );
      const values = [
        p.name,
        p.description,
        p.image,
        p.status,
        p.url,
        p.source_url,
      ];
      if (id)
        db()
          .prepare(
            'UPDATE projects SET name=?,description=?,image=?,status=?,url=?,source_url=? WHERE id=?',
          )
          .run(...values, id);
      else
        db()
          .prepare(
            'INSERT INTO projects(name,description,image,status,url,source_url) VALUES(?,?,?,?,?,?)',
          )
          .run(...values);
      return redirect('/admin/projects', 303);
    }
    if (action === 'delete-project') {
      db().prepare('DELETE FROM projects WHERE id=?').run(id!);
      return redirect('/admin/projects', 303);
    }
    if (action === 'import') {
      const file = form.get('file');
      if (!(file instanceof File) || file.size > 32 * 1024 * 1024)
        throw new Error('Choose an archive up to 32 MB');
      const result = await importArchive(
        new Uint8Array(await file.arrayBuffer()),
        file.name.endsWith('.zip'),
      );
      setSetting('import_report', JSON.stringify(result));
      return redirect('/admin/inbox?imported=1', 303);
    }
    if (action === 'manual-x') {
      await importArchive(
        Buffer.from(
          JSON.stringify([
            {
              id_str: z
                .string()
                .regex(/^\d{1,30}$/)
                .parse(str('x_id')),
              full_text: str('text'),
              url: safeURL.parse(str('url')),
              created_at: str('date'),
            },
          ]),
        ),
      );
      return redirect('/admin/inbox', 303);
    }
    if (action === 'convert') {
      const type = z.enum(['article', 'note', 'x_post']).parse(str('type'));
      const postId = createImportedDraft(
        form.getAll('selected').map(String),
        type,
        z.string().min(1).max(240).parse(str('title')),
      );
      return redirect('/admin/edit?id=' + postId, 303);
    }
    return new Response('Not found', { status: 404 });
  } catch (error) {
    if (error instanceof FormBodyError)
      return new Response('Invalid input', { status: error.status });
    return new Response(
      error instanceof z.ZodError
        ? 'Invalid input'
        : error instanceof Error
          ? error.message
          : 'Request failed',
      { status: 400 },
    );
  }
};
