import type { APIRoute } from 'astro';
import { z } from 'zod';
import { FormBodyError, readFormBody, loginFields } from '../../../lib/forms';
import { login, allow, cookieName, csrfValid } from '../../../lib/auth';
import { config } from '../../../lib/config';
import { db, setSetting, transaction } from '../../../lib/db';
import { renderMarkdown, safeURL, imageURL } from '../../../lib/content';
import { storeImage } from '../../../lib/media';
import { mediaLibrary } from '../../../lib/media';
import {
  changeTag,
  EditorialError,
  postAction,
  restoreWorkingRevision,
  saveWorking,
  setPinned,
  visibility,
} from '../../../lib/editorial';
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
  const json = request.headers.get('accept')?.includes('application/json');
  const back = (value: string, fallback = '/admin') =>
    value.startsWith('/admin?') ||
    value === '/admin' ||
    value.startsWith('/admin/inbox?')
      ? value
      : fallback;
  const success = (url: string, data: Record<string, unknown> = {}) =>
    json
      ? Response.json({ ok: true, redirect: url, ...data })
      : redirect(url, 303);
  if (Number(request.headers.get('content-length') || 0) > 33 * 1024 * 1024)
    return new Response('Request too large', { status: 413 });
  try {
    const form = await readFormBody(request);
    if (
      !csrfValid(request, locals.session.csrf, String(form.get('csrf') || ''))
    )
      return new Response('Forbidden', { status: 403 });
    const textValues = form.has('text_values')
      ? z
          .partialRecord(
            z.enum(['body', 'summary', 'bio', 'description', 'text']),
            z.string(),
          )
          .parse(JSON.parse(String(form.get('text_values'))))
      : {};
    const str = (key: string) =>
      (textValues as Record<string, string>)[key] ??
      String(form.get(key) || '');
    const id = Number(str('id')) || undefined;
    if (action === 'logout') {
      db()
        .prepare('DELETE FROM sessions WHERE token=?')
        .run(locals.session.token);
      cookies.delete(cookieName(), { path: '/' });
      return redirect('/admin/login', 303);
    }
    if (action === 'post') {
      const intent = str('intent') || 'save';
      if (form.has('status'))
        throw new EditorialError('Use an explicit publication action.');
      if (!['save', 'autosave'].includes(intent))
        throw new EditorialError('Unknown save action');
      const post = saveWorking(
        {
          title: str('title'),
          slug: str('slug'),
          summary: str('summary'),
          body: str('body'),
          type: str('type'),
          tags: str('tags')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
          image: str('image'),
          source_url: str('source_url'),
        },
        id,
        Number(str('version')),
        intent === 'autosave',
        str('request_key') ? z.uuid().parse(str('request_key')) : undefined,
      );
      return success('/admin/edit?id=' + post!.id + '&saved=1', {
        id: post!.id,
        version: post!.edit_version,
        updated_at: post!.working_updated_at,
        label: visibility(post),
        status: post!.status,
        slug: post!.slug,
        creation_replayed: post!.creation_replayed || false,
      });
    }
    if (action === 'post-action') {
      const post = postAction(
        z.coerce.number().int().positive().parse(id),
        str('intent'),
        Number(str('version')),
        str('scheduled_at'),
      );
      return success(
        back(str('return_to'), '/admin/edit?id=' + post.id + '&saved=1'),
        {
          id: post.id,
          version: post.edit_version,
          label: visibility(post),
          status: post.status,
          slug: post.slug,
          published_at: post.published_at,
        },
      );
    }
    if (action === 'pin') {
      setPinned(
        z.coerce.number().int().positive().parse(id),
        str('pinned') === '1',
      );
      return success(back(str('return_to')), { pinned: str('pinned') === '1' });
    }
    if (action === 'bulk') {
      const ids = z
        .array(z.coerce.number().int().positive())
        .min(1)
        .max(20)
        .parse(form.getAll('selected'));
      const intent = z
        .enum(['pin', 'unpin', 'trash', 'restore'])
        .parse(str('intent'));
      transaction(() => {
        for (const postId of ids) {
          if (intent === 'pin' || intent === 'unpin')
            setPinned(postId, intent === 'pin');
          else postAction(postId, intent, Number(str('version_' + postId)));
        }
      });
      return success(back(str('return_to')));
    }
    if (action === 'revision') {
      const post = restoreWorkingRevision(
        z.coerce.number().int().positive().parse(id),
        Number(str('revision')),
        Number(str('version')),
      )!;
      return success('/admin/edit?id=' + id + '&saved=1', {
        version: post.edit_version,
      });
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
      const count = changeTag(str('old'), str('new'));
      return success('/admin/tags?saved=1', {
        message: `Updated tags on ${count} posts.`,
      });
    }
    if (action === 'settings') {
      const values: Record<string, string> = {};
      const links = form
        .getAll('link_label')
        .map((label, i) => ({
          label: String(label).trim(),
          url: String(form.getAll('link_url')[i] || '').trim(),
        }));
      const linkErrors: Record<string, string> = {};
      links.forEach((link, i) => {
        if (!link.label && !link.url) return;
        if (!link.label || link.label.length > 100)
          linkErrors[`link_label[${i}]`] = 'Add a label of 1–100 characters.';
        if (!link.url || !safeURL.safeParse(link.url).success)
          linkErrors[`link_url[${i}]`] = 'Add an http(s) URL.';
      });
      if (Object.keys(linkErrors).length)
        throw new EditorialError(
          'Complete the highlighted profile links.',
          400,
          linkErrors,
        );
      for (const key of [
        'bio',
        'photo',
        'site_title',
        'description',
        'links',
      ]) {
        const value =
          key === 'links' && form.has('link_label')
            ? JSON.stringify(links.filter((link) => link.label || link.url))
            : str(key);
        if (key === 'photo') imageURL.parse(value);
        if (key === 'links')
          z.array(z.object({ label: z.string().max(100), url: safeURL }))
            .max(20)
            .parse(JSON.parse(value || '[]'));
        if (value.length > 10000) throw new Error('Setting too long');
        values[key] = value;
      }
      transaction(() => {
        for (const [key, value] of Object.entries(values))
          setSetting(key, value);
      });
      return success('/admin/settings?saved=1', { message: 'Settings saved.' });
    }
    if (action === 'project') {
      const p = z
        .object({
          name: z.string().trim().min(1).max(200),
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
      return success('/admin/projects?saved=1', { message: 'Project saved.' });
    }
    if (action === 'delete-project') {
      db().prepare('DELETE FROM projects WHERE id=?').run(id!);
      return success('/admin/projects?saved=1');
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
      return success('/admin/inbox?imported=1');
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
      return success('/admin/inbox', { message: 'Added to private inbox.' });
    }
    if (action === 'convert') {
      const type = z.enum(['article', 'note', 'x_post']).parse(str('type'));
      const postId = createImportedDraft(
        form.getAll('selected').map(String),
        type,
        z.string().min(1).max(240).parse(str('title')),
      );
      return success('/admin/edit?id=' + postId);
    }
    return new Response('Not found', { status: 404 });
  } catch (error) {
    if (error instanceof FormBodyError)
      return new Response('Invalid input', { status: error.status });
    if (json) {
      const fields: Record<string, string> =
        error instanceof EditorialError ? error.fields : {};
      if (error instanceof z.ZodError)
        for (const issue of error.issues)
          fields[String(issue.path[0] || 'form')] = issue.message;
      return Response.json(
        {
          error:
            error instanceof z.ZodError
              ? 'Check the highlighted fields.'
              : error instanceof Error
                ? error.message
                : 'Request failed',
          fields,
        },
        { status: error instanceof EditorialError ? error.status : 400 },
      );
    }
    return new Response(
      error instanceof z.ZodError
        ? 'Invalid input'
        : error instanceof Error
          ? error.message
          : 'Request failed',
      { status: error instanceof EditorialError ? error.status : 400 },
    );
  }
};
export const GET: APIRoute = async ({ params, url, locals }) => {
  if (!locals.session) return new Response('Unauthorized', { status: 401 });
  if (params.action === 'session')
    return Response.json({ csrf: locals.session.csrf });
  if (params.action === 'media') return Response.json(await mediaLibrary());
  if (params.action === 'revision') {
    const revision = db()
      .prepare(
        'SELECT snapshot,created_at,kind FROM revisions WHERE id=? AND post_id=?',
      )
      .get(
        Number(url.searchParams.get('revision')),
        Number(url.searchParams.get('id')),
      );
    return revision
      ? Response.json(revision)
      : new Response('Revision not found', { status: 404 });
  }
  return new Response('Not found', { status: 404 });
};
