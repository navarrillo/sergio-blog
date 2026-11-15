// Minimum patched Node 24 from the November 2026 security release.
export function assertNodeVersion(version) {
  const [major, minor, patch] = version.split('.').map(Number);
  if (major !== 24 || minor < 22 || (minor === 22 && patch < 3)) {
    throw new Error(
      `Node ${version} is unsupported. Install Node >=24.22.3 <25 (November 2026 security fixes).`,
    );
  }
}
assertNodeVersion(process.versions.node);
