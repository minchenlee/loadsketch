// Pasting a design as JSON (roadmap-next M4): the text an AI or a person gives back is read here.
// What is wrong is said in plain words, with where it is (which component, which line) and what was
// expected, not as a schema path. Nothing here touches the canvas: the dialog shows the result.
import type { z } from 'zod';
import { DesignSchema, checkDesign, edgeId, type Design, type DesignEdge, type Issue, type ParamSource } from '../schema/design.ts';
import { editedSources } from './sources.ts';
import type { Change } from './designDiff.ts';
import { KINDS } from '../schema/kinds.ts';
import { t, tx } from '../i18n/index.ts';

export type PasteResult =
  | { ok: true; design: Design; warnings: string[] }
  | { ok: false; problems: string[] };

/** At most this many problems are listed; the rest is a count. */
export const MAX_PROBLEMS = 8;

/** The JSON inside the text: a Markdown code fence around it (as chat answers give it) is taken off. */
export function stripFence(text: string): string {
  const s = text.trim();
  const m = /^```[\w-]*[ \t]*\r?\n([\s\S]*?)\r?\n?```$/.exec(s);
  return m ? m[1].trim() : s;
}

/** A paste longer than this is not read (a design at the format's limits is well under it). */
export const MAX_PASTE_CHARS = 2 * 1024 * 1024;

export function readPasted(text: string): PasteResult {
  if (text.length > MAX_PASTE_CHARS) return { ok: false, problems: [t('貼上的內容太大（{mb} MB）。一份設計最多 {max} MB：只貼設計的 JSON。', { mb: (text.length / 1024 / 1024).toFixed(1), max: MAX_PASTE_CHARS / 1024 / 1024 })] };
  const src = stripFence(text);
  if (!src) return { ok: false, problems: [t('沒有內容。貼上一份設計的 JSON。')] };
  let value: unknown;
  try {
    value = JSON.parse(src);
  } catch (e) {
    return { ok: false, problems: [jsonProblem(src, (e as Error).message)] };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, problems: [t('這段 JSON 不是一份設計：設計是一個物件，裡面有 schema、name、nodes 和 edges。')] };
  const r = DesignSchema.safeParse(value);
  if (!r.success) return { ok: false, problems: limit(r.error.issues.map((i) => schemaProblem(value as Record<string, unknown>, i))) };
  const d = value as Design;
  const issues = checkDesign(d);
  const errors = issues.filter((i) => i.level === 'error');
  if (errors.length) return { ok: false, problems: limit(errors.map((i) => i.message)) };
  return { ok: true, design: d, warnings: issues.filter((i: Issue) => i.level === 'warning').map((i) => i.message) };
}

function limit(list: string[]): string[] {
  const uniq = [...new Set(list)];
  return uniq.length > MAX_PROBLEMS ? [...uniq.slice(0, MAX_PROBLEMS), t('還有 {n} 個問題。先改上面這些。', { n: uniq.length - MAX_PROBLEMS })] : uniq;
}

/** A JSON syntax error: the line and column (each browser words the message differently), and a hint for the usual slips. */
export function jsonProblem(src: string, message: string): string {
  let line: number | undefined;
  let col: number | undefined;
  const lc = /line (\d+) column (\d+)/i.exec(message);
  const pos = /position (\d+)/i.exec(message);
  if (lc) [line, col] = [+lc[1], +lc[2]];
  else if (pos) {
    const before = src.slice(0, +pos[1]).split('\n');
    [line, col] = [before.length, before[before.length - 1].length + 1];
  }
  const where = line ? t('第 {line} 行第 {col} 個字附近', { line, col: col ?? 1 }) : '';
  // the usual slips are looked for outside the strings: a URL in a description is not a comment
  const bare = blankStrings(src);
  const hint = /,\s*[}\]]/.test(bare)
    ? t('最後一項後面多了逗號。')
    : /'[^'\n]*'\s*:/.test(bare)
      ? t('JSON 的名稱和文字要用雙引號 "，不能用單引號。')
      : /(^|[{,]\s*)[A-Za-z_][\w-]*\s*:/m.test(bare)
        ? t('欄位名稱要加雙引號，例如 "nodes"。')
        : /\/\/|\/\*/.test(bare)
          ? t('JSON 不能有註解（// 或 /* */）。')
          : '';
  return [where ? t('這不是有效的 JSON：{where}有問題。', { where }) : t('這不是有效的 JSON。'), hint].filter(Boolean).join(' ');
}

/**
 * The text with each string's content taken out ("…" becomes ""), in one pass (M4 review round 2: a
 * pattern retried at every quote took quadratic time on a long unclosed string). A string not closed
 * on its line is left as it is: it is not a string to JSON either.
 */
export function blankStrings(src: string): string {
  const out: string[] = [];
  let from = 0;
  let i = 0;
  const n = src.length;
  while (i < n) {
    if (src.charCodeAt(i) !== 34) {
      i++;
      continue;
    }
    let j = i + 1;
    let closed = false;
    while (j < n) {
      const c = src[j];
      if (c === '"') {
        closed = true;
        break;
      }
      if (c === '\n') break;
      if (c === '\\') {
        if (j + 1 < n && src[j + 1] !== '\n') {
          j += 2;
          continue;
        }
        break;
      }
      j++;
    }
    if (closed) {
      out.push(src.slice(from, i), '""');
      i = from = j + 1;
    } else i = j; // every quote up to here is inside the unclosed one: none of them closes either
  }
  out.push(src.slice(from));
  return out.join('');
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

/** Where a path points, in words: the component or line by its id, then the field. */
export function wherePath(d: Obj, path: PropertyKey[]): string {
  const [top, i, ...rest] = path;
  const field = (keys: PropertyKey[]) => (keys.length ? t('的「{field}」', { field: keys.map(String).join('.') }) : '');
  if (top === 'nodes' && typeof i === 'number') {
    const n = (d.nodes as unknown[])[i];
    const id = isObj(n) && typeof n.id === 'string' ? n.id : '';
    const keys = rest[0] === 'params' ? rest.slice(1) : rest;
    const head = id ? t('元件「{id}」（第 {n} 個）', { id, n: i + 1 }) : t('第 {n} 個元件', { n: i + 1 });
    return head + (rest[0] === 'params' && keys.length ? t('的設定「{field}」', { field: keys.map(String).join('.') }) : field(keys));
  }
  if (top === 'edges' && typeof i === 'number') {
    const e = (d.edges as unknown[])[i];
    const ends = isObj(e) && typeof e.from === 'string' && typeof e.to === 'string' ? `${e.from} → ${e.to}` : '';
    return (ends ? t('第 {n} 條線（{ends}）', { n: i + 1, ends }) : t('第 {n} 條線', { n: i + 1 })) + field(rest);
  }
  if (top === 'apis' && typeof i === 'number') {
    const a = (d.apis as unknown[])[i];
    const name = isObj(a) && typeof a.name === 'string' ? a.name : '';
    return (name ? t('API「{name}」', { name }) : t('第 {n} 個 API', { n: i + 1 })) + field(rest);
  }
  if (top === 'notes' && typeof i === 'number') return t('第 {n} 個便利貼', { n: i + 1 }) + field(rest);
  if (top === undefined) return t('設計');
  return t('欄位「{field}」', { field: path.map(String).join('.') });
}

function valueAt(d: unknown, path: PropertyKey[]): unknown {
  let v = d;
  for (const k of path) v = isObj(v) || Array.isArray(v) ? (v as Record<PropertyKey, unknown>)[k as never] : undefined;
  return v;
}

/** A value, as it would be said: text "x", a number, a list… */
function said(v: unknown): string {
  if (v === undefined) return t('沒有填');
  if (v === null) return 'null';
  if (typeof v === 'string') return t('文字 "{v}"', { v: v.length > 40 ? `${v.slice(0, 40)}…` : v });
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return t('一個清單');
  return t('一個物件');
}

const TYPE_WORD: Record<string, string> = {
  number: tx('數字'),
  string: tx('文字'),
  boolean: tx('true 或 false'),
  array: tx('清單 [...]'),
  tuple: tx('清單 [x, y]'),
  object: tx('物件 {...}'),
};

/** Zod's own description of a schema (v4: `_zod.def`). */
type Def = { type: string; shape?: Record<string, Schema>; element?: Schema; innerType?: Schema; options?: Schema[]; discriminator?: string; items?: Schema[] };
type Schema = { _zod: { def: Def } };
const defOf = (x: Schema): Def => x._zod.def;

/** The schema at a path of the design, following the data (a node's kind picks its schema, a value picks the form of a union). */
function schemaAt(d: unknown, path: PropertyKey[]): Schema | undefined {
  let sch: Schema | undefined = DesignSchema as unknown as Schema;
  let v: unknown = d;
  const settle = () => {
    for (let guard = 0; sch && guard < 20; guard++) {
      const def = defOf(sch);
      if (def.type === 'optional' || def.type === 'nullable' || def.type === 'default') sch = def.innerType;
      else if (def.type === 'union' && def.options) {
        const opts = def.options;
        // a discriminated union (the node kinds): the option with this kind
        const disc = def.discriminator;
        const picked = disc && isObj(v)
          ? opts.find((o) => { const sh = defOf(o).shape?.[disc]; return !!sh && (defOf(sh) as { values?: unknown[] }).values?.includes(v![disc as keyof typeof v]); })
          : opts.find((o) => (isObj(v) ? defOf(o).type === 'object' : Array.isArray(v) ? ['array', 'tuple'].includes(defOf(o).type) : !['object', 'array', 'tuple'].includes(defOf(o).type)));
        sch = picked;
      } else return;
    }
  };
  settle();
  for (const k of path) {
    if (!sch) return undefined;
    const def = defOf(sch);
    sch = def.type === 'object' ? def.shape?.[k as string] : def.type === 'array' ? def.element : def.type === 'tuple' ? def.items?.[k as number] : undefined;
    v = isObj(v) || Array.isArray(v) ? (v as Record<PropertyKey, unknown>)[k as never] : undefined;
    settle();
  }
  return sch;
}

/** The keys a place accepts, to guess what a key that is not known was meant to be. */
function knownKeys(d: Obj, path: PropertyKey[]): string[] {
  const sch = schemaAt(d, path);
  const def = sch && defOf(sch);
  return def?.type === 'object' && def.shape ? Object.keys(def.shape) : [];
}

/** Edit distance where two letters swapped count as one edit (widht → width). */
function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  return d[a.length][b.length];
}

function closest(key: string, known: string[]): string | undefined {
  const k = key.toLowerCase();
  // a unit left off or added: timeout for timeoutMs
  const prefix = k.length >= 4 ? known.find((c) => c.toLowerCase().startsWith(k) || k.startsWith(c.toLowerCase())) : undefined;
  if (prefix) return prefix;
  let best: string | undefined;
  let bestD = Infinity;
  for (const c of known) {
    const dd = c.toLowerCase() === k ? 0 : distance(k, c.toLowerCase());
    if (dd < bestD) [best, bestD] = [c, dd];
  }
  return best !== undefined && bestD <= Math.max(1, Math.floor(key.length / 4)) ? best : undefined;
}

function unknownKey(d: Obj, path: PropertyKey[], key: string): string {
  const where = wherePath(d, path);
  const [top, i] = path;
  // a parameter written next to id and kind instead of under params
  if (top === 'nodes' && typeof i === 'number' && path.length === 2) {
    const n = (d.nodes as unknown[])[i];
    const spec = isObj(n) && typeof n.kind === 'string' ? KINDS[n.kind] : undefined;
    if (spec && key in spec.params) return t('{where}的「{key}」要放在 "params" 裡面：{"params": {"{key}": …}}。', { where, key });
  }
  const guess = closest(key, knownKeys(d, path));
  if (guess) return t('{where}沒有「{key}」這個欄位。是不是「{guess}」？', { where, key, guess });
  const known = knownKeys(d, path);
  return known.length
    ? t('{where}沒有「{key}」這個欄位。可以用的有：{known}。', { where, key, known: known.join(', ') })
    : t('{where}沒有「{key}」這個欄位。', { where, key });
}

/** One schema issue, in plain words. */
function schemaProblem(d: Obj, issue: z.core.$ZodIssue, prefix: PropertyKey[] = []): string {
  const path = [...prefix, ...issue.path];
  const where = wherePath(d, path);
  const v = valueAt(d, path);
  switch (issue.code) {
    case 'invalid_type':
      if (v === undefined) return t('{where}沒有填，這一項一定要有。', { where });
      return t('{where}要是{type}，現在是{v}。', { where, type: t(TYPE_WORD[issue.expected] ?? issue.expected), v: said(v) });
    case 'too_small':
    case 'too_big': {
      const bound = issue.code === 'too_small' ? issue.minimum : issue.maximum;
      if (Array.isArray(v) || issue.origin === 'array') return issue.code === 'too_small' ? t('{where}至少要有 {n} 項。', { where, n: String(bound) }) : t('{where}最多 {n} 項。', { where, n: String(bound) });
      if (typeof v === 'string') return issue.code === 'too_small' ? t('{where}不能是空的。', { where }) : t('{where}太長了，最多 {n} 個字。', { where, n: String(bound) });
      if (issue.code === 'too_small') return issue.inclusive ? t('{where}至少要是 {n}，現在是 {v}。', { where, n: String(bound), v: said(v) }) : t('{where}要大於 {n}，現在是 {v}。', { where, n: String(bound), v: said(v) });
      return issue.inclusive ? t('{where}最多是 {n}，現在是 {v}。', { where, n: String(bound), v: said(v) }) : t('{where}要小於 {n}，現在是 {v}。', { where, n: String(bound), v: said(v) });
    }
    case 'unrecognized_keys':
      return issue.keys.map((k) => unknownKey(d, path, k)).join(' ');
    case 'invalid_value': {
      const values = issue.values.map((x) => JSON.stringify(x));
      if (path.length === 1 && path[0] === 'schema') return t('第一行要寫 "schema": "{schema}"，說這是 loadsketch 的設計。現在是{v}。', { schema: String(issue.values[0]), v: said(v) });
      return values.length === 1 ? t('{where}要是 {values}，現在是{v}。', { where, values: values[0], v: said(v) }) : t('{where}要是 {values} 其中一個，現在是{v}。', { where, values: values.join('、'), v: said(v) });
    }
    case 'invalid_union': {
      // the kind of a component: name the kinds there are
      if ('discriminator' in issue && issue.discriminator === 'kind') {
        const kinds = (issue as { options?: unknown[] }).options?.map(String) ?? Object.keys(KINDS);
        const guess = typeof v === 'string' ? closest(v.replace(/[\s-]/g, '_'), kinds) : undefined;
        return guess
          ? t('{where}的種類 {v} 不存在。是不是 "{guess}"？', { where: wherePath(d, path.slice(0, -1)), v: JSON.stringify(v), guess })
          : t('{where}的種類是{v}，沒有這種元件。可以用的種類：{kinds}。', { where: wherePath(d, path.slice(0, -1)), v: said(v), kinds: kinds.join(', ') });
      }
      // a value with two forms (a number, or {mean, cv}): say what went wrong in the form it has
      const branches = issue.errors.filter((b) => b.length);
      const deepest = branches.sort((a, b) => Math.max(...b.map((x) => x.path.length)) - Math.max(...a.map((x) => x.path.length)))[0];
      if (deepest && deepest.some((x) => x.path.length)) return schemaProblem(d, deepest[0], path);
      return t('{where}的寫法不對，現在是{v}。', { where, v: said(v) });
    }
    case 'invalid_format':
      return path[path.length - 1] === 'id' || path[path.length - 2] === 'apis' || ['from', 'to'].includes(String(path[path.length - 1]))
        ? t('{where}是{v}：id 要用英數字開頭，只能有英數字、底線 _ 和連字號 -，最多 48 個字，不能有空白。', { where, v: said(v) })
        : t('{where}的格式不對，現在是{v}。', { where, v: said(v) });
    default:
      return `${where}：${issue.message}`;
  }
}

/** What `keepSources` did: the design to load, and what it did to the sources. */
export interface KeptSources {
  design: Design;
  /** Components and lines that lost their `source`: put back from the canvas. */
  restored: number;
  /** Imported values the answer changed: their source now says the user gave them, as in the inspector. */
  edited: number;
  /** Components that lost their `source` and became another kind: the old source would not fit. */
  dropped: number;
}

type Patch = Record<string, unknown>;

/**
 * A design from the Terraform import has `source` on its components and lines (M5 review P2). A model
 * can leave it out, and the change list does not compare it: a component or line that lost it gets it
 * back from the canvas (the resource it stands for has not changed). A value the answer changed is
 * no longer the one from Terraform: its source is classed again with editedSources(), as when the
 * value is typed in the inspector (M5 review round 2). A component that became another kind is only
 * counted. Linear in the size of the designs: it runs while the dialog renders.
 */
export function keepSources(canvas: Design, pasted: Design, changes: Change[]): KeptSources {
  let restored = 0;
  let edited = 0;
  let dropped = 0;
  // what changed, from the change list: values by component and by line, and components of another kind
  const pn = new Map(pasted.nodes.map((n) => [n.id, n]));
  const pe = new Map(pasted.edges.map((e) => [edgeId(e), e]));
  const nodePatch = new Map<string, Patch>();
  const edgePatch = new Map<string, Patch>();
  const otherKind = new Set<string>();
  const add = (m: Map<string, Patch>, id: string, k: string, v: unknown) => {
    let p = m.get(id);
    if (!p) m.set(id, (p = {}));
    p[k] = v;
  };
  for (const c of changes) {
    if (c.type === 'node-changed') {
      if (c.field === 'kind') otherKind.add(c.node);
      else if (c.field.startsWith('params.')) {
        const k = c.field.slice('params.'.length);
        add(nodePatch, c.node, k, (pn.get(c.node)?.params as Patch | undefined)?.[k]);
      }
    } else if (c.type === 'edge-changed' && c.field !== 'from' && c.field !== 'to') {
      add(edgePatch, c.edge, c.field, (pe.get(c.edge) as unknown as Patch | undefined)?.[c.field]);
    }
  }
  const classed = <S extends { params?: Record<string, ParamSource> }>(s: S, patch: Patch | undefined): S => {
    if (!patch) return s;
    edited += Object.keys(patch).length;
    return { ...s, params: editedSources(s.params, patch) };
  };

  const cn = new Map(canvas.nodes.map((n) => [n.id, n]));
  const nodes = pasted.nodes.map((n) => {
    const was = cn.get(n.id);
    const lost = !n.source && !!was?.source;
    if (lost && otherKind.has(n.id)) return dropped++, n;
    const source = n.source ?? (lost ? was!.source : undefined);
    if (!source) return n;
    if (lost) restored++;
    const next = classed(source, nodePatch.get(n.id));
    return next === n.source ? n : { ...n, source: next };
  });

  // lines: by id, then by caller and callee, as the change list matches them
  const byId = new Map(canvas.edges.map((e) => [edgeId(e), e]));
  const pastedIds = new Set(pe.keys());
  const byEnds = new Map<string, DesignEdge[]>();
  for (const x of canvas.edges) {
    if (pastedIds.has(edgeId(x))) continue;
    const key = `${x.from}\u0000${x.to}`;
    const list = byEnds.get(key);
    if (list) list.push(x);
    else byEnds.set(key, [x]);
  }
  const used = new Set<DesignEdge>();
  const match = (e: DesignEdge) => {
    let m = byId.get(edgeId(e));
    if (m && used.has(m)) m = undefined;
    if (!m) {
      const list = byEnds.get(`${e.from}\u0000${e.to}`);
      while (list?.length && used.has(list[list.length - 1])) list.pop();
      m = list?.pop();
    }
    if (m) used.add(m);
    return m;
  };
  const edges = pasted.edges.map((e) => {
    const was = match(e);
    const lost = !e.source && !!was?.source;
    const source = e.source ?? (lost ? was!.source : undefined);
    if (!source) return e;
    if (lost) restored++;
    const next = classed(source, edgePatch.get(edgeId(e)));
    return next === e.source ? e : { ...e, source: next };
  });
  return { design: restored || edited ? { ...pasted, nodes, edges } : pasted, restored, edited, dropped };
}
