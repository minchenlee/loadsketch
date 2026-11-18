// Pasting a design as JSON (roadmap-next M4): the text an AI or a person gives back is read here.
// What is wrong is said in plain words, with where it is (which component, which line) and what was
// expected, not as a schema path. Nothing here touches the canvas: the dialog shows the result.
import type { z } from 'zod';
import { DesignSchema, checkDesign, edgeId, type Design, type EdgeSource, type Issue, type ParamSource } from '../schema/design.ts';
import { editedSources } from './sources.ts';
import { pairEdges, type Change } from './designDiff.ts';
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
  if (text.length > MAX_PASTE_CHARS) return { ok: false, problems: [t('The paste is too big ({mb} MB). A design is at most {max} MB: paste only the design\'s JSON.', { mb: (text.length / 1024 / 1024).toFixed(1), max: MAX_PASTE_CHARS / 1024 / 1024 })] };
  const src = stripFence(text);
  if (!src) return { ok: false, problems: [t('Nothing here. Paste the JSON of a design.')] };
  let value: unknown;
  try {
    value = JSON.parse(src);
  } catch (e) {
    return { ok: false, problems: [jsonProblem(src, (e as Error).message)] };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, problems: [t('This JSON is not a design: a design is an object with schema, name, nodes and edges.')] };
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
  return uniq.length > MAX_PROBLEMS ? [...uniq.slice(0, MAX_PROBLEMS), t('{n} more problems. Fix the ones above first.', { n: uniq.length - MAX_PROBLEMS })] : uniq;
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
  const where = line ? t('near line {line}, column {col}', { line, col: col ?? 1 }) : '';
  // the usual slips are looked for outside the strings: a URL in a description is not a comment
  const bare = blankStrings(src);
  const hint = /,\s*[}\]]/.test(bare)
    ? t('There is a comma after the last item.')
    : /'[^'\n]*'\s*:/.test(bare)
      ? t('Names and text in JSON take double quotes ", not single quotes.')
      : /(^|[{,]\s*)[A-Za-z_][\w-]*\s*:/m.test(bare)
        ? t('Field names take double quotes, like "nodes".')
        : /\/\/|\/\*/.test(bare)
          ? t('JSON cannot have comments (// or /* */).')
          : '';
  return [where ? t('This is not valid JSON: something is wrong {where}.', { where }) : t('This is not valid JSON.'), hint].filter(Boolean).join(' ');
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
  const field = (keys: PropertyKey[]) => (keys.length ? t(', field "{field}"', { field: keys.map(String).join('.') }) : '');
  if (top === 'nodes' && typeof i === 'number') {
    const n = (d.nodes as unknown[])[i];
    const id = isObj(n) && typeof n.id === 'string' ? n.id : '';
    const keys = rest[0] === 'params' ? rest.slice(1) : rest;
    const head = id ? t('Component "{id}" (#{n})', { id, n: i + 1 }) : t('Component #{n}', { n: i + 1 });
    return head + (rest[0] === 'params' && keys.length ? t(', setting "{field}"', { field: keys.map(String).join('.') }) : field(keys));
  }
  if (top === 'edges' && typeof i === 'number') {
    const e = (d.edges as unknown[])[i];
    const ends = isObj(e) && typeof e.from === 'string' && typeof e.to === 'string' ? `${e.from} → ${e.to}` : '';
    return (ends ? t('Line #{n} ({ends})', { n: i + 1, ends }) : t('Line #{n}', { n: i + 1 })) + field(rest);
  }
  if (top === 'apis' && typeof i === 'number') {
    const a = (d.apis as unknown[])[i];
    const name = isObj(a) && typeof a.name === 'string' ? a.name : '';
    return (name ? t('API "{name}"', { name }) : t('API #{n}', { n: i + 1 })) + field(rest);
  }
  if (top === 'notes' && typeof i === 'number') return t('Note #{n}', { n: i + 1 }) + field(rest);
  if (top === undefined) return t('The design');
  return t('Field "{field}"', { field: path.map(String).join('.') });
}

function valueAt(d: unknown, path: PropertyKey[]): unknown {
  let v = d;
  for (const k of path) v = isObj(v) || Array.isArray(v) ? (v as Record<PropertyKey, unknown>)[k as never] : undefined;
  return v;
}

/** A value, as it would be said: text "x", a number, a list… */
function said(v: unknown): string {
  if (v === undefined) return t('missing');
  if (v === null) return 'null';
  if (typeof v === 'string') return t('the text "{v}"', { v: v.length > 40 ? `${v.slice(0, 40)}…` : v });
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return t('a list');
  return t('an object');
}

const TYPE_WORD: Record<string, string> = {
  number: tx('a number'),
  string: tx('text'),
  boolean: tx('true or false'),
  array: tx('a list [...]'),
  tuple: tx('a list [x, y]'),
  object: tx('an object {...}'),
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
    if (spec && key in spec.params) return t('{where}: "{key}" goes inside "params": {"params": {"{key}": …}}.', { where, key });
  }
  const guess = closest(key, knownKeys(d, path));
  if (guess) return t('{where}: there is no field "{key}". Did you mean "{guess}"?', { where, key, guess });
  const known = knownKeys(d, path);
  return known.length
    ? t('{where}: there is no field "{key}". The fields are: {known}.', { where, key, known: known.join(', ') })
    : t('{where}: there is no field "{key}".', { where, key });
}

/** One schema issue, in plain words. */
function schemaProblem(d: Obj, issue: z.core.$ZodIssue, prefix: PropertyKey[] = []): string {
  const path = [...prefix, ...issue.path];
  const where = wherePath(d, path);
  const v = valueAt(d, path);
  switch (issue.code) {
    case 'invalid_type':
      if (v === undefined) return t('{where}: missing, and it is required.', { where });
      return t('{where}: must be {type}; now it is {v}.', { where, type: t(TYPE_WORD[issue.expected] ?? issue.expected), v: said(v) });
    case 'too_small':
    case 'too_big': {
      const bound = issue.code === 'too_small' ? issue.minimum : issue.maximum;
      if (Array.isArray(v) || issue.origin === 'array') return issue.code === 'too_small' ? t('{where}: at least {n} items.', { where, n: String(bound) }) : t('{where}: at most {n} items.', { where, n: String(bound) });
      if (typeof v === 'string') return issue.code === 'too_small' ? t('{where}: cannot be empty.', { where }) : t('{where}: too long, at most {n} characters.', { where, n: String(bound) });
      if (issue.code === 'too_small') return issue.inclusive ? t('{where}: at least {n}; now it is {v}.', { where, n: String(bound), v: said(v) }) : t('{where}: more than {n}; now it is {v}.', { where, n: String(bound), v: said(v) });
      return issue.inclusive ? t('{where}: at most {n}; now it is {v}.', { where, n: String(bound), v: said(v) }) : t('{where}: less than {n}; now it is {v}.', { where, n: String(bound), v: said(v) });
    }
    case 'unrecognized_keys':
      return issue.keys.map((k) => unknownKey(d, path, k)).join(' ');
    case 'invalid_value': {
      const values = issue.values.map((x) => JSON.stringify(x));
      if (path.length === 1 && path[0] === 'schema') return t('Start with "schema": "{schema}", which says this is a loadsketch design. Now it is {v}.', { schema: String(issue.values[0]), v: said(v) });
      return values.length === 1 ? t('{where}: must be {values}; now it is {v}.', { where, values: values[0], v: said(v) }) : t('{where}: one of {values}; now it is {v}.', { where, values: values.join('、'), v: said(v) });
    }
    case 'invalid_union': {
      // the kind of a component: name the kinds there are
      if ('discriminator' in issue && issue.discriminator === 'kind') {
        const kinds = (issue as { options?: unknown[] }).options?.map(String) ?? Object.keys(KINDS);
        const guess = typeof v === 'string' ? closest(v.replace(/[\s-]/g, '_'), kinds) : undefined;
        return guess
          ? t('{where}: there is no kind {v}. Did you mean "{guess}"?', { where: wherePath(d, path.slice(0, -1)), v: JSON.stringify(v), guess })
          : t('{where}: the kind is {v}, and there is no such component. The kinds are: {kinds}.', { where: wherePath(d, path.slice(0, -1)), v: said(v), kinds: kinds.join(', ') });
      }
      // a value with two forms (a number, or {mean, cv}): say what went wrong in the form it has
      const branches = issue.errors.filter((b) => b.length);
      const deepest = branches.sort((a, b) => Math.max(...b.map((x) => x.path.length)) - Math.max(...a.map((x) => x.path.length)))[0];
      if (deepest && deepest.some((x) => x.path.length)) return schemaProblem(d, deepest[0], path);
      return t('{where}: not written the right way; now it is {v}.', { where, v: said(v) });
    }
    case 'invalid_format':
      return path[path.length - 1] === 'id' || path[path.length - 2] === 'apis' || ['from', 'to'].includes(String(path[path.length - 1]))
        ? t('{where} is {v}: an id starts with a letter or digit and has only letters, digits, _ and -, at most 48 characters, no spaces.', { where, v: said(v) })
        : t('{where}: wrong format; now it is {v}.', { where, v: said(v) });
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
  /** Lines that kept their id but now join other components: their source says the user drew them. */
  rewired: number;
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
  let rewired = 0;
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

  // lines: the pairs of the change list (by id, then by caller and callee, in order)
  const wasOf = new Map(pairEdges(canvas.edges, pasted.edges).pairs.map(([x, y]) => [y, x]));
  const edges = pasted.edges.map((e) => {
    const was = wasOf.get(e);
    // the same id, but the line now joins other components: the resources that showed the old line
    // do not show this one. The user's answer drew it; its values are the user's too (M5 review round 3)
    if (was && (was.from !== e.from || was.to !== e.to) && (e.source || was.source)) {
      const old = e.source ?? was.source!;
      rewired++;
      const params = old.params ? editedSources(undefined, Object.fromEntries(Object.keys(old.params).map((k) => [k, (e as unknown as Patch)[k]]))) : undefined;
      const patch = edgePatch.get(edgeId(e));
      const source: EdgeSource = { line: 'answer', ...(params || patch ? { params: editedSources(params, patch ?? {}) } : {}) };
      return { ...e, source };
    }
    const lost = !e.source && !!was?.source;
    const source = e.source ?? (lost ? was!.source : undefined);
    if (!source) return e;
    if (lost) restored++;
    const next = classed(source, edgePatch.get(edgeId(e)));
    return next === e.source ? e : { ...e, source: next };
  });
  return { design: restored || edited || rewired ? { ...pasted, nodes, edges } : pasted, restored, edited, dropped, rewired };
}
