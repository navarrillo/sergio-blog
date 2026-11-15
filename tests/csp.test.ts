import { test, expect } from 'vitest';
import { serializeJsonLd, scriptHash, permissionsPolicy } from '../src/lib/csp';
import { assertScriptPolicy } from './csp';
test('JSON-LD round-trips closing-script text and its exact bytes have a CSP hash', () => {
  const headline = '</script><script>alert(1)</script><p> & café';
  const source = serializeJsonLd({ headline });
  expect(source).not.toContain('<');
  expect(source).toContain('\\u003c/script>');
  expect(JSON.parse(source).headline).toBe(headline);
  expect(() =>
    assertScriptPolicy(
      `<script type="application/ld+json">${source}</script>`,
      `script-src 'self' ${scriptHash(source)}`,
      'JSON-LD',
    ),
  ).not.toThrow();
});
test('permissions policy allows passkey create and get on this origin', () => {
  expect(permissionsPolicy).toContain('publickey-credentials-get=(self)');
  expect(permissionsPolicy).toContain('publickey-credentials-create=(self)');
  expect(permissionsPolicy).toContain('camera=()');
});
test('build guard rejects executable inline scripts without a matching hash', () => {
  expect(() =>
    assertScriptPolicy(
      '<script>alert(1)</script>',
      "script-src 'self'",
      'regression',
    ),
  ).toThrow('inline script');
  expect(() =>
    assertScriptPolicy(
      '<script>alert(1)</script>',
      `script-src 'self' ${scriptHash('different')}`,
      'regression',
    ),
  ).toThrow('inline script');
  expect(() =>
    assertScriptPolicy(
      '<script type="module" src="/_astro/editor.js"></script>',
      "script-src 'self'",
      'external',
    ),
  ).not.toThrow();
});
