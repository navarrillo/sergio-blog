import { posix } from 'node:path';
export const uploadPathPattern = /^\/uploads\/[a-f0-9-]+\.webp$/;

// Inspect the original request target before WHATWG URL parsing removes dot segments.
export function rejectsUploadPath(target) {
  const rawPath = target.split('?')[0];
  let decoded = rawPath;
  try {
    for (let i = 0; i < 4; i++) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
  } catch {
    return rawPath.startsWith('/uploads/');
  }
  const path = decoded.replaceAll('\\', '/');
  const normalized = posix.normalize(path);
  const isUpload = (value) =>
    value === '/uploads' || value.startsWith('/uploads/');
  return (
    (isUpload(path) || isUpload(normalized)) && !uploadPathPattern.test(rawPath)
  );
}
