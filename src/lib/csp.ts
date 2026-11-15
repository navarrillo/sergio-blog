import { createHash } from 'node:crypto';

export function serializeJsonLd(value: unknown) {
  // Keep the JSON value intact while preventing an HTML raw-text closing tag.
  return JSON.stringify(value).replaceAll('<', '\\u003c');
}
export function scriptHash(source: string) {
  return `'sha256-${createHash('sha256').update(source).digest('base64')}'`;
}
export const permissionsPolicy =
  'camera=(), microphone=(), geolocation=(), publickey-credentials-get=(self), publickey-credentials-create=(self)';
