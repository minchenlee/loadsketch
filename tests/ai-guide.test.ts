// The format guide for AI models (roadmap-next M5): made from the component catalog, kept in
// public/llms-full.txt (M15: public/llms.txt is a short index), and its example is a valid design.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GUIDE_EXAMPLE, LLMS_LINKS, REPO, SITE, SKILL_EXAMPLE, SKILL_NAME, aiGuide, aiPrompt, llmsIndex, referenceMd, skillMd } from '../src/schema/aiGuide.ts';
import { aiGuideFiles } from '../scripts/ai-guide.ts';
import { readStoredZip } from '../scripts/zip.ts';
import { EN } from '../src/i18n/en.ts';
import { EDGE_PARAMS, KINDS } from '../src/schema/kinds.ts';
import { ApiSchema, DesignSchema, EdgeSchema, NodeSchema, NoteSchema, parseDesign } from '../src/schema/design.ts';

const root = join(import.meta.dirname, '..');
const file = join(root, 'public', 'llms-full.txt');
const blocks = (s: string) => [...s.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => m[1]);

/** The text of a `## title` section, up to the next `## `. */
const section = (g: string, title: string) => {
  const at = g.indexOf(`\n## ${title}\n`);
  if (at < 0) throw new Error(`no section ${title}`);
  const end = g.indexOf('\n## ', at + 1);
  return g.slice(at, end < 0 ? undefined : end);
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const keys = (s: any): string[] => Object.keys(s.shape);
const nodeKeys = () => [...new Set(NodeSchema.options.flatMap((o) => keys(o)))];

describe('ai guide', () => {
  it('every field of the format is in the guide, where it belongs (M5 review P2: source was missing)', () => {
    const g = aiGuide();
    const missing = (title: string, list: string[]) => list.filter((k) => !section(g, title).includes(`\`${k}\``)).map((k) => `${title}: ${k}`);
    expect([
      ...missing('The design', [...keys(DesignSchema), ...keys(ApiSchema), ...keys(NoteSchema)]),
      ...missing('A node (component)', nodeKeys()),
      ...missing('An edge (call)', keys(EdgeSchema)),
    ]).toEqual([]);
    expect(nodeKeys()).toContain('source');
    expect(section(g, 'How to answer')).toContain('Copy each `source` unchanged');
  });


  it('every file made from the guide is up to date: llms.txt, llms-full.txt, SKILL.md, reference.md, their copies and the zip (run npm run ai-guide when this fails)', () => {
    const made = aiGuideFiles();
    expect(made.map(([name]) => name)).toEqual([
      'public/llms.txt',
      'public/llms-full.txt',
      'skills/loadsketch/SKILL.md',
      'skills/loadsketch/reference.md',
      'public/skills/loadsketch/SKILL.md',
      'public/skills/loadsketch/reference.md',
      'public/skills/loadsketch.zip',
    ]);
    for (const [name, content] of made) {
      const want = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
      expect(readFileSync(join(root, name)).equals(want), name).toBe(true);
    }
    expect(readFileSync(file, 'utf8')).toBe(aiGuide());
  });

  it('a change to the catalog changes the guide, so the file check above catches it', () => {
    const spec = KINDS.cache.params;
    spec.zzProbe = { type: 'int', default: 1, min: 0, max: 2, label: 'x', help: 'y' };
    try {
      expect(aiGuide()).not.toBe(readFileSync(file, 'utf8'));
      expect(aiGuide()).toContain('`zzProbe`');
    } finally {
      delete spec.zzProbe;
    }
  });

  it('every kind, every parameter and every edge parameter is in it, in English', () => {
    const g = aiGuide();
    for (const [kind, spec] of Object.entries(KINDS)) {
      expect(g).toContain(`### \`${kind}\` — ${spec.labelEn}`);
      const section = g.slice(g.indexOf(`### \`${kind}\``)).split('\n### ')[0];
      for (const p of Object.keys(spec.params)) expect(section, `${kind}.${p}`).toContain(`- \`${p}\` — `);
    }
    for (const p of Object.keys(EDGE_PARAMS)) expect(g).toContain(`- \`${p}\` — `);
    expect(g.match(/[㐀-鿿＀-￯]/g)).toBeNull();
  });

  it('its example is a complete, valid design with no warnings', () => {
    const json = blocks(aiGuide());
    expect(json).toHaveLength(1);
    const d = JSON.parse(json[0]);
    expect(d).toEqual(GUIDE_EXAMPLE);
    const r = parseDesign(d);
    expect(r.ok && r.issues).toEqual([]);
  });

  it('the prompt holds the guide, the current design and room for the request', () => {
    const d = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'examples/designs/three-tier.json'), 'utf8'));
    const p = aiPrompt(d, 'https://example.test/llms.txt');
    expect(p).toContain(aiGuide());
    expect(p).toContain('https://example.test/llms.txt');
    expect(JSON.parse(blocks(p).at(-1)!)).toEqual(d);
    expect(p.trimEnd().endsWith('(Write what you want here.)')).toBe(true);
  });
});

// The Agent Skill (roadmap-next M12; M15: SKILL.md short, the parameters in reference.md, a zip).
describe('agent skill', () => {
  const read = (f: string) => readFileSync(join(root, f), 'utf8');
  const front = (text: string) => {
    const m = text.match(/^---\n([\s\S]*?)\n---\n/);
    if (!m) throw new Error('no frontmatter');
    return Object.fromEntries(m[1].split('\n').map((l) => {
      const at = l.indexOf(': ');
      const v = l.slice(at + 2);
      return [l.slice(0, at), v.startsWith('"') ? JSON.parse(v) : v];
    }));
  };
  /** A `## ` section of a markdown text, up to the next `## `. */
  const part = (text: string, heading: string) => {
    const at = text.indexOf(`\n${heading}\n`);
    if (at < 0) throw new Error(`no section ${heading}`);
    const end = text.indexOf('\n## ', at + 1);
    return text.slice(at, end < 0 ? undefined : end);
  };

  it('a change to the catalog makes the files out of date: a parameter changes the full guide, reference.md and the zip; a kind changes SKILL.md too', () => {
    const now = new Map(aiGuideFiles().map(([n, c]) => [n, Buffer.from(c)]));
    const changed = () => aiGuideFiles().filter(([n, c]) => !now.get(n)!.equals(Buffer.from(c))).map(([n]) => n);
    const spec = KINDS.cache.params;
    spec.zzProbe = { type: 'int', default: 1, min: 0, max: 2, label: 'x', help: 'y' };
    try {
      expect(changed()).toEqual(['public/llms-full.txt', 'skills/loadsketch/reference.md', 'public/skills/loadsketch/reference.md', 'public/skills/loadsketch.zip']);
      expect(referenceMd()).toContain('`zzProbe`');
    } finally {
      delete spec.zzProbe;
    }
    const kinds = KINDS as Record<string, (typeof KINDS)['cache']>;
    kinds.zz_probe = { ...KINDS.cache, kind: 'zz_probe' as 'cache', labelEn: 'Probe' };
    try {
      // llms.txt is an index of links: the catalog is not in it
      expect(changed()).toEqual(aiGuideFiles().map(([n]) => n).filter((n) => n !== 'public/llms.txt'));
      expect(skillMd()).toContain('- `zz_probe` — Probe: ');
      expect(referenceMd()).toContain('## `zz_probe` — Probe');
    } finally {
      delete kinds.zz_probe;
    }
    expect(changed()).toEqual([]);
  });

  it('SKILL.md is short: at most 150 lines, without the parameters of the kinds', () => {
    const s = skillMd();
    expect(s.split('\n').length).toBeLessThanOrEqual(150);
    expect(s).not.toContain('Parameters (in `params`)');
    expect(s.length).toBeLessThan(aiGuide().length / 2);
  });

  it('every kind has a line in the SKILL.md list and a section in reference.md with all its parameters', () => {
    const list = part(skillMd(), '## Components');
    const ref = referenceMd();
    for (const [kind, spec] of Object.entries(KINDS)) {
      expect(list, kind).toContain(`- \`${kind}\` — ${spec.labelEn}: `);
      const sec = part(ref, `## \`${kind}\` — ${spec.labelEn}`);
      for (const p of Object.keys(spec.params)) expect(sec, `${kind}.${p}`).toContain(`- \`${p}\` — `);
    }
    // one section per kind, nothing else at that level
    expect(ref.match(/^## /gm)).toHaveLength(Object.keys(KINDS).length);
    expect(ref.match(/[㐀-鿿＀-￯]/g)).toBeNull();
  });

  it('SKILL.md holds the steps, the same rules as the full guide, and says to read reference.md (or its address) before setting a kind', () => {
    const s = skillMd();
    for (const h of ['## Steps', '## How to answer', '## The design', '## A node (component)', '## An edge (call)', '## How requests flow', '## Components', '## Example']) expect(s, h).toContain(`\n${h}\n`);
    for (const h of ['## How to answer', '## The design', '## A node (component)', '## An edge (call)', '## How requests flow']) expect(part(s, h)).toBe(part(aiGuide(), h));
    const steps = part(s, '## Steps');
    expect(steps).toContain('read that kind\'s section in reference.md in this folder');
    expect(steps).toContain(`${SITE}${LLMS_LINKS.reference}`);
  });

  it('the examples pass the schema with no warnings: the small one in SKILL.md, the full one in the guide', () => {
    for (const [text, example] of [[skillMd(), SKILL_EXAMPLE], [aiGuide(), GUIDE_EXAMPLE]] as const) {
      const json = blocks(text);
      expect(json).toHaveLength(1);
      expect(JSON.parse(json[0])).toEqual(example);
      const r = parseDesign(JSON.parse(json[0]));
      expect(r.ok && r.issues).toEqual([]);
    }
    expect(SKILL_EXAMPLE.nodes.length).toBeLessThan(GUIDE_EXAMPLE.nodes.length);
  });

  it('the frontmatter has only a name (the folder name) and a description of what it does and when to use it', () => {
    const f = front(skillMd());
    expect(Object.keys(f)).toEqual(['name', 'description']);
    expect(f.name).toBe(SKILL_NAME);
    expect(f.name).toMatch(/^[a-z0-9-]{1,64}$/);
    for (const p of ['skills/loadsketch/SKILL.md', 'public/skills/loadsketch/SKILL.md']) expect(p.split('/').at(-2)).toBe(f.name);
    expect(f.description.length).toBeGreaterThan(40);
    expect(f.description.length).toBeLessThanOrEqual(1024);
    expect(f.description).toContain('Use when');
    expect(f.description).not.toMatch(/[<>]/);
  });

  it('the steps name the menus and buttons by their English text in the app', () => {
    const steps = part(skillMd(), '## Steps');
    for (const zh of ['檔案', '貼上設計 JSON', '只複製設計 JSON', '存成 JSON', '換掉畫布']) {
      const en = zh === '檔案' ? `${EN[zh]} →` : `"${EN[zh]}"`;
      expect(steps, zh).toContain(en);
    }
  });

  it('the zip holds loadsketch/SKILL.md and loadsketch/reference.md, the same bytes each time', () => {
    const zip = readFileSync(join(root, 'public/skills/loadsketch.zip'));
    const entries = readStoredZip(zip);
    expect([...entries.keys()]).toEqual(['loadsketch/SKILL.md', 'loadsketch/reference.md']);
    expect(entries.get('loadsketch/SKILL.md')!.toString('utf8')).toBe(read('skills/loadsketch/SKILL.md'));
    expect(entries.get('loadsketch/reference.md')!.toString('utf8')).toBe(read('skills/loadsketch/reference.md'));
    const z = (): Buffer => aiGuideFiles().find(([n]) => n.endsWith('.zip'))![1] as Buffer;
    expect(z().equals(z())).toBe(true);
  });
});

// public/llms.txt (M15): a short index in the llmstxt.org form, every link to a file that exists.
describe('llms.txt', () => {
  it('is an H1, a blockquote summary and lists of links', () => {
    const t = llmsIndex();
    const lines = t.split('\n');
    expect(lines[0]).toBe('# loadsketch');
    expect(lines[2].startsWith('> ')).toBe(true);
    expect(t.match(/^# /gm)).toHaveLength(1);
    expect(lines.length).toBeLessThan(40);
    expect(t).toContain('## Optional');
  });

  it('every link points to a file that exists: on the site (public/), or in the repository', () => {
    const links = [...llmsIndex().matchAll(/\]\((https?:[^)]+)\)/g)].map((m) => m[1]);
    expect(links.length).toBeGreaterThanOrEqual(5);
    const made = new Set(aiGuideFiles().map(([n]) => n));
    for (const url of links) {
      if (url.startsWith(SITE)) {
        const path = `public${url.slice(SITE.length)}`;
        expect(made.has(path), url).toBe(true);
        expect(existsSync(join(root, path)), url).toBe(true);
      } else {
        expect(url.startsWith(`${REPO}/`), url).toBe(true);
        const path = url.slice(REPO.length).replace(/^\/(tree|blob)\/main\//, '');
        expect(existsSync(join(root, path)), url).toBe(true);
      }
    }
    for (const p of Object.values(LLMS_LINKS)) expect(links, p).toContain(`${SITE}${p}`);
  });
});
