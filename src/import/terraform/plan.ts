// Read `terraform show -json` plan output.
// Planned values give each resource instance; `configuration` gives who references whom.
// Sensitive values are dropped here, so nothing after this point can read them. Errors carry a
// message id and arguments, never display text (the UI translates; tests/boundary.test.ts).

export interface PlanResource {
  /** Instance address, e.g. `module.net.aws_subnet.a[0]`. */
  address: string;
  /** The address without instance keys, which `configuration` and references use. */
  configAddress: string;
  type: string;
  name: string;
  index?: number | string;
  /** `module.net.` or '' for the root module. */
  module: string;
  values: Record<string, unknown>;
  /** Attributes Terraform only knows after apply (`after_unknown`): top-level names, and dotted paths
   *  inside blocks (`connection_pool_config.max_connections_percent`). */
  unknown: Set<string>;
  /** This resource's `configuration` expressions: only `references` (made absolute to the root, in
   *  this resource's own module instance). Literals are dropped: a sensitive one (a password written
   *  in the .tf file) would otherwise be here in plain text, and `values` has every known literal. */
  expressions: Record<string, unknown>;
  /** The provider configuration (`provider_config_key`, e.g. `aws.west`), when the plan gives it. */
  provider?: string;
}

export interface Plan {
  formatVersion: string;
  terraformVersion: string;
  resources: PlanResource[];
  byAddress: Map<string, PlanResource>;
  byConfig: Map<string, PlanResource[]>;
}

export class PlanError extends Error {
  readonly id: string;
  readonly args: Record<string, string | number>;
  constructor(id: string, args: Record<string, string | number> = {}) {
    super(`${id} ${JSON.stringify(args)}`);
    this.id = id;
    this.args = args;
  }
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
/** One instance key: `[0]`, `["prod.us"]`, `["a]b"]` (a quoted key may hold `.`, `]` and `\"`). */
export const KEY = String.raw`\[(?:"(?:[^"\\]|\\.)*"|[^\]"]*)\]`;
const ALL_KEYS = new RegExp(KEY, 'g');
const LAST_KEY = new RegExp(`${KEY}$`);
export const stripKeys = (address: string): string => address.replace(ALL_KEYS, '');
/** Drop only the resource's own key: `module.app["a"].aws_x.y[1]` -> `module.app["a"].aws_x.y`. */
export const stripLastKey = (address: string): string => address.replace(LAST_KEY, '');

/** Remove every value a `sensitive_values` mask marks with true. */
function dropSensitive(value: unknown, mask: unknown): unknown {
  if (mask === true) return undefined;
  if (Array.isArray(value)) return value.map((v, i) => dropSensitive(v, Array.isArray(mask) ? mask[i] : undefined));
  if (!isObj(value) || !isObj(mask)) return value;
  const out: Obj = {};
  for (const [k, v] of Object.entries(value)) {
    const d = dropSensitive(v, mask[k]);
    if (d !== undefined || !(k in mask)) out[k] = d;
  }
  return out;
}

/** Keep only `references` (dropping every literal), with each made absolute: `prefix` is the
 *  module instance the resource lives in (`module.app[0].`), so instances never see each other. */
function referencesOnly(expr: unknown, prefix: string): unknown {
  if (Array.isArray(expr)) return expr.map((e) => referencesOnly(e, prefix));
  if (!isObj(expr)) return undefined;
  const out: Obj = {};
  for (const [k, v] of Object.entries(expr)) {
    if (k === 'constant_value') continue;
    if (k === 'references' && Array.isArray(v)) out[k] = v.filter((r): r is string => typeof r === 'string').map((r) => (/^(var|local|each|count|path|terraform|self)\b/.test(r) ? r : prefix + r));
    else {
      const x = referencesOnly(v, prefix);
      if (x !== undefined) out[k] = x;
    }
  }
  return out;
}

function configResources(mod: unknown, prefix: string, out: Map<string, Obj>, providers: Map<string, string>): void {
  if (!isObj(mod)) return;
  for (const r of (mod.resources as Obj[] | undefined) ?? []) {
    if (r.mode !== 'managed') continue;
    out.set(prefix + String(r.address), (r.expressions ?? {}) as Obj);
    if (typeof r.provider_config_key === 'string') providers.set(prefix + String(r.address), r.provider_config_key);
  }
  for (const [name, call] of Object.entries((mod.module_calls as Obj | undefined) ?? {})) {
    if (isObj(call)) configResources(call.module, `${prefix}module.${name}.`, out, providers);
  }
}

function plannedResources(mod: unknown, out: Obj[]): void {
  if (!isObj(mod)) return;
  for (const r of (mod.resources as Obj[] | undefined) ?? []) if (r.mode === 'managed') out.push(r);
  for (const c of (mod.child_modules as unknown[] | undefined) ?? []) plannedResources(c, out);
}

/** The paths marked true in `after_unknown`; a block (a list of objects) adds its fields as `block.field`. */
function unknownPaths(au: Obj, prefix = '', out = new Set<string>()): Set<string> {
  for (const [k, v] of Object.entries(au)) {
    if (v === true) out.add(prefix + k);
    else if (isObj(v)) unknownPaths(v, `${prefix}${k}.`, out);
    else if (Array.isArray(v)) for (const x of v) if (isObj(x)) unknownPaths(x, `${prefix}${k}.`, out);
  }
  return out;
}

export function parsePlan(json: unknown): Plan {
  if (!isObj(json)) throw new PlanError('import.plan.notObject');
  const fv = json.format_version;
  if (typeof fv !== 'string') throw new PlanError('import.plan.noFormatVersion');
  if (!/^1\./.test(fv)) throw new PlanError('import.plan.formatVersion', { version: fv });
  if (!isObj(json.planned_values)) throw new PlanError('import.plan.noPlannedValues');

  const config = new Map<string, Obj>();
  const providers = new Map<string, string>();
  configResources(isObj(json.configuration) ? json.configuration.root_module : undefined, '', config, providers);
  const unknownByAddress = new Map<string, Set<string>>();
  for (const rc of (json.resource_changes as Obj[] | undefined) ?? []) {
    const au = isObj(rc.change) ? rc.change.after_unknown : undefined;
    if (isObj(au)) unknownByAddress.set(String(rc.address), unknownPaths(au));
  }

  const raw: Obj[] = [];
  plannedResources(json.planned_values.root_module, raw);
  const resources = raw.map((r): PlanResource => {
    const address = String(r.address);
    const configAddress = stripKeys(address);
    // The module instance, with its keys: `module.app[0].aws_db_instance.x[1]` -> `module.app[0].`.
    const own = stripLastKey(address);
    const module = own.slice(0, own.length - `${r.type}.${r.name}`.length);
    return {
      address,
      configAddress,
      type: String(r.type),
      name: String(r.name),
      ...(r.index !== undefined ? { index: r.index as number | string } : {}),
      module,
      values: (dropSensitive(r.values ?? {}, r.sensitive_values) as Obj) ?? {},
      unknown: unknownByAddress.get(address) ?? new Set(),
      expressions: (referencesOnly(config.get(configAddress) ?? {}, module) as Obj) ?? {},
      ...(providers.has(configAddress) ? { provider: providers.get(configAddress) } : {}),
    };
  });
  const byAddress = new Map(resources.map((r) => [r.address, r]));
  const byConfig = new Map<string, PlanResource[]>();
  for (const r of resources) {
    if (!byConfig.has(r.configAddress)) byConfig.set(r.configAddress, []);
    byConfig.get(r.configAddress)!.push(r);
  }
  return { formatVersion: fv, terraformVersion: String(json.terraform_version ?? ''), resources, byAddress, byConfig };
}
