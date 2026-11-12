// Share links (M14, Q17=A): the design and the scenario, compressed into the part of the URL after
// "#". No server: the link is the whole state. The hash is never sent to a server either.
//
//   #s=1.<base64url of deflate-raw of {"design": …, "scenario": …}>
//
// A comparison (roadmap-next M3, Q9=A) holds two runs, the baseline first:
//
//   #c=1.<base64url of deflate-raw of {"compare": [{"name": …, "design": …, "scenario": …}, …]}>
//
// "1" is the format version: a later format gets a new number, and old links keep working.
import { DesignSchema, ScenarioSchema, type Design, type Scenario } from '../schema/design.ts';
import { t } from '../i18n/index.ts';

export interface Shared {
  design: Design;
  scenario: Scenario;
}

/** A run in a shared comparison. */
export interface SharedRun extends Shared {
  name: string;
}

const PREFIX = 's=1.';
const COMPARE_PREFIX = 'c=1.';
/** A share link holds at most this many runs to compare (Q9=A): longer links break. */
export const MAX_SHARE_COMPARE = 2;
/** Longer links break in chat apps and some browsers: the share button warns above this. */
export const SHARE_WARN_CHARS = 16_000;

async function pipe(bytes: Uint8Array<ArrayBuffer>, stream: CompressionStream | DecompressionStream): Promise<Uint8Array<ArrayBuffer>> {
  const out = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pack(value: unknown): Promise<string> {
  return toBase64Url(await pipe(new TextEncoder().encode(JSON.stringify(value)), new CompressionStream('deflate-raw')));
}

async function unpack(text: string): Promise<{ ok: true; value: unknown } | { ok: false; why: string }> {
  try {
    const bytes = await pipe(fromBase64Url(text), new DecompressionStream('deflate-raw'));
    return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { ok: false, why: t('連結被截斷或損壞（複製時少了一段？）') };
  }
}

/** The design and scenario of a link, with their shape checked. */
function readShared(v: { design?: unknown; scenario?: unknown } | null): { ok: true; value: Shared } | { ok: false; why: string } {
  const d = DesignSchema.safeParse(v?.design);
  if (!d.success) return { ok: false, why: t('設計格式不對：{path} {msg}', { path: d.error.issues[0]?.path.join('.') ?? '', msg: d.error.issues[0]?.message ?? '' }) };
  const sc = ScenarioSchema.safeParse(v?.scenario);
  if (!sc.success) return { ok: false, why: t('情境格式不對：{path} {msg}', { path: sc.error.issues[0]?.path.join('.') ?? '', msg: sc.error.issues[0]?.message ?? '' }) };
  // the input objects themselves: key order kept, as parseDesign does
  return { ok: true, value: { design: v!.design as Design, scenario: v!.scenario as Scenario } };
}

/** The hash (without "#") that holds this design and scenario. */
export async function encodeShare(s: Shared): Promise<string> {
  return PREFIX + (await pack({ design: s.design, scenario: s.scenario }));
}

/** The hash (without "#") that holds a comparison of two runs, the baseline first. */
export async function encodeCompare(runs: SharedRun[]): Promise<string> {
  if (runs.length < 2 || runs.length > MAX_SHARE_COMPARE) throw new Error(`a shared comparison holds 2 to ${MAX_SHARE_COMPARE} runs, not ${runs.length}`);
  return COMPARE_PREFIX + (await pack({ compare: runs.map((r) => ({ name: r.name, design: r.design, scenario: r.scenario })) }));
}

/** Does this hash (with or without "#") hold a shared state or a shared comparison? */
export function isShareHash(hash: string): boolean {
  const h = hash.replace(/^#/, '');
  return h.startsWith('s=') || h.startsWith('c=');
}

/** What a share hash holds: one design and scenario, or a comparison of runs. */
export type SharedLink = { kind: 'one'; value: Shared } | { kind: 'compare'; runs: SharedRun[] };

export async function decodeLink(hash: string): Promise<({ ok: true } & SharedLink) | { ok: false; why: string }> {
  const h = hash.replace(/^#/, '');
  if (!h.startsWith('c=')) {
    const r = await decodeShare(h);
    return r.ok ? { ok: true, kind: 'one', value: r.value } : r;
  }
  if (!h.startsWith(COMPARE_PREFIX)) return { ok: false, why: t('這個連結的格式比這個版本新，或打錯了') };
  const u = await unpack(h.slice(COMPARE_PREFIX.length));
  if (!u.ok) return u;
  const list = (u.value as { compare?: unknown } | null)?.compare;
  if (!Array.isArray(list) || list.length < 2 || list.length > MAX_SHARE_COMPARE) return { ok: false, why: t('比較的連結要有 2 個版本') };
  const runs: SharedRun[] = [];
  for (const x of list as ({ name?: unknown; design?: unknown; scenario?: unknown } | null)[]) {
    const r = readShared(x);
    if (!r.ok) return r;
    runs.push({ name: typeof x?.name === 'string' ? x.name.slice(0, 200) : '', ...r.value });
  }
  return { ok: true, kind: 'compare', runs };
}

/**
 * The design and scenario in a share hash. Only the shape is checked: a design with errors still
 * opens (the editor shows its issues), as it does from a file.
 */
export async function decodeShare(hash: string): Promise<{ ok: true; value: Shared } | { ok: false; why: string }> {
  const h = hash.replace(/^#/, '');
  if (!h.startsWith('s=')) return { ok: false, why: t('網址裡沒有分享的設計') };
  if (!h.startsWith(PREFIX)) return { ok: false, why: t('這個連結的格式比這個版本新，或打錯了') };
  const u = await unpack(h.slice(PREFIX.length));
  if (!u.ok) return u;
  return readShared(u.value as { design?: unknown; scenario?: unknown } | null);
}

/**
 * Puts a link with this hash on the clipboard. When the clipboard is not allowed the link goes to the
 * address bar instead, and the result is false. `long` is true above SHARE_WARN_CHARS.
 */
export async function copyLink(hash: string): Promise<{ url: string; copied: boolean; long: boolean }> {
  const url = `${location.origin}${location.pathname}#${hash}`;
  const long = url.length > SHARE_WARN_CHARS;
  try {
    await navigator.clipboard.writeText(url);
    return { url, copied: true, long };
  } catch {
    history.replaceState(null, '', url);
    return { url, copied: false, long };
  }
}
