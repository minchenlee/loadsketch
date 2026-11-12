// Pasting a design as JSON (roadmap-next M4): what is wrong is said in plain words.
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { keepSources, readPasted, stripFence, jsonProblem, blankStrings, MAX_PROBLEMS, MAX_PASTE_CHARS } from '../src/app/pasteDesign.ts';
import { cpuMs } from './helpers.ts';
import { diffDesigns } from '../src/app/designDiff.ts';
import { importTerraform } from '../src/import/terraform/index.ts';
import type { Design } from '../src/schema/design.ts';
import { setLang } from '../src/i18n/index.ts';

const root = join(import.meta.dirname, '..');
const text = readFileSync(join(root, 'examples/designs/three-tier.json'), 'utf8');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const edit = (f: (d: any) => void) => {
  const d = JSON.parse(text);
  f(d);
  return JSON.stringify(d, null, 2);
};
const problems = (s: string) => {
  const r = readPasted(s);
  if (r.ok) throw new Error('expected problems');
  return r.problems;
};

beforeEach(() => setLang('zh-TW'));

describe('paste design', () => {
  it('a valid design is read, also inside a Markdown code fence', () => {
    const r = readPasted(text);
    expect(r.ok).toBe(true);
    const fenced = readPasted('```json\n' + text + '\n```');
    expect(fenced.ok && fenced.design).toEqual(JSON.parse(text));
    expect(stripFence('```\n{}\n```')).toBe('{}');
  });

  it('nothing pasted, and JSON that is not a design', () => {
    expect(problems('   ')).toEqual(['沒有內容。貼上一份設計的 JSON。']);
    expect(problems('[1, 2]')[0]).toContain('不是一份設計');
  });

  it('a JSON slip: the line and column, and the usual cause', () => {
    const p = problems('{\n  "name": "x",\n}');
    expect(p[0]).toMatch(/^這不是有效的 JSON：第 3 行第 1 個字附近有問題。/);
    expect(p[0]).toContain('多了逗號');
    expect(problems("{'name': 'x'}")[0]).toContain('雙引號');
    expect(problems('{name: 1}')[0]).toContain('欄位名稱要加雙引號');
    // messages from other browsers: line and column, a position, or neither
    expect(jsonProblem('{\n}', 'JSON.parse: expected property name at line 2 column 1 of the JSON data')).toContain('第 2 行第 1 個字');
    expect(jsonProblem('ab\ncd', 'Unexpected token in JSON at position 4')).toContain('第 2 行第 2 個字');
    expect(jsonProblem('{', "JSON Parse error: Expected '}'")).toBe('這不是有效的 JSON。');
  });

  it('format problems name the component or line, the field, what is there and what is expected', () => {
    expect(problems(edit((d) => delete d.schema))).toEqual(['第一行要寫 "schema": "loadsketch/design@1"，說這是 loadsketch 的設計。現在是沒有填。']);
    expect(problems(edit((d) => (d.nodes[2].params.instances = '3')))).toEqual(['元件「api」（第 3 個）的設定「instances」要是數字，現在是文字 "3"。']);
    expect(problems(edit((d) => (d.nodes[2].params.instances = 0)))).toEqual(['元件「api」（第 3 個）的設定「instances」至少要是 1，現在是 0。']);
    expect(problems(edit((d) => (d.nodes[2].params.instanecs = 3)))).toEqual(['元件「api」（第 3 個）沒有「instanecs」這個欄位。是不是「instances」？']);
    expect(problems(edit((d) => (d.nodes[2].instances = 3)))).toEqual(['元件「api」（第 3 個）的「instances」要放在 "params" 裡面：{"params": {"instances": …}}。']);
    expect(problems(edit((d) => delete d.nodes[0].pos))).toEqual(['元件「users」（第 1 個）的「pos」沒有填，這一項一定要有。']);
    expect(problems(edit((d) => (d.nodes[1].kind = 'loadbalancer')))).toEqual(['元件「lb」（第 2 個）的種類 "loadbalancer" 不存在。是不是 "load_balancer"？']);
    expect(problems(edit((d) => (d.nodes[1].kind = 'spaceship')))[0]).toMatch(/沒有這種元件。可以用的種類：client, dns, /);
    expect(problems(edit((d) => (d.nodes[0].id = 'my users')))[0]).toContain('不能有空白');
    expect(problems(edit((d) => (d.edges[0].timeout = 5)))).toEqual([expect.stringMatching(/^第 1 條線（users → lb）沒有「timeout」這個欄位。是不是「timeoutMs」？$/)]);
    expect(problems(edit((d) => (d.apis = [{ name: 'a', op: 'get' }])))).toEqual(['API「a」的「op」要是 "read"、"write" 其中一個，現在是文字 "get"。']);
    expect(problems(edit((d) => (d.nodes[2].params.serviceMs = { mean: 'x' })))).toEqual(['元件「api」（第 3 個）的設定「serviceMs.mean」要是數字，現在是文字 "x"。']);
    expect(problems(edit((d) => (d.foo = 1)))[0]).toMatch(/^設計沒有「foo」這個欄位。可以用的有：schema, name, /);
  });

  it('an unknown field inside a nested object is matched against that object\'s own fields (M4 review P2)', () => {
    expect(problems(edit((d) => (d.nodes[2].params.serviceMs = { mean: 10, cvv: 1 })))).toEqual(['元件「api」（第 3 個）的設定「serviceMs」沒有「cvv」這個欄位。是不是「cv」？']);
    const p = problems(edit((d) => (d.nodes[2].params.serviceMs = { mean: 10, instances: 1 })));
    expect(p).toEqual(['元件「api」（第 3 個）的設定「serviceMs」沒有「instances」這個欄位。可以用的有：mean, cv。']);
    // an object of its own: a note
    expect(problems(edit((d) => (d.notes = [{ id: 'n1', text: 'x', pos: [0, 0], widht: 200 }])))).toEqual(['第 1 個便利貼沒有「widht」這個欄位。是不是「width」？']);
  });

  it('the hint for a JSON slip does not read inside strings (M4 review P2/P3)', () => {
    // a URL in a string is not a comment; a broken file without a known cause gets no hint
    const p = problems('{\n  "description": "see https://example.com",\n  "name": "x"\n  "nodes": []\n}');
    expect(p[0]).not.toContain('註解');
    expect(p[0]).toMatch(/^這不是有效的 JSON：第 4 行/);
    expect(problems('{\n  "name": "a, }",\n  "x" 1\n}')[0]).not.toContain('逗號');
    expect(problems('{\n  "name": "it\'s: ok",\n  "x" 1\n}')[0]).not.toContain('單引號');
    expect(problems('{\n  "name": "a b: c",\n  "x" 1\n}')[0]).not.toContain('欄位名稱要加雙引號');
    // a real comment still gets it
    expect(problems('{\n  // the name\n  "name": "x"\n}')[0]).toContain('註解');
  });

  it('the hint scan is linear: a broken 256 KB paste full of escaped quotes reads at once (M4 review round 2)', () => {
    const bad = '{"a": "' + '\\"'.repeat(128 * 1024);
    expect(bad.length).toBeGreaterThan(256 * 1024);
    let p!: ReturnType<typeof readPasted>;
    expect(cpuMs(() => (p = readPasted(bad)))).toBeLessThan(300);
    expect(p.ok).toBe(false);
    // the same strings as the old pattern: closed ones emptied; one not closed on its line left as it is
    expect(blankStrings('{"a": "x\\"y", "b": 1}')).toBe('{"": "", "": 1}');
    expect(blankStrings('{"a": "no end\n"b": "x"}')).toBe('{"": "no end\n"": ""}');
    expect(blankStrings('"a\\\nb"')).toBe('"a\\\nb"');
  });

  it('a paste bigger than 2 MB is not read: it is said to be too big', () => {
    const p = problems(' '.repeat(MAX_PASTE_CHARS + 1));
    expect(p).toHaveLength(1);
    expect(p[0]).toContain('太大');
    expect(MAX_PASTE_CHARS).toBe(2 * 1024 * 1024);
  });

  it('design checks after the format: a line to a component that is not there', () => {
    const p = problems(edit((d) => d.edges.push({ from: 'api', to: 'nowhere' })));
    expect(p.join(' ')).toContain('nowhere');
  });

  it('many problems: the first ones, then a count', () => {
    const p = problems(edit((d) => d.nodes.forEach((n: { pos?: unknown }) => delete n.pos)));
    expect(p.length).toBeLessThanOrEqual(MAX_PROBLEMS + 1);
    const many = problems(edit((d) => { for (let i = 0; i < 12; i++) d[`x${i}`] = 1; }));
    expect(many).toHaveLength(1); // one issue lists every key
    const p2 = problems(edit((d) => { for (let i = 0; i < 12; i++) d.edges.push({ from: 'api', to: 'db', bad: i }); }));
    expect(p2).toHaveLength(MAX_PROBLEMS + 1);
    expect(p2.at(-1)).toMatch(/^還有 \d+ 個問題/);
  });

  it('in English too', () => {
    setLang('en');
    const p = problems(edit((d) => (d.nodes[2].params.instances = '3')));
    expect(p[0]).not.toMatch(/[一-鿿]/);
  });

  describe('sources from the Terraform import (M5 review P2)', () => {
    const canvas = importTerraform(JSON.parse(readFileSync(join(root, 'tests/import/fixtures/ecs-rds.plan.json'), 'utf8'))).design;
    // what a model gives back when it drops every source
    const bare = (): Design => JSON.parse(JSON.stringify(canvas, (k, v) => (k === 'source' ? undefined : v)));
    const keep = (d: Design) => keepSources(canvas, d, diffDesigns(canvas, d));

    it('the fixture has sources on nodes and edges, and the change list does not see them go', () => {
      expect(canvas.nodes.filter((n) => n.source).length).toBeGreaterThan(1);
      expect(canvas.edges.filter((e) => e.source).length).toBeGreaterThan(1);
      expect(diffDesigns(canvas, bare())).toEqual([]);
    });

    it('a component or line that is otherwise the same gets its source back from the canvas', () => {
      const k = keep(bare());
      expect(k.restored).toBe(canvas.nodes.filter((n) => n.source).length + canvas.edges.filter((e) => e.source).length);
      expect(k.dropped).toBe(0);
      expect(k.design).toEqual(canvas);
    });

    it('a value the answer changed is marked as the user\'s, as the inspector does; the resource stays (M5 review round 2)', () => {
      // the model kept every source, as told, and changed one imported value
      const d = JSON.parse(JSON.stringify(canvas)) as Design;
      const api = d.nodes.find((x) => x.id === 'ecs_service_api')!;
      expect(api.source!.params!.instances).toMatchObject({ evidence: 'iac', from: 'aws_ecs_service.api.desired_count' });
      (api.params as Record<string, unknown>).instances = 9;
      const k = keep(d);
      const src = k.design.nodes.find((x) => x.id === 'ecs_service_api')!.source!;
      expect(src.params!.instances).toEqual({ evidence: 'answer', role: 'setting' });
      expect(src.params!.maxInstances).toEqual(canvas.nodes.find((x) => x.id === 'ecs_service_api')!.source!.params!.maxInstances);
      expect(src.from).toEqual(['aws_ecs_service.api']);
      expect(k).toMatchObject({ restored: 0, edited: 1, dropped: 0 });
      // the canvas is not changed
      expect(canvas.nodes.find((x) => x.id === 'ecs_service_api')!.source!.params!.instances!.evidence).toBe('iac');
    });

    it('a changed component or line that lost its source gets it back, with the changed values marked', () => {
      const d = bare();
      const n = d.nodes.find((x) => x.id === 'ecs_service_api')!;
      (n.params as Record<string, unknown>).instances = 9;
      const e = d.edges.find((x) => x.from === 'ecs_service_api' && x.to === 'db_instance_main')!;
      e.timeoutMs = 1234;
      const k = keep(d);
      const all = canvas.nodes.filter((x) => x.source).length + canvas.edges.filter((x) => x.source).length;
      expect(k).toMatchObject({ restored: all, edited: 2, dropped: 0 });
      expect(k.design.nodes.find((x) => x.id === n.id)!.source!.params!.instances!.evidence).toBe('answer');
      expect(k.design.edges.find((x) => x.from === e.from && x.to === e.to)!.source!.params!.timeoutMs).toEqual({ evidence: 'answer', role: 'setting' });
      // a component that became another kind: its old source does not fit, so it is only counted
      const other = bare();
      other.nodes.find((x) => x.id === 'db_instance_main')!.kind = 'sharded_db' as never;
      expect(keep(other).dropped).toBe(1);
    });

    it('lines with the same caller and callee and new ids get their own sources back, in the change list\'s order (M5 review round 3)', () => {
      const two = {
        schema: 'loadsketch/design@1',
        name: 'two',
        nodes: [{ id: 'a', kind: 'service', pos: [0, 0] }, { id: 'b', kind: 'database', pos: [300, 0] }],
        edges: [
          { id: 'r', from: 'a', to: 'b', on: 'read', timeoutMs: 100, source: { line: 'definite', via: ['read.env'], params: { timeoutMs: { evidence: 'iac', role: 'setting', from: 'read.timeout' } } } },
          { id: 'w', from: 'a', to: 'b', on: 'write', timeoutMs: 100, source: { line: 'presumed', via: ['write.env'], params: { timeoutMs: { evidence: 'iac', role: 'setting', from: 'write.timeout' } } } },
        ],
      } as unknown as Design;
      const pasted = JSON.parse(JSON.stringify(two, (k, v) => (k === 'source' ? undefined : v))) as Design;
      pasted.edges[0].id = 'r2';
      pasted.edges[1].id = 'w2';
      expect(diffDesigns(two, pasted)).toEqual([]);
      const k = keepSources(two, pasted, diffDesigns(two, pasted));
      expect(k.design.edges.map((e) => e.source)).toEqual(two.edges.map((e) => e.source));
    });

    it('a line that kept its id but goes to another component does not keep the old line\'s evidence (M5 review round 3)', () => {
      for (const kept of [false, true]) {
        const d = kept ? (JSON.parse(JSON.stringify(canvas)) as Design) : bare();
        d.nodes.push({ id: 'cache', kind: 'cache', pos: [600, 400] } as Design['nodes'][number]);
        const e = d.edges.find((x) => x.id === 'ecs_service_api-db_instance_main')!;
        e.to = 'cache';
        e.timeoutMs = 200;
        const k = keepSources(canvas, d, diffDesigns(canvas, d));
        const src = k.design.edges.find((x) => x.id === e.id)!.source!;
        // the user's answer drew this line: no Terraform resources say it is there
        expect(src.line).toBe('answer');
        expect(src.via).toBeUndefined();
        expect(src.params?.timeoutMs).toEqual({ evidence: 'answer', role: 'setting' });
        expect(k.rewired).toBe(1);
      }
    });

    it('at the size limit of the format: 2000 lines, half of them with a new id, in well under a second', () => {
      const nodes = Array.from({ length: 300 }, (_, i) => ({ id: `n${i}`, kind: 'service', pos: [0, 0] }));
      const edges = Array.from({ length: 2000 }, (_, i) => ({ from: `n${i % 300}`, to: `n${(i * 7 + 1 + Math.floor(i / 300)) % 300}`, source: { line: 'definite' } }));
      const big = { schema: 'loadsketch/design@1', name: 'big', nodes, edges } as unknown as Design;
      const pasted = JSON.parse(JSON.stringify(big, (k, v) => (k === 'source' ? undefined : v))) as Design;
      pasted.edges.forEach((e, i) => { if (i % 2) e.id = `x${i}`; });
      const changes = diffDesigns(big, pasted);
      let k!: ReturnType<typeof keepSources>;
      expect(cpuMs(() => (k = keepSources(big, pasted, changes)))).toBeLessThan(300);
      expect(k.restored).toBe(2000);
    });

    it('a source the paste kept is left alone; a design with no sources is returned as it is', () => {
      const k = keep(JSON.parse(JSON.stringify(canvas)));
      expect(k).toMatchObject({ restored: 0, dropped: 0 });
      const plain = JSON.parse(text) as Design;
      const p = keepSources(plain, plain, []);
      expect(p.design).toBe(plain);
    });
  });
});
