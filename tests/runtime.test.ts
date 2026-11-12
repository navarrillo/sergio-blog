import { test, expect } from 'vitest';
import { assertNodeVersion } from '../bin/check-node.mjs';
test('rejects pre-security-release runtimes and preserves supported Node 24 updates', () => {
  for (const version of ['24.14.1', '24.22.2', '22.23.5', '26.12.1'])
    expect(() => assertNodeVersion(version)).toThrow('unsupported');
  for (const version of ['24.22.3', '24.22.4', '24.23.0'])
    expect(() => assertNodeVersion(version)).not.toThrow();
});
