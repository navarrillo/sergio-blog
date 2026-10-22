// Minimum patched Node 24 from the October 2026 security release.
export function assertNodeVersion(version) {
  const [major, minor, patch] = version.split('.').map(Number);
  if (major !== 24 || minor < 22 || (minor === 22 && patch < 1)) {
    throw new Error(
      `Node ${version} is unsupported. Install Node >=24.22.1 <25 (October 2026 security fixes).`,
    );
  }
}
assertNodeVersion(process.versions.node);
