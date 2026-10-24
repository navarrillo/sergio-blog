import assert from 'node:assert/strict';
import { parse } from 'parse5';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';

export function assertScriptPolicy(html: string, csp: string, label: string) {
  assert(
    !csp.includes("'unsafe-inline'"),
    label + ': unsafe-inline is forbidden',
  );
  const policy = csp
    .split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith('script-src '));
  assert(policy, label + ': missing script-src');
  const scripts: { attributes: Record<string, string>; body: string }[] = [];
  let inlineStyle = false;
  function visit(node: any) {
    if (node.tagName === 'script')
      scripts.push({
        attributes: Object.fromEntries(
          node.attrs.map((attr: any) => [attr.name, attr.value]),
        ),
        body: (node.childNodes || [])
          .map((child: any) => child.value || '')
          .join(''),
      });
    if (node.tagName === 'style') inlineStyle = true;
    for (const child of node.childNodes || []) visit(child);
    if (node.content) visit(node.content);
  }
  visit(parse(html));
  for (const { attributes, body } of scripts) {
    if ('src' in attributes) continue;
    if (!body.trim()) continue;
    const authorized = ['sha256', 'sha384', 'sha512'].some((algorithm) =>
      policy.includes(
        `'${algorithm}-${createHash(algorithm).update(body).digest('base64')}'`,
      ),
    );
    assert(
      authorized,
      label +
        ': inline script is not covered by its CSP hash: ' +
        JSON.stringify({ body, policy }),
    );
  }
  assert(!inlineStyle, label + ': build must emit stylesheets externally too');
  return scripts;
}
export async function assertBuiltHtml(directory = 'dist/client') {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const filename = directory + '/' + item.name;
    if (item.isDirectory()) await assertBuiltHtml(filename);
    else if (filename.endsWith('.html')) {
      const html = await readFile(filename, 'utf8');
      // Static pages must carry a meta policy if they need hashes; bare script is forbidden.
      const csp =
        html.match(
          /<meta[^>]*http-equiv="Content-Security-Policy"[^>]*content="([^"]*)"/i,
        )?.[1] || "script-src 'self'";
      assertScriptPolicy(html, csp, filename);
    }
  }
}
