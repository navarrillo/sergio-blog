import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
export default defineConfig({ output: 'server', adapter: node({ mode: 'standalone' }), vite: { ssr: { external: ['node:sqlite','argon2','sharp'] }, build: { sourcemap: false } }, security: { checkOrigin: true } });
