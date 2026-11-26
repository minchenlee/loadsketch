// Every entry page (/, /app/, /learn/) carries Open Graph and Twitter card metadata in <head> whose og:image matches the expected 1200x630 PNG in public/.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');
const ORIGIN = 'https://loadsketch.mclee.dev';
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const PAGES = [
  { file: 'index.html', path: '/', image: 'og.png' },
  { file: 'app/index.html', path: '/app/', image: 'og.png' },
  { file: 'learn/index.html', path: '/learn/', image: 'og-learn.png' },
] as const;

function parseMeta(html: string): Map<string, string> {
  const tags = new Map<string, string>();
  const clean = html.replace(/<!--[\s\S]*?-->/g, '');
  const head = clean.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i)?.[1];
  if (!head) return tags;
  for (const match of head.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    const attrs = new Map<string, string>();
    for (const a of tag.matchAll(/([a-zA-Z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      attrs.set(a[1].toLowerCase(), a[2] ?? a[3] ?? '');
    }
    const key = attrs.get('property') ?? attrs.get('name');
    const content = attrs.get('content');
    if (key && content !== undefined) tags.set(key.toLowerCase(), content);
  }
  return tags;
}

function pngSize(file: string): { width: number; height: number; bytes: number } {
  const buf = readFileSync(file);
  expect(buf.subarray(0, 8).equals(PNG_SIG), `${file} is not a valid PNG`).toBe(true);
  expect(buf.subarray(12, 16).toString('ascii'), `${file} missing IHDR`).toBe('IHDR');
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    bytes: buf.length,
  };
}

describe('parseMeta', () => {
  it('ignores meta tags inside HTML comments and outside <head>', () => {
    const sample = `<!doctype html>
<html>
  <head>
    <!-- <meta property="og:title" content="commented" /> -->
    <meta property="og:description" content="real" />
  </head>
  <body>
    <meta property="og:url" content="https://loadsketch.mclee.dev/body/" />
  </body>
</html>`;
    const meta = parseMeta(sample);
    expect(meta.get('og:title')).toBeUndefined();
    expect(meta.get('og:description')).toBe('real');
    expect(meta.get('og:url')).toBeUndefined();
  });
});

describe('link preview meta tags', () => {
  for (const page of PAGES) {
    it(`${page.file} has Open Graph and Twitter card tags pointing to ${page.image} (1200x630)`, () => {
      const html = readFileSync(join(ROOT, page.file), 'utf8');
      const meta = parseMeta(html);

      expect(meta.get('og:title')?.trim()).toBeTruthy();
      expect(meta.get('og:description')?.trim()).toBeTruthy();
      expect(meta.get('og:type')).toBe('website');
      expect(meta.get('og:url')).toBe(`${ORIGIN}${page.path}`);
      expect(meta.get('og:image')).toBe(`${ORIGIN}/${page.image}`);
      expect(meta.get('og:image:width')).toBe('1200');
      expect(meta.get('og:image:height')).toBe('630');
      expect(meta.get('og:image:alt')?.trim()).toBeTruthy();
      expect(meta.get('twitter:card')).toBe('summary_large_image');

      const diskPath = join(ROOT, 'public', page.image);
      expect(existsSync(diskPath), `missing ${diskPath}`).toBe(true);
      const size = pngSize(diskPath);
      expect(size.width).toBe(1200);
      expect(size.height).toBe(630);
    });
  }
});
