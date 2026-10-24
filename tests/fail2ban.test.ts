import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
test('fail2ban fixtures cover bearer failures and ignore successful/quota requests', () => {
  const filter = readFileSync(
    new URL('../deploy/fail2ban/blog.conf', import.meta.url),
    'utf8',
  );
  const expressions = filter
    .split('failregex = ')[1]
    .split('ignoreregex')[0]
    .trim()
    .split('\n')
    .map(
      (line) =>
        new RegExp(line.trim().replace('<HOST>', '(?<ip>[0-9a-fA-F.:]+)')),
    );
  const lines = readFileSync(
    new URL('../deploy/fail2ban/examples.log', import.meta.url),
    'utf8',
  )
    .trim()
    .split('\n');
  const matches = lines.filter((line) =>
    expressions.some((pattern) => pattern.test(line)),
  );
  expect(matches).toHaveLength(3);
  expect(
    matches.every(
      (line) =>
        !line.includes('"status":303') && !line.includes('"status":429'),
    ),
  ).toBe(true);
});
