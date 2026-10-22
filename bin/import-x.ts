import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../src/lib/config';
import { importArchive } from '../src/lib/importer';
const input = path.resolve(process.argv[2] || '');
if (!input.startsWith(config.data + path.sep))
  throw new Error(
    'Put the archive inside DATA_DIR, then pass its absolute path.',
  );
const data = await readFile(input);
if (data.length > 32 * 1024 * 1024)
  throw new Error(
    'Maximum archive size is 32 MB; split larger archives first.',
  );
console.log(
  JSON.stringify(await importArchive(data, input.endsWith('.zip')), null, 2),
);
