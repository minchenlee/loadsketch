// Pasting a design as JSON (roadmap-next M4): what is wrong is said in plain words.
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readPasted, stripFence, jsonProblem, MAX_PROBLEMS } from '../src/app/pasteDesign.ts';
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
});
