// Only called after the serving container has been stopped.
import { copyFileSync, unlinkSync, renameSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../src/lib/config';
const source = process.argv[2];
if (!source?.startsWith(config.backups + '/'))
  throw new Error('Expected a database dump in BACKUPS_DIR');
const check = new DatabaseSync(source, { readOnly: true });
try {
  if (
    (check.prepare('PRAGMA integrity_check').get() as any).integrity_check !==
    'ok'
  )
    throw new Error('Invalid backup');
} finally {
  check.close();
}
const target = config.data + '/blog.db';
copyFileSync(source, target + '.restore');
for (const suffix of ['-wal', '-shm'])
  try {
    unlinkSync(target + suffix);
  } catch {
    /* May not exist after clean shutdown. */
  }
renameSync(target + '.restore', target);
console.log('SQLite restored from consistent dump.');
