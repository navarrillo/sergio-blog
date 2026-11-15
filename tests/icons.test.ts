import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (name: string) => readFileSync(path.join(root, name));

test('home-screen icons are opaque rasters served from the site root', async () => {
  for (const [file, size] of [
    ['public/apple-touch-icon.png', 180],
    ['public/icon-192.png', 192],
    ['public/icon-512.png', 512],
  ] as const) {
    const source = read(file);
    const meta = await sharp(source).metadata();
    expect(meta.format).toBe('png');
    expect(meta.width).toBe(size);
    expect(meta.height).toBe(size);
    expect(meta.hasAlpha).toBe(false);
    const { data } = await sharp(source).ensureAlpha().raw().toBuffer({
      resolveWithObject: true,
    });
    let ink = 0;
    let transparent = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] !== 255) transparent++;
      if (data[i] !== 255 || data[i + 1] !== 255 || data[i + 2] !== 255) ink++;
    }
    expect(transparent).toBe(0);
    expect(ink).toBeGreaterThan(100);
  }
  expect(read('public/favicon.svg').byteLength).toBeGreaterThan(0);
});

test('manifest and document heads point at the root icons', () => {
  const manifest = JSON.parse(read('public/site.webmanifest').toString());
  expect(manifest.name).toBe('Sergio Navarro');
  expect(manifest.short_name).toBe('Sergio Navarro');
  expect(manifest.theme_color).toBe('#ffffff');
  expect(manifest.background_color).toBe('#ffffff');
  expect(manifest.icons).toEqual([
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
  ]);
  for (const file of ['src/layouts/Base.astro', 'src/pages/500.astro']) {
    const html = read(file).toString().replaceAll(/\s+/g, ' ');
    expect(html).toContain('rel="icon" href="/favicon.svg"');
    expect(html).toContain(
      'rel="apple-touch-icon" href="/apple-touch-icon.png"',
    );
    expect(html).toContain('rel="manifest" href="/site.webmanifest"');
    expect(html).toContain(
      'name="apple-mobile-web-app-title" content="Sergio Navarro"',
    );
  }
});
