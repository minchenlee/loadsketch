// The format guide for AI models (roadmap-next M5): made from the component catalog, kept in
// public/llms.txt, and its example is a valid design.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GUIDE_EXAMPLE, SKILL_NAME, aiGuide, aiPrompt, skillMd } from '../src/schema/aiGuide.ts';
import { EN } from '../src/i18n/en.ts';
import { EDGE_PARAMS, KINDS } from '../src/schema/kinds.ts';
import { ApiSchema, DesignSchema, EdgeSchema, NodeSchema, NoteSchema, parseDesign } from '../src/schema/design.ts';

const file = join(import.meta.dirname, '..', 'public', 'llms.txt');
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


  it('public/llms.txt is the guide made from the catalog now (run npm run ai-guide when this fails)', () => {
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

// The Agent Skill (roadmap-next M12): made from the same guide, in skills/ and served from public/.
describe('agent skill', () => {
  const root = join(import.meta.dirname, '..');
  const files = ['skills/loadsketch/SKILL.md', 'public/skills/loadsketch/SKILL.md'];
  const front = (s: string) => {
    const m = s.match(/^---\n([\s\S]*?)\n---\n/);
    if (!m) throw new Error('no frontmatter');
    return Object.fromEntries(m[1].split('\n').map((l) => {
      const at = l.indexOf(': ');
      const v = l.slice(at + 2);
      return [l.slice(0, at), v.startsWith('"') ? JSON.parse(v) : v];
    }));
  };

  it('SKILL.md in skills/ and in public/ is the skill made from the catalog now (run npm run ai-guide when this fails)', () => {
    for (const f of files) expect(readFileSync(join(root, f), 'utf8'), f).toBe(skillMd());
  });

  it('a change to the catalog changes SKILL.md, so the file check above catches it', () => {
    const spec = KINDS.cache.params;
    spec.zzProbe = { type: 'int', default: 1, min: 0, max: 2, label: 'x', help: 'y' };
    try {
      expect(skillMd()).not.toBe(readFileSync(join(root, files[0]), 'utf8'));
      expect(skillMd()).toContain('`zzProbe`');
    } finally {
      delete spec.zzProbe;
    }
  });

  it('the frontmatter has only a name (the folder name) and a description of what it does and when to use it', () => {
    const f = front(skillMd());
    expect(Object.keys(f)).toEqual(['name', 'description']);
    expect(f.name).toBe(SKILL_NAME);
    expect(f.name).toMatch(/^[a-z0-9-]{1,64}$/);
    for (const p of files) expect(p.split('/').at(-2)).toBe(f.name);
    expect(f.description.length).toBeGreaterThan(40);
    expect(f.description.length).toBeLessThanOrEqual(1024);
    expect(f.description).toContain('Use when');
    expect(f.description).not.toMatch(/[<>]/);
  });

  it('the body holds the steps and the whole guide; its one example passes the schema', () => {
    const s = skillMd();
    expect(s).toContain('## Steps');
    expect(s).toContain(aiGuide());
    expect(s.split('\n').length).toBeLessThan(500);
    const json = blocks(s);
    expect(json).toHaveLength(1);
    const r = parseDesign(JSON.parse(json[0]));
    expect(r.ok && r.issues).toEqual([]);
  });

  it('the steps name the menus and buttons by their English text in the app', () => {
    const steps = section(skillMd(), 'Steps');
    for (const zh of ['檔案', '貼上設計 JSON', '只複製設計 JSON', '存成 JSON', '換掉畫布']) {
      const en = zh === '檔案' ? `${EN[zh]} →` : `"${EN[zh]}"`;
      expect(steps, zh).toContain(en);
    }
  });
});
