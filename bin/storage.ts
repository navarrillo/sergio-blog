import { backup, DatabaseSync } from 'node:sqlite';
import {
  mkdir,
  cp,
  writeFile,
  readdir,
  rm,
  readFile,
  stat,
  rename,
  unlink,
  access,
} from 'node:fs/promises';
import path from 'node:path';
import { config, now } from '../src/lib/config';
import { db } from '../src/lib/db';
const [command, argument, target] = process.argv.slice(2);
if (command === 'backup') {
  await mkdir(config.backups, { recursive: true, mode: 0o700 });
  const name = now().replaceAll(':', '-');
  const directory = path.join(config.backups, name);
  const staging = directory + '.incomplete';
  await mkdir(staging, { mode: 0o700 });
  try {
    await backup(db(), path.join(staging, 'blog.db'));
    await cp(config.uploads, path.join(staging, 'uploads'), {
      recursive: true,
    });
    await writeFile(
      path.join(staging, 'manifest.json'),
      JSON.stringify({ version: 1, created_at: now() }),
    );
    await rename(staging, directory);
    for (const entry of await readdir(config.backups, {
      withFileTypes: true,
    })) {
      if (
        entry.isDirectory() &&
        /^\d{4}-\d{2}-\d{2}T/.test(entry.name) &&
        !(await access(
          path.join(config.backups, entry.name, '.rollback-pin'),
        ).then(
          () => true,
          () => false,
        )) &&
        (await stat(path.join(config.backups, entry.name))).mtimeMs <
          Date.now() - 7 * 86400000
      )
        await rm(path.join(config.backups, entry.name), { recursive: true });
    }
    console.log(directory);
  } catch (e) {
    await rm(staging, { recursive: true, force: true });
    throw e;
  }
} else if (command === 'restore') {
  if (!argument || !target)
    throw new Error(
      'Usage: restore <backup-directory> <clean-target-directory>',
    );
  const source = path.resolve(argument),
    destination = path.resolve(target);
  const manifest = JSON.parse(
    await readFile(path.join(source, 'manifest.json'), 'utf8'),
  );
  if (manifest.version !== 1) throw new Error('Unsupported backup version');
  const existing = await readdir(destination).catch(() => []);
  if (existing.length) throw new Error('Restore target must be empty');
  const check = new DatabaseSync(path.join(source, 'blog.db'), {
    readOnly: true,
  });
  try {
    if (
      (check.prepare('PRAGMA integrity_check').get() as any).integrity_check !==
      'ok'
    )
      throw new Error('Corrupt database');
  } finally {
    check.close();
  }
  await mkdir(path.join(destination, 'data'), { recursive: true, mode: 0o700 });
  await cp(
    path.join(source, 'blog.db'),
    path.join(destination, 'data/blog.db'),
  );
  await cp(path.join(source, 'uploads'), path.join(destination, 'uploads'), {
    recursive: true,
  });
  console.log('Restored database and uploads to ' + destination);
} else if (command === 'pin' || command === 'unpin') {
  const directory = path.resolve(argument || '');
  if (!directory.startsWith(config.backups + path.sep))
    throw new Error('Expected a backup path');
  if (command === 'pin')
    await writeFile(
      path.join(directory, '.rollback-pin'),
      'Retained for rollback',
      { mode: 0o600 },
    );
  else await unlink(path.join(directory, '.rollback-pin')).catch(() => {});
} else throw new Error('Expected backup, restore, pin or unpin');
