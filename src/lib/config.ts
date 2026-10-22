import path from 'node:path';
export const config = {
  origin: process.env.PUBLIC_ORIGIN || 'http://localhost:4321',
  data: path.resolve(process.env.DATA_DIR || 'data'),
  uploads: path.resolve(process.env.UPLOADS_DIR || 'uploads'),
  backups: path.resolve(process.env.BACKUPS_DIR || 'backups'),
  secure: process.env.COOKIE_SECURE !== 'false',
  trusted: (process.env.TRUSTED_PROXIES || '').split(',').map(s=>s.trim()).filter(Boolean),
  maxImage: 8 * 1024 * 1024,
};
export const now = () => new Date().toISOString();
