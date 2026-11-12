// Share links (M14, Q17=A): the design and the scenario go into the URL after "#".
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeLink, decodeShare, encodeCompare, encodeShare, isShareHash, MAX_SHARE_COMPARE, SHARE_WARN_CHARS } from '../src/app/share.ts';
import { PAIRS } from '../src/app/examples.ts';
import { EXAMPLE_SCENARIO } from '../src/app/exampleScenarios.ts';
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

// A link made before comparison links existed (with the share code of d0d12e4). It must keep opening.
const OLD_LINK =
  's=1.dY-xDsIwDER_BXmORApMmfgHRsQQJW5rNU2qJEVCVf4dBwp0YTzf8529gMVEnQe1QDI9jhoUuKBtGjCbfv92zw0I8HpENoOzO0d-qJPANqjrAmTZmRPGxOOBfJXGEfrMegoVkkLeilhRPdEP5LU7GfySh9OLvQlA260FbQzjpiKHNaRwJh-OXkcK_574-Ns3UkZtH6ztHHWm4C-gjpKTo25bMjUqTtzdSFlKeQI';

describe('comparison links (roadmap-next M3, Q9=A)', () => {
  const pair = (a: string, b: string) => {
    const sc = read<Scenario>('scenarios', `${EXAMPLE_SCENARIO[a] ?? 'steady'}.json`);
    return [
      { name: a, design: read<Design>('designs', `${a}.json`), scenario: sc },
      { name: b, design: read<Design>('designs', `${b}.json`), scenario: sc },
    ];
  };

  it('a link with a comparison gives back both runs, in order, byte for byte', async () => {
    for (const [a, b] of PAIRS) {
      const runs = pair(a, b);
      const hash = await encodeCompare(runs);
      expect(hash).toMatch(/^c=1\.[A-Za-z0-9_-]+$/);
      expect(isShareHash(`#${hash}`)).toBe(true);
      const back = await decodeLink(`#${hash}`);
      expect(back.ok && back.kind, a).toBe('compare');
      if (back.ok && back.kind === 'compare') expect(JSON.stringify(back.runs)).toBe(JSON.stringify(runs));
      // two designs still make a link short enough to paste
      expect(hash.length).toBeLessThan(SHARE_WARN_CHARS);
    }
  });

  it('an old link still opens, through decodeShare and through decodeLink', async () => {
    const want = {
      design: { schema: 'loadsketch/design@1', name: 'old link', nodes: [{ id: 'users', kind: 'client', pos: [0, 0] }, { id: 'api', kind: 'service', pos: [240, 0] }], edges: [{ from: 'users', to: 'api' }] },
      scenario: { schema: 'loadsketch/scenario@1', name: 'steady', durationS: 30, traffic: { rps: 100 } },
    };
    const one = await decodeShare(`#${OLD_LINK}`);
    expect(one.ok && JSON.stringify(one.value)).toBe(JSON.stringify(want));
    const link = await decodeLink(`#${OLD_LINK}`);
    expect(link.ok && link.kind === 'one' && JSON.stringify(link.value)).toBe(JSON.stringify(want));
    // a link made now opens to the same state (the compressed bytes may differ between Node versions)
    const now = await encodeShare(want as unknown as { design: Design; scenario: Scenario });
    expect(now.startsWith('s=1.')).toBe(true);
    const again = await decodeShare(now);
    expect(again.ok && JSON.stringify(again.value)).toBe(JSON.stringify(want));
  });

  it('holds 2 runs: fewer or more is refused when made and when opened', async () => {
    const [a, b] = PAIRS[0];
    const runs = pair(a, b);
    expect(MAX_SHARE_COMPARE).toBe(2);
    await expect(encodeCompare(runs.slice(0, 1))).rejects.toThrow();
    await expect(encodeCompare([...runs, runs[0]])).rejects.toThrow();
    // a hand-made link with three runs
    const three = await encodeCompare(runs);
    const raw = (await decodeLink(three)) as { runs: unknown[] };
    const forged = await encodeCompare(runs).then(async () => {
      const bytes = new TextEncoder().encode(JSON.stringify({ compare: [...raw.runs, raw.runs[0]] }));
      const out = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
      return 'c=1.' + btoa(String.fromCharCode(...out)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    });
    expect((await decodeLink(forged)).ok).toBe(false);
  });

  it('a damaged, cut-off or newer comparison link is an error, not a crash', async () => {
    const hash = await encodeCompare(pair(...PAIRS[1]));
    expect((await decodeLink(hash.slice(0, hash.length / 2))).ok).toBe(false);
    expect((await decodeLink('c=1.!!!')).ok).toBe(false);
    expect((await decodeLink('c=2.abc')).ok).toBe(false);
    // one run with a wrong shape refuses the link
    const runs = pair(...PAIRS[1]);
    runs[1] = { ...runs[1], design: { nodes: 'x' } as unknown as Design };
    expect((await decodeLink(await encodeCompare(runs))).ok).toBe(false);
  });

  it('every pair of examples exists and runs one scenario', () => {
    const names = new Set(designs.map((f) => f.replace(/\.json$/, '')));
    for (const [a, b] of PAIRS) {
      expect(names.has(a) && names.has(b), `${a} / ${b}`).toBe(true);
      expect(EXAMPLE_SCENARIO[a], a).toBe(EXAMPLE_SCENARIO[b]);
    }
    // an example is in one pair at most
    const all = PAIRS.flat();
    expect(new Set(all).size).toBe(all.length);
  });
});
