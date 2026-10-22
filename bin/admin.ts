import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import argon2 from 'argon2';
import { db } from '../src/lib/db';
import { newTotpSecret, validTotp } from '../src/lib/auth';
if (!process.stdin.isTTY || !process.stdout.isTTY)
  throw new Error('An interactive terminal is required.');
const output = new Writable({
  write(chunk, _encoding, callback) {
    if (!hidden) process.stdout.write(chunk);
    callback();
  },
});
let hidden = false;
const terminal = createInterface({
  input: process.stdin,
  output,
  terminal: true,
});
async function secret(prompt: string) {
  process.stdout.write(prompt);
  hidden = true;
  try {
    return await terminal.question('');
  } finally {
    hidden = false;
    process.stdout.write('\n');
  }
}
try {
  const command = process.argv[2];
  if (command === 'create' || command === 'recover') {
    const existing = db().prepare('SELECT id FROM admin').get();
    if (existing && command === 'create')
      throw new Error(
        'Administrator exists. Use recover to replace credentials.',
      );
    const password = await secret('New password (at least 14 characters): ');
    if (password.length < 14) throw new Error('Password too short');
    if (password !== (await secret('Confirm password: ')))
      throw new Error('Passwords do not match');
    const hash = await argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
    });
    db()
      .prepare(
        'INSERT INTO admin(id,password_hash) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET password_hash=excluded.password_hash,totp_secret=NULL,last_totp=0',
      )
      .run(hash);
    db().exec('DELETE FROM sessions');
    console.log('Password saved. TOTP enrollment is required before sign-in.');
  } else if (command !== 'enroll')
    throw new Error('Usage: admin create | recover | enroll');
  if (!db().prepare('SELECT id FROM admin').get())
    throw new Error('Create the administrator first.');
  const totp = newTotpSecret();
  console.log(
    'Add this secret to your authenticator (terminal only):\n' +
      totp +
      '\n' +
      `otpauth://totp/Sergio%20Blog:admin?secret=${totp}&issuer=Sergio%20Blog&digits=6&period=30`,
  );
  const code = await secret('Enter the current six-digit code to confirm: ');
  const step = validTotp(totp, code);
  if (!step)
    throw new Error(
      'Enrollment not confirmed. Sign-in remains disabled if no TOTP was enrolled.',
    );
  db()
    .prepare('UPDATE admin SET totp_secret=?,last_totp=? WHERE id=1')
    .run(totp, step);
  db().exec('DELETE FROM sessions');
  console.log('Authenticator enrolled. Existing sessions revoked.');
} finally {
  terminal.close();
}
