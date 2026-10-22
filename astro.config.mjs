import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
export default defineConfig({
  output: 'server',
  session: false,
  adapter: node({ mode: 'standalone', bodySizeLimit: 33 * 1024 * 1024 }),
  vite: {
    ssr: { external: ['node:sqlite', 'argon2', 'sharp'] },
    build: { sourcemap: false },
  },
  security: {
    checkOrigin: true,
    allowedDomains: [
      { hostname: 'blog.sergionavarro.me', protocol: 'https' },
      { hostname: '127.0.0.1', protocol: 'http' },
      { hostname: 'localhost', protocol: 'http' },
    ],
  },
});
