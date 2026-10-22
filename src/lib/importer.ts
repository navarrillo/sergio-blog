import { unzipSync } from 'fflate';
import { db, transaction } from './db';
import { now } from './config';
import { safeURL, savePost } from './content';
import { storeImage } from './media';
export function parseArchive(text: string) {
  const cleaned = text
    .replace(/^\s*window\.YTD\.(?:tweets|tweet)\.part\d+\s*=\s*/, '')
    .replace(/;\s*$/, '');
  const data = JSON.parse(cleaned);
  if (!Array.isArray(data) || data.length > 50000)
    throw new Error('Expected an array of up to 50,000 posts');
  return data;
}
export async function importArchive(bytes: Uint8Array, zip = false) {
  let rows: any[];
  let files: Record<string, Uint8Array> = {};
  if (zip) {
    let size = 0;
    files = unzipSync(bytes, {
      filter: (e) => {
        size += e.originalSize;
        if (size > 128 * 1024 * 1024 || e.originalSize > 32 * 1024 * 1024)
          throw new Error('Archive expands beyond 128 MB');
        return /(?:tweets?\.js|tweets?\.json|\.(?:jpg|jpeg|png|webp))$/i.test(
          e.name,
        );
      },
    });
    const entry = Object.entries(files).find(([name]) =>
      /(^|\/)(tweets?\.js|tweets?\.json)$/.test(name),
    );
    if (!entry) throw new Error('No tweets.js or tweets.json found');
    rows = parseArchive(Buffer.from(entry[1]).toString());
  } else rows = parseArchive(Buffer.from(bytes).toString());
  let imported = 0,
    duplicates = 0;
  const errors: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    try {
      const original = rows[i].tweet || rows[i];
      const id = String(original.id_str || original.id || '');
      const text = original.full_text || original.text;
      const date = new Date(original.created_at || original.date);
      if (
        !/^\d{1,30}$/.test(id) ||
        typeof text !== 'string' ||
        text.length > 200000 ||
        !Number.isFinite(+date)
      )
        throw new Error('Missing ID, text or valid date');
      if (db().prepare('SELECT id FROM x_imports WHERE id=?').get(id)) {
        duplicates++;
        continue;
      }
      const media: string[] = [];
      for (const item of original.extended_entities?.media || []) {
        const filename = String(item.media_url_https || '')
          .split('/')
          .at(-1);
        const entry = Object.entries(files).find(
          ([name]) =>
            name.endsWith('/' + id + '-' + filename) ||
            name.endsWith('/' + filename),
        );
        if (entry) {
          try {
            media.push(await storeImage(entry[1]));
          } catch {
            errors.push(`Row ${i + 1}: invalid media`);
          }
        } else errors.push(`Row ${i + 1}: local media missing`);
      }
      db()
        .prepare(
          'INSERT INTO x_imports(id,original,text,date,url,media,created_at) VALUES(?,?,?,?,?,?,?)',
        )
        .run(
          id,
          JSON.stringify(original),
          text,
          date.toISOString(),
          safeURL.parse(original.url || `https://x.com/i/status/${id}`),
          JSON.stringify(media),
          now(),
        );
      imported++;
    } catch (e) {
      errors.push(
        `Row ${i + 1}: ${e instanceof Error ? e.message : 'invalid data'}`,
      );
    }
  }
  return { imported, duplicates, errors };
}
export function convertImports(
  ids: string[],
  type: 'article' | 'note' | 'x_post',
  title: string,
) {
  return transaction(() => {
    const rows = ids.map(
      (id) => db().prepare('SELECT * FROM x_imports WHERE id=?').get(id) as any,
    );
    if (!rows.length || rows.some((r) => !r || r.post_id))
      throw new Error('Choose unconverted inbox items');
    rows.sort((a, b) => a.date.localeCompare(b.date));
    const first = rows[0];
    const body = rows
      .map(
        (r) =>
          r.text +
          '\n\n' +
          JSON.parse(r.media)
            .map((p: string) => `![Imported attachment](${p})`)
            .join('\n'),
      )
      .join('\n\n---\n\n');
    // The outer transaction atomically preserves the source-to-draft association.
    return { rows, body, first, type, title };
  });
}
export function createImportedDraft(
  ids: string[],
  type: 'article' | 'note' | 'x_post',
  title: string,
) {
  return transaction(() => {
    const { rows, body, first } = convertImports(ids, type, title);
    const id = savePost({
      title,
      slug: 'x-' + first.id,
      body,
      type,
      status: 'draft',
      source_url: first.url,
      published_at: first.date,
    });
    for (const row of rows)
      db()
        .prepare(
          'UPDATE x_imports SET post_id=? WHERE id=? AND post_id IS NULL',
        )
        .run(id, row.id);
    return id;
  });
}
