import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import argon2 from 'argon2';
import { db, transaction } from './db';
import { config, now } from './config';
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function newTotpSecret() {
  return Array.from(randomBytes(32), (b) => alphabet[b % 32]).join('');
}
function unbase32(secret: string) {
  let bits = '';
  for (const c of secret)
    bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  return Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
}
export function totp(secret: string, step = Math.floor(Date.now() / 30000)) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', unbase32(secret)).update(counter).digest();
  const offset = h.at(-1)! & 15;
  return String((h.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(
    6,
    '0',
  );
}
export function validTotp(secret: string, code: string, last = 0) {
  if (!/^\d{6}$/.test(code)) return null;
  const current = Math.floor(Date.now() / 30000);
  for (const step of [current - 1, current, current + 1])
    if (
      step > last &&
      timingSafeEqual(Buffer.from(totp(secret, step)), Buffer.from(code))
    )
      return step;
  return null;
}
export function clientIP(
  peer: string,
  headers: Headers,
  trusted = config.trusted,
) {
  peer = peer.replace(/^::ffff:/, '');
  if (!trusted.includes(peer)) return peer;
  const forwarded = (
    headers.get('x-forwarded-for') ||
    headers.get('x-real-ip') ||
    ''
  )
    .split(',')
    .map((v) => v.trim().replace(/^::ffff:/, ''));
  if (!forwarded.length || forwarded.some((ip) => !isIP(ip))) return peer;
  for (const ip of forwarded.reverse()) if (!trusted.includes(ip)) return ip;
  return peer;
}
export function allow(key: string, max: number, windowMs = 60000) {
  return transaction(() => {
    const time = Date.now();
    db().prepare('DELETE FROM limits WHERE reset<=?').run(time);
    const row = db()
      .prepare('SELECT count FROM limits WHERE key=?')
      .get(key) as any;
    if (!row) {
      db()
        .prepare('INSERT INTO limits VALUES(?,1,?)')
        .run(key, time + windowMs);
      return true;
    }
    if (row.count >= max) return false;
    db().prepare('UPDATE limits SET count=count+1 WHERE key=?').run(key);
    return true;
  });
}
const digest = (token: string) =>
  createHmac(
    'sha256',
    process.env.SESSION_SECRET || 'local-development-session',
  )
    .update(token)
    .digest('hex');
export const cookieName = () =>
  config.secure ? '__Host-blog_session' : 'blog_dev_session';
export function session(request: Request) {
  const raw = request.headers
    .get('cookie')
    ?.split(';')
    .map((v) => v.trim())
    .find((v) => v.startsWith(cookieName() + '='))
    ?.split('=')[1];
  if (!raw) return null;
  return db()
    .prepare('SELECT * FROM sessions WHERE token=? AND expires>?')
    .get(digest(raw), Date.now()) as {
    token: string;
    csrf: string;
    expires: number;
  } | null;
}
let dummyHash: Promise<string>;
export async function login(password: string, code: string) {
  const admin = db().prepare('SELECT * FROM admin WHERE id=1').get() as any;
  dummyHash ??= argon2.hash(randomBytes(32), { type: argon2.argon2id });
  const correct = await argon2
    .verify(admin?.password_hash || (await dummyHash), password)
    .catch(() => false);
  const step = admin?.totp_secret
    ? validTotp(admin.totp_secret, code, admin.last_totp)
    : null;
  if (!correct || !step) return null;
  return transaction(() => {
    const result = db()
      .prepare('UPDATE admin SET last_totp=? WHERE id=1 AND last_totp<?')
      .run(step, step);
    if (!result.changes) return null;
    const token = randomBytes(32).toString('base64url');
    const csrf = createHmac(
      'sha256',
      process.env.CSRF_SECRET || 'local-development-csrf',
    )
      .update(randomBytes(32))
      .digest('base64url');
    db().prepare('DELETE FROM sessions WHERE expires<=?').run(Date.now());
    db()
      .prepare('INSERT INTO sessions VALUES(?,?,?)')
      .run(digest(token), csrf, Date.now() + 12 * 3600000);
    return token;
  });
}
export function csrfValid(request: Request, csrf: string, provided: string) {
  const origin = request.headers.get('origin');
  return (
    origin === config.origin &&
    csrf.length === provided.length &&
    timingSafeEqual(Buffer.from(csrf), Buffer.from(provided))
  );
}

// Separate key and namespace from browser sessions. Never fall back to a public key.
export function agentTokenHash(token: string) {
  const secret = process.env.AGENT_TOKEN_SECRET;
  if (!secret || Buffer.byteLength(secret) < 32)
    throw new Error('AGENT_TOKEN_SECRET must contain at least 32 bytes');
  return createHmac('sha256', secret)
    .update('blog-agent-v1\0')
    .update(token)
    .digest('hex');
}
export function createAgentToken(name: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9 _.-]{0,63}$/.test(name))
    throw new Error(
      'Use a unique token name of 1–64 letters, digits, spaces, dots, underscores or hyphens',
    );
  const token = 'sbd_' + randomBytes(32).toString('base64url');
  const id = Number(
    db()
      .prepare(
        'INSERT INTO agent_tokens(name,token_hash,created_at) VALUES(?,?,?)',
      )
      .run(name, agentTokenHash(token), now()).lastInsertRowid,
  );
  return { id, token };
}
export function listAgentTokens() {
  return db()
    .prepare(
      'SELECT id,name,created_at,last_used_at,revoked_at FROM agent_tokens ORDER BY id',
    )
    .all();
}
export function revokeAgentToken(nameOrId: string) {
  return db()
    .prepare(
      'UPDATE agent_tokens SET revoked_at=COALESCE(revoked_at,?) WHERE id=(SELECT id FROM agent_tokens WHERE name=? OR CAST(id AS TEXT)=? ORDER BY (name=?) DESC LIMIT 1)',
    )
    .run(now(), nameOrId, nameOrId, nameOrId).changes;
}
export type AgentToken = { id: number; name: string };
export function authenticateAgent(header: string | null): AgentToken | null {
  const match = /^Bearer (sbd_[A-Za-z0-9_-]{43})$/.exec(header || '');
  const hash = agentTokenHash(match?.[1] || 'invalid');
  const row = db()
    .prepare(
      'SELECT id,name,token_hash,revoked_at FROM agent_tokens WHERE token_hash=?',
    )
    .get(hash) as any;
  const equal = timingSafeEqual(
    Buffer.from(hash, 'hex'),
    Buffer.from(row?.token_hash || '0'.repeat(64), 'hex'),
  );
  return match && equal && row && !row.revoked_at
    ? { id: row.id, name: row.name }
    : null;
}
export function retryAfter(key: string) {
  const row = db()
    .prepare('SELECT reset FROM limits WHERE key=?')
    .get(key) as any;
  return String(
    Math.max(1, Math.ceil(((row?.reset || Date.now()) - Date.now()) / 1000)),
  );
}
