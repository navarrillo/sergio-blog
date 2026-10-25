import { marked, type Token } from 'marked';

// Only remove the exact wrapper emitted by the old Astro templates. Interior
// indentation, fenced code, leading newlines and ordinary indented code stay intact.
export function repairEditorIndentation(source: string) {
  let result = source;
  let removed = 0;
  for (;;) {
    const pair = [
      [18, 16],
      [16, 14],
    ].find(
      ([start, end]) =>
        result.startsWith(' '.repeat(start)) &&
        result.endsWith('\n' + ' '.repeat(end)),
    );
    if (!pair) break;
    const suffix =
      (result.endsWith('\r\n' + ' '.repeat(pair[1])) ? '\r\n' : '\n') +
      ' '.repeat(pair[1]);
    result = result.slice(pair[0], -suffix.length);
    removed++;
  }
  return { text: result, removed };
}
export function sourceRequiresMarkdown(source: string): boolean {
  let unsupported = false;
  const tokens = marked.lexer(source);
  marked.walkTokens(tokens, (token: Token) => {
    if (token.type === 'html') unsupported = true;
  });
  return unsupported;
}

// Compare rendered structure before entering visual mode. A converter that drops
// syntax must fall back to source editing rather than silently damaging a draft.
export function equivalentMarkdown(first: string, second: string) {
  const normalize = (markdown: string) => {
    const document = new DOMParser().parseFromString(
      marked.parse(markdown, { async: false }) as string,
      'text/html',
    );
    const visit = (node: Node): unknown => {
      if (node.nodeType === Node.TEXT_NODE) {
        if (
          !node.textContent?.trim() &&
          !['PRE', 'CODE'].includes(node.parentElement?.tagName || '')
        )
          return null;
        return node.textContent;
      }
      if (!(node instanceof Element)) return null;
      // Tiptap's Markdown table serializer may use a single tbody for header rows.
      const attributes = [...node.attributes]
        .map((a) => [a.name, a.value])
        .sort((a, b) => a[0].localeCompare(b[0]));
      return [
        node.tagName,
        attributes,
        [...node.childNodes].map(visit).filter((n) => n !== null),
      ];
    };
    return JSON.stringify(
      [...document.body.childNodes].map(visit).filter((n) => n !== null),
    );
  };
  return normalize(first) === normalize(second);
}
