import { test, expect } from 'vitest';
import { assertNodeVersion } from '../bin/check-node.mjs';
test('rejects pre-security-release runtimes and preserves supported Node 24 updates', () => {
  for (const version of ['24.14.1', '24.22.0', '22.23.4', '26.12.1'])
    expect(() => assertNodeVersion(version)).toThrow('unsupported');
  for (const version of ['24.22.1', '24.22.2', '24.23.0'])
    expect(() => assertNodeVersion(version)).not.toThrow();
});
