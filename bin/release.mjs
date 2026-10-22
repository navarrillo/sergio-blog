import './check-node.mjs';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  openSync,
  unlinkSync,
  closeSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const runtimeCheck = readFileSync(
  new URL('./check-node.mjs', import.meta.url),
  'utf8',
);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const envFile = process.env.BLOG_ENV;
if (!envFile || !path.isAbsolute(envFile))
  throw new Error('Set BLOG_ENV to the absolute config/.env path');
const env = { ...process.env, BLOG_ENV_FILE: envFile };
const operational = path.dirname(envFile);
const stateFile = path.join(operational, 'release-state.json');
const lock = path.join(operational, 'release.lock');
let lockFd;
function run(command, args, extra = {}) {
  const r = spawnSync(command, args, {
    cwd: root,
    env: { ...env, ...extra },
    encoding: 'utf8',
  });
  if (r.status !== 0)
    throw new Error(
      `${command} ${args.slice(0, 3).join(' ')} failed: ${r.stderr || r.stdout}`,
    );
  return r.stdout.trim();
}
const compose = (args, image) =>
  run(
    'docker',
    ['compose', '--env-file', envFile, ...args],
    image ? { BLOG_IMAGE: image } : {},
  );
const one = (args, image) =>
  compose(['run', '--rm', '--no-deps', 'blog', ...args], image);
async function healthy() {
  for (let i = 0; i < 30; i++) {
    try {
      compose([
        'exec',
        '-T',
        'blog',
        'node',
        '-e',
        "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
      ]);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error('Health check timed out');
}
function assertImageRuntime(image) {
  run('docker', [
    'run',
    '--rm',
    '--network',
    'none',
    '--entrypoint',
    'node',
    image,
    '--input-type=module',
    '-e',
    runtimeCheck,
  ]);
}
async function restore(state) {
  // Refuse to reintroduce an unpatched runtime, before stopping the current service.
  assertImageRuntime(state.previous);
  compose(['stop', 'blog']);
  one(
    [
      'node',
      '--import',
      'tsx',
      'bin/restore-db.ts',
      state.snapshot + '/blog.db',
    ],
    state.previous,
  );
  run('docker', ['tag', state.previous, 'blog:live']);
  compose(['up', '-d', '--no-build', '--force-recreate', 'blog'], 'blog:live');
  await healthy();
}
try {
  lockFd = openSync(lock, 'wx', 0o600);
  if (process.argv[2] === 'rollback') {
    if (!existsSync(stateFile))
      throw new Error('No saved release to roll back');
    const state = JSON.parse(readFileSync(stateFile, 'utf8'));
    if (!state.previous || !state.snapshot)
      throw new Error('No previous release');
    assertImageRuntime(state.previous);
    // Preserve all edits made since the deployment before reverting its schema snapshot.
    one(['node', '--import', 'tsx', 'bin/storage.ts', 'backup'], state.current);
    await restore(state);
    console.log('Rolled back to ' + state.previous);
    process.exitCode = 0;
  } else {
    const ref = process.argv[3];
    if (!ref || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(ref))
      throw new Error('Usage: bin/deploy <git-ref>');
    if (run('git', ['status', '--porcelain']))
      throw new Error('Deployment checkout must be clean');
    run('git', ['fetch', 'origin', ref]);
    const sha = run('git', ['rev-parse', '--verify', 'FETCH_HEAD']);
    run('git', ['checkout', '--detach', sha]);
    const image = 'blog:' + sha.slice(0, 12);
    run('docker', ['build', '-t', image, '.']);
    assertImageRuntime(image);
    let previous = null;
    try {
      previous = run('docker', [
        'image',
        'inspect',
        'blog:live',
        '--format',
        '{{.Id}}',
      ]);
      run('docker', ['tag', previous, 'blog:prev']);
    } catch {
      /* First deployment has no previous release. */
    }
    if (previous) {
      try {
        assertImageRuntime(previous);
      } catch {
        // Prepare safe recovery for the first security upgrade before touching the service.
        // Existing blog images use Node 24 / Debian bookworm; retain their application.
        const major = run('docker', [
          'run',
          '--rm',
          '--network',
          'none',
          '--entrypoint',
          'node',
          previous,
          '-p',
          "process.versions.node.split('.')[0]",
        ]);
        if (major !== '24')
          throw new Error(
            'Previous image is not Node 24; prepare a compatible patched recovery image before deploying.',
          );
        const recovery = 'blog:patched-prev-' + sha.slice(0, 12);
        run('docker', [
          'build',
          '--build-arg',
          'PREVIOUS_IMAGE=blog:prev',
          '-f',
          'deploy/Dockerfile.recovery',
          '-t',
          recovery,
          '.',
        ]);
        assertImageRuntime(recovery);
        previous = run('docker', [
          'image',
          'inspect',
          recovery,
          '--format',
          '{{.Id}}',
        ]);
        run('docker', ['tag', previous, 'blog:prev']);
      }
    }
    compose(['stop', 'blog']);
    let snapshot = null;
    try {
      // Back up before forward migrations while there are no writers.
      // On first deploy, bootstrap an empty schema; bin/migrate still takes a pre-migration copy.
      if (previous) {
        const output = one(
          ['node', '--import', 'tsx', 'bin/storage.ts', 'backup'],
          image,
        );
        snapshot = output
          .split('\n')
          .find((line) => line.startsWith('/app/backups/'));
        if (!snapshot) throw new Error('No backup path returned');
        one(
          ['node', '--import', 'tsx', 'bin/storage.ts', 'pin', snapshot],
          image,
        );
      }
      one(['node', '--import', 'tsx', 'bin/migrate.ts'], image);
      run('docker', ['tag', image, 'blog:live']);
      compose(
        ['up', '-d', '--no-build', '--force-recreate', 'blog'],
        'blog:live',
      );
      await healthy();
      const oldState = existsSync(stateFile)
        ? JSON.parse(readFileSync(stateFile, 'utf8'))
        : null;
      mkdirSync(operational, { recursive: true });
      writeFileSync(
        stateFile,
        JSON.stringify({
          current: image,
          previous,
          snapshot,
          created_at: new Date().toISOString(),
        }),
        { mode: 0o600 },
      );
      if (oldState?.snapshot && oldState.snapshot !== snapshot)
        one(
          [
            'node',
            '--import',
            'tsx',
            'bin/storage.ts',
            'unpin',
            oldState.snapshot,
          ],
          image,
        );
      console.log('Healthy release: ' + image);
    } catch (error) {
      if (previous && snapshot) {
        await restore({ previous, snapshot });
        console.error('Previous image and database restored.');
      } else if (previous) {
        assertImageRuntime(previous);
        compose(['up', '-d', '--no-build', 'blog'], previous);
      }
      throw error;
    }
  }
} finally {
  if (lockFd !== undefined) {
    closeSync(lockFd);
    unlinkSync(lock);
  }
}
