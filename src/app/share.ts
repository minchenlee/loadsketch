// Share links (M14, Q17=A): the design and the scenario, compressed into the part of the URL after
// "#". No server: the link is the whole state. The hash is never sent to a server either.
//
//   #s=1.<base64url of deflate-raw of {"design": …, "scenario": …}>
//
// "1" is the format version: a later format gets a new number, and old links keep working.
import { DesignSchema, ScenarioSchema, type Design, type Scenario } from '../schema/design.ts';
import { t } from '../i18n/index.ts';

export interface Shared {
  design: Design;
  scenario: Scenario;
}

const PREFIX = 's=1.';
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

/** The hash (without "#") that holds this design and scenario. */
export async function encodeShare(s: Shared): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify({ design: s.design, scenario: s.scenario }));
  return PREFIX + toBase64Url(await pipe(json, new CompressionStream('deflate-raw')));
}

/** Does this hash (with or without "#") hold a shared state? */
export function isShareHash(hash: string): boolean {
  return hash.replace(/^#/, '').startsWith('s=');
}

/**
 * The design and scenario in a share hash. Only the shape is checked: a design with errors still
 * opens (the editor shows its issues), as it does from a file.
 */
export async function decodeShare(hash: string): Promise<{ ok: true; value: Shared } | { ok: false; why: string }> {
  const h = hash.replace(/^#/, '');
  if (!h.startsWith('s=')) return { ok: false, why: t('網址裡沒有分享的設計') };
  if (!h.startsWith(PREFIX)) return { ok: false, why: t('這個連結的格式比這個版本新，或打錯了') };
  let value: unknown;
  try {
    const bytes = await pipe(fromBase64Url(h.slice(PREFIX.length)), new DecompressionStream('deflate-raw'));
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return { ok: false, why: t('連結被截斷或損壞（複製時少了一段？）') };
  }
  const v = value as { design?: unknown; scenario?: unknown } | null;
  const d = DesignSchema.safeParse(v?.design);
  if (!d.success) return { ok: false, why: t('設計格式不對：{path} {msg}', { path: d.error.issues[0]?.path.join('.') ?? '', msg: d.error.issues[0]?.message ?? '' }) };
  const sc = ScenarioSchema.safeParse(v?.scenario);
  if (!sc.success) return { ok: false, why: t('情境格式不對：{path} {msg}', { path: sc.error.issues[0]?.path.join('.') ?? '', msg: sc.error.issues[0]?.message ?? '' }) };
  // the input objects themselves: key order kept, as parseDesign does
  return { ok: true, value: { design: v!.design as Design, scenario: v!.scenario as Scenario } };
}
