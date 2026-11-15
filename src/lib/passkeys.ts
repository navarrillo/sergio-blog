import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { COSEALG } from '@simplewebauthn/server/helpers';
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { db, setSetting, setting, transaction } from './db';
import { config, now } from './config';
import { createSession } from './auth';

export const CHALLENGE_TTL_MS = 120_000;
export const MAX_PASSKEYS = 20;
const algorithms = [COSEALG.ES256, COSEALG.RS256, COSEALG.EdDSA];
const transports = new Set([
  'usb',
  'nfc',
  'ble',
  'internal',
  'hybrid',
  'smart-card',
]);
const SIGN_IN = 'Unable to sign in';

export function relyingParty() {
  let url: URL;
  try {
    url = new URL(config.origin);
  } catch {
    throw new Error('PUBLIC_ORIGIN is not an origin');
  }
  // The RP ID is that host itself. Do not walk up to a parent or apex domain.
  if (url.origin !== config.origin || !url.hostname)
    throw new Error('PUBLIC_ORIGIN is not an origin');
  return { origin: config.origin, rpID: url.hostname };
}
export function reauthWindowMs() {
  const raw = process.env.WEBAUTHN_REAUTH_SECONDS;
  if (raw === undefined || raw === '') return 300_000;
  if (!/^\d+$/.test(raw)) throw new Error('WEBAUTHN_REAUTH_SECONDS is invalid');
  const seconds = Number(raw);
  if (seconds < 60 || seconds > 3600)
    throw new Error('WEBAUTHN_REAUTH_SECONDS is invalid');
  return seconds * 1000;
}
export function withinReauth(authenticatedAt: number) {
  return Date.now() - authenticatedAt <= reauthWindowMs();
}
export function cleanPasskeyName(name: unknown, fallback: boolean) {
  if ((name === undefined || name === null || name === '') && fallback)
    return 'Passkey';
  if (typeof name !== 'string') return null;
  const cleaned = name.trim().replace(/\s+/g, ' ');
  if (!cleaned) return fallback ? 'Passkey' : null;
  if ([...cleaned].length > 64 || /\p{C}/u.test(cleaned)) return null;
  return cleaned;
}
function challengeDigest(challenge: string) {
  if (
    typeof challenge !== 'string' ||
    challenge.length < 22 ||
    challenge.length > 256 ||
    !/^[A-Za-z0-9_-]+$/.test(challenge)
  )
    return null;
  const raw = Buffer.from(challenge, 'base64url');
  if (raw.length < 16 || raw.length > 128) return null;
  if (raw.toString('base64url') !== challenge) return null;
  return createHash('sha256').update(raw).digest();
}
function sameUserHandle(presented: string) {
  const stored = setting('webauthn_user_handle');
  if (!stored) return false;
  try {
    const left = Buffer.from(presented, 'base64url');
    const right = Buffer.from(stored, 'base64url');
    return (
      left.length > 0 &&
      left.length === right.length &&
      timingSafeEqual(left, right)
    );
  } catch {
    return false;
  }
}
function sameChallenge(presented: string, storedHex: string) {
  const digest = challengeDigest(presented);
  const stored = Buffer.from(storedHex, 'hex');
  return (
    !!digest &&
    stored.length === digest.length &&
    timingSafeEqual(digest, stored)
  );
}
function userHandle() {
  return transaction(() => {
    const existing = setting('webauthn_user_handle');
    if (existing) {
      const bytes = Buffer.from(existing, 'base64url');
      if (
        bytes.length >= 16 &&
        bytes.length <= 64 &&
        bytes.toString('base64url') === existing
      )
        return new Uint8Array(bytes);
    }
    const created = randomBytes(32);
    setSetting('webauthn_user_handle', created.toString('base64url'));
    return new Uint8Array(created);
  });
}
function normalizeTransports(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is string => typeof item === 'string' && transports.has(item),
  );
}
function storeChallenge(
  challenge: string,
  kind: 'authentication' | 'registration',
  ip: string,
  sessionToken: string | null,
) {
  const digest = challengeDigest(challenge);
  if (!digest) throw new Error('challenge');
  transaction(() => {
    const time = Date.now();
    db().prepare('DELETE FROM webauthn_challenges WHERE expires<=?').run(time);
    db()
      .prepare(
        'INSERT INTO webauthn_challenges(challenge_hash,kind,expires,ip,session_token) VALUES(?,?,?,?,?)',
      )
      .run(
        digest.toString('hex'),
        kind,
        time + CHALLENGE_TTL_MS,
        ip,
        sessionToken,
      );
  });
}
function consumeChallenge(
  challenge: string,
  kind: 'authentication' | 'registration',
  sessionToken: string | null,
) {
  const digest = challengeDigest(challenge);
  if (!digest) return null;
  return transaction(() => {
    const time = Date.now();
    db().prepare('DELETE FROM webauthn_challenges WHERE expires<=?').run(time);
    const row = db()
      .prepare(
        `DELETE FROM webauthn_challenges
         WHERE challenge_hash=? AND kind=? AND expires>?
           AND session_token IS ?
         RETURNING challenge_hash`,
      )
      .get(digest.toString('hex'), kind, time, sessionToken) as
      | { challenge_hash: string }
      | undefined;
    return row?.challenge_hash || null;
  });
}
function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function readClientData(credential: Record<string, any>) {
  const raw = credential.response?.clientDataJSON;
  if (typeof raw !== 'string' || raw.length < 8 || raw.length > 8192)
    return null;
  try {
    const json = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (!isRecord(json) || typeof json.challenge !== 'string') return null;
    return {
      challenge: json.challenge,
      crossOrigin: json.crossOrigin === true,
    };
  } catch {
    return null;
  }
}
function asCredential(value: unknown) {
  if (!isRecord(value) || !isRecord(value.response)) return null;
  if (value.type !== 'public-key') return null;
  if (
    typeof value.id !== 'string' ||
    value.id !== value.rawId ||
    value.id.length > 2048
  )
    return null;
  return value;
}
export async function authenticationOptions(ip: string) {
  const { rpID } = relyingParty();
  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: 'required',
    timeout: CHALLENGE_TTL_MS,
  });
  storeChallenge(options.challenge, 'authentication', ip, null);
  delete options.allowCredentials;
  options.hints = ['client-device'];
  return options;
}
export async function finishAuthentication(payload: unknown) {
  try {
    const credential = asCredential(payload);
    const client = credential && readClientData(credential);
    if (!credential || !client) return null;
    const consumed = consumeChallenge(client.challenge, 'authentication', null);
    if (!consumed || client.crossOrigin) return null;
    const row = db()
      .prepare(
        'SELECT credential_id, public_key, sign_count FROM passkeys WHERE credential_id=?',
      )
      .get(credential.id) as
      | { credential_id: string; public_key: Uint8Array; sign_count: number }
      | undefined;
    if (!row) return null;
    const { origin, rpID } = relyingParty();
    const verified = await verifyAuthenticationResponse({
      response: credential as AuthenticationResponseJSON,
      expectedChallenge: (presented) => sameChallenge(presented, consumed),
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: {
        id: row.credential_id,
        publicKey: new Uint8Array(row.public_key),
        counter: row.sign_count,
      },
      requireUserVerification: true,
    });
    if (!verified.verified) return null;
    const presented = credential.response.userHandle;
    if (
      typeof presented === 'string' &&
      presented &&
      !sameUserHandle(presented)
    )
      return null;
    return transaction(() => {
      const updated = db()
        .prepare(
          'UPDATE passkeys SET sign_count=?, last_used_at=? WHERE credential_id=? AND sign_count=?',
        )
        .run(
          verified.authenticationInfo.newCounter,
          now(),
          row.credential_id,
          row.sign_count,
        );
      if (!updated.changes) return null;
      return createSession();
    });
  } catch {
    return null;
  }
}
export async function registrationOptions(
  sessionToken: string,
  authenticatedAt: number,
  ip: string,
) {
  if (!withinReauth(authenticatedAt)) return null;
  const count = Number(
    (db().prepare('SELECT count(*) AS count FROM passkeys').get() as any).count,
  );
  if (count >= MAX_PASSKEYS) return null;
  const { rpID } = relyingParty();
  const existing = db()
    .prepare('SELECT credential_id, transports FROM passkeys')
    .all() as { credential_id: string; transports: string }[];
  const options = await generateRegistrationOptions({
    rpName: 'Sergio Blog',
    rpID,
    userName: 'admin',
    userDisplayName: 'admin',
    userID: userHandle(),
    timeout: CHALLENGE_TTL_MS,
    attestationType: 'none',
    supportedAlgorithmIDs: algorithms,
    preferredAuthenticatorType: 'localDevice',
    authenticatorSelection: {
      authenticatorAttachment: 'platform',
      residentKey: 'required',
      userVerification: 'required',
    },
    excludeCredentials: existing.map((row) => ({
      id: row.credential_id,
      transports: normalizeTransports(JSON.parse(row.transports || '[]')),
    })),
  });
  storeChallenge(options.challenge, 'registration', ip, sessionToken);
  if (!options.excludeCredentials?.length) delete options.excludeCredentials;
  return options;
}
export async function finishRegistration(
  payload: unknown,
  name: unknown,
  sessionToken: string,
  authenticatedAt: number,
) {
  const cleaned = cleanPasskeyName(name, true);
  if (!cleaned || !withinReauth(authenticatedAt)) return null;
  try {
    const body = isRecord(payload) ? payload : null;
    const credential = body && asCredential(body.credential);
    const client = credential && readClientData(credential);
    if (!credential || !client) return null;
    const consumed = consumeChallenge(
      client.challenge,
      'registration',
      sessionToken,
    );
    if (!consumed || client.crossOrigin) return null;
    const { origin, rpID } = relyingParty();
    const verified = await verifyRegistrationResponse({
      response: credential as RegistrationResponseJSON,
      expectedChallenge: (presented) => sameChallenge(presented, consumed),
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserPresence: true,
      requireUserVerification: true,
      supportedAlgorithmIDs: algorithms,
    });
    if (!verified.verified) return null;
    const saved = verified.registrationInfo.credential;
    const id = transaction(() => {
      const count = Number(
        (db().prepare('SELECT count(*) AS count FROM passkeys').get() as any)
          .count,
      );
      if (count >= MAX_PASSKEYS) return null;
      return Number(
        db()
          .prepare(
            'INSERT INTO passkeys(name,credential_id,public_key,sign_count,transports,created_at) VALUES(?,?,?,?,?,?)',
          )
          .run(
            cleaned,
            saved.id,
            Buffer.from(saved.publicKey),
            saved.counter,
            JSON.stringify(normalizeTransports(credential.response.transports)),
            now(),
          ).lastInsertRowid,
      );
    });
    return id ? { id, name: cleaned } : null;
  } catch {
    return null;
  }
}
export type PasskeySummary = {
  id: number;
  name: string;
  created_at: string;
  last_used_at: string | null;
};
export function listPasskeys() {
  return db()
    .prepare(
      'SELECT id, name, created_at, last_used_at FROM passkeys ORDER BY id',
    )
    .all() as PasskeySummary[];
}
export function renamePasskey(id: number, name: unknown) {
  const cleaned = cleanPasskeyName(name, false);
  if (!cleaned) return null;
  const updated = db()
    .prepare('UPDATE passkeys SET name=? WHERE id=?')
    .run(cleaned, id);
  return updated.changes ? cleaned : null;
}
export function deletePasskey(id: number) {
  return db().prepare('DELETE FROM passkeys WHERE id=?').run(id).changes === 1;
}
export function revokePasskeys() {
  try {
    return transaction(() => {
      const removed = db().prepare('DELETE FROM passkeys').run().changes;
      db().prepare('DELETE FROM webauthn_challenges').run();
      return removed;
    });
  } catch (error) {
    if (error instanceof Error && /no such table/i.test(error.message))
      throw new Error(
        'Passkeys are not available yet. Run bin/migrate.ts first.',
      );
    throw error;
  }
}
export async function readJson(request: Request) {
  const claimed = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(claimed) && claimed > 65536) return null;
  const text = await request.text();
  if (text.length > 65536) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
export function passkeyId(value: string | undefined) {
  if (!value || !/^[1-9]\d{0,8}$/.test(value)) return null;
  return Number(value);
}
export function signInError(status = 401) {
  return Response.json(
    { error: SIGN_IN },
    {
      status,
      headers: status === 429 ? { 'Retry-After': '600' } : {},
    },
  );
}
export function passkeyError(
  status: number,
  error = 'Unable to update passkeys.',
) {
  return Response.json({ error }, { status });
}
