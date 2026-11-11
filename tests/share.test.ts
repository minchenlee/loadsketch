// Share links (M14, Q17=A): the design and the scenario go into the URL after "#".
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeShare, encodeShare, isShareHash, SHARE_WARN_CHARS } from '../src/app/share.ts';
import type { Design, Scenario } from '../src/schema/design.ts';

const dir = join(import.meta.dirname, '..', 'examples');
const read = <T>(sub: string, f: string): T => JSON.parse(readFileSync(join(dir, sub, f), 'utf8')) as T;
const designs = readdirSync(join(dir, 'designs')).filter((f) => f.endsWith('.json'));
const scenarios = readdirSync(join(dir, 'scenarios')).filter((f) => f.endsWith('.json'));

describe('share links', () => {
  it('every example design survives the round trip, byte for byte', async () => {
    const sc = read<Scenario>('scenarios', scenarios[0]);
    for (const f of designs) {
      const design = read<Design>('designs', f);
      const hash = await encodeShare({ design, scenario: sc });
      expect(hash).toMatch(/^s=1\.[A-Za-z0-9_-]+$/);
      const back = await decodeShare(`#${hash}`);
      expect(back.ok, f).toBe(true);
      if (back.ok) expect(JSON.stringify(back.value)).toBe(JSON.stringify({ design, scenario: sc }));
    }
  });

  it('even the biggest example makes a link short enough to paste', async () => {
    const sizes = await Promise.all(designs.map(async (f) => (await encodeShare({ design: read<Design>('designs', f), scenario: read<Scenario>('scenarios', scenarios[0]) })).length));
    expect(Math.max(...sizes)).toBeLessThan(SHARE_WARN_CHARS / 2);
  });

  it('a damaged, cut-off or unknown link is an error, not a crash', async () => {
    const design = read<Design>('designs', designs[0]);
    const hash = await encodeShare({ design, scenario: read<Scenario>('scenarios', scenarios[0]) });
    expect((await decodeShare(hash.slice(0, hash.length / 2))).ok).toBe(false);
    expect((await decodeShare('s=1.!!!')).ok).toBe(false);
    expect((await decodeShare('s=9.abc')).ok).toBe(false);
    expect((await decodeShare('example=x')).ok).toBe(false);
    expect(isShareHash('#s=1.abc')).toBe(true);
    expect(isShareHash('#top')).toBe(false);
  });

  it('a link with a wrong shape is refused; a design with check errors still opens', async () => {
    const sc = read<Scenario>('scenarios', scenarios[0]);
    const notADesign = await encodeShare({ design: { nodes: 'x' } as unknown as Design, scenario: sc });
    expect((await decodeShare(notADesign)).ok).toBe(false);
    // an edge to a node that does not exist: checkDesign finds it, the editor shows it
    const broken = { ...read<Design>('designs', designs[0]) };
    broken.edges = [...broken.edges, { from: broken.nodes[0].id, to: 'nowhere' }];
    expect((await decodeShare(await encodeShare({ design: broken, scenario: sc }))).ok).toBe(true);
  });
});
