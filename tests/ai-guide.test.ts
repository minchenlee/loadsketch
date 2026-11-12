// The format guide for AI models (roadmap-next M5): made from the component catalog, kept in
// public/llms.txt, and its example is a valid design.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GUIDE_EXAMPLE, aiGuide, aiPrompt } from '../src/schema/aiGuide.ts';
import { EDGE_PARAMS, KINDS } from '../src/schema/kinds.ts';
import { parseDesign } from '../src/schema/design.ts';

const file = join(import.meta.dirname, '..', 'public', 'llms.txt');
const blocks = (s: string) => [...s.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => m[1]);

describe('ai guide', () => {
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
