// Remove secrets from `terraform show -json` output before it is saved as a fixture.
//   node scripts/scrub-plan.ts <plan.raw.json> <main.tf>  > <name>.plan.json
// Terraform writes sensitive values in plain text and marks them in parallel "sensitive" masks.
// This replaces every masked value, every sensitive variable and output, and the provider credentials
// with "(sensitive)", then replaces every copy of those strings anywhere else (a value equal to one,
// at any length; inside a longer string, for secrets of 6 characters or more). It fails if a string
// that main.tf marks as fake (containing "fixture-fake") is still in the output.
import { readFileSync } from 'node:fs';

const REDACTED = '(sensitive)';
type J = unknown;
const [planPath, tfPath] = process.argv.slice(2);
if (!planPath || !tfPath) throw new Error('usage: scrub-plan.ts <plan.raw.json> <main.tf>');
const plan = JSON.parse(readFileSync(planPath, 'utf8')) as Record<string, any>;
const secrets = new Set<string>();

/** Replace the values that a mask marks with true; collect their strings. */
function mask(value: J, m: J): J {
  if (m === true) {
    collect(value);
    return value === null || value === undefined ? value : REDACTED;
  }
  if (!m || typeof m !== 'object' || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v, i) => mask(v, (m as J[])[i]));
  const out: Record<string, J> = { ...(value as Record<string, J>) };
  for (const k of Object.keys(m as object)) if (Object.hasOwn(out, k)) out[k] = mask(out[k], (m as Record<string, J>)[k]);
  return out;
}
function collect(v: J): void {
  if (typeof v === 'string' && v.length > 0) secrets.add(v);
  else if (v && typeof v === 'object') Object.values(v).forEach(collect);
}
const resources = (mod: any): any[] => (mod ? [...(mod.resources ?? []), ...(mod.child_modules ?? []).flatMap(resources)] : []);

for (const r of resources(plan.planned_values?.root_module)) r.values = mask(r.values, r.sensitive_values);
for (const r of resources(plan.prior_state?.values?.root_module)) r.values = mask(r.values, r.sensitive_values);
for (const rc of plan.resource_changes ?? []) {
  rc.change.before = mask(rc.change.before, rc.change.before_sensitive);
  rc.change.after = mask(rc.change.after, rc.change.after_sensitive);
}
// Outputs: planned and prior values carry `sensitive`; output_changes carry masks.
const sensitiveOutputs = new Set(Object.entries<any>(plan.configuration?.root_module?.outputs ?? {}).filter(([, o]) => o.sensitive).map(([n]) => n));
for (const outs of [plan.planned_values?.outputs, plan.prior_state?.values?.outputs]) {
  for (const [name, o] of Object.entries<any>(outs ?? {})) {
    if (o.sensitive || sensitiveOutputs.has(name)) o.value = mask(o.value, true);
    else if (o.sensitive_values) o.value = mask(o.value, o.sensitive_values);
  }
}
for (const [name, oc] of Object.entries<any>(plan.output_changes ?? {})) {
  const all = sensitiveOutputs.has(name);
  oc.before = mask(oc.before, all || oc.before_sensitive);
  oc.after = mask(oc.after, all || oc.after_sensitive);
}
for (const [name, v] of Object.entries<any>(plan.configuration?.root_module?.variables ?? {})) {
  if (!v.sensitive) continue;
  collect(v.default);
  v.default = REDACTED;
  if (plan.variables?.[name]) {
    collect(plan.variables[name].value);
    plan.variables[name].value = REDACTED;
  }
}
for (const p of Object.values<any>(plan.configuration?.provider_config ?? {})) {
  for (const key of ['access_key', 'secret_key', 'token']) {
    const e = p.expressions?.[key];
    if (e && 'constant_value' in e) {
      collect(e.constant_value);
      e.constant_value = REDACTED;
    }
  }
}

secrets.delete(REDACTED);
/** Every copy: a string equal to a secret goes whole; a long secret inside a longer string is cut out. */
const long = [...secrets].filter((s) => s.length >= 6).sort((a, b) => b.length - a.length);
const scrubString = (v: string): string => (secrets.has(v) ? REDACTED : long.reduce((t, s) => t.split(s).join(REDACTED), v));
/** Values and object keys (a secret can be a map key, such as a tag name); two keys that both
 *  become "(sensitive)" are kept apart as "(sensitive)#2", … */
function scrubCopies(v: J): J {
  if (typeof v === 'string') return scrubString(v);
  if (Array.isArray(v)) return v.map(scrubCopies);
  if (v && typeof v === 'object') {
    // Null prototype and own-property checks: keys like `constructor` or `__proto__` are plain data.
    const out: Record<string, J> = Object.create(null);
    for (const [k, x] of Object.entries(v)) {
      let key = scrubString(k);
      for (let n = 2; Object.hasOwn(out, key); n++) key = `${scrubString(k)}#${n}`;
      out[key] = scrubCopies(x);
    }
    return out;
  }
  return v;
}
const text = JSON.stringify(scrubCopies(plan), null, 2);

const fakes = readFileSync(tfPath, 'utf8').match(/fixture-fake[\w-]*/g) ?? [];
const left = fakes.filter((f) => text.includes(f));
if (left.length) throw new Error(`scrub-plan: secrets still in the output: ${left.join(', ')}`);
process.stdout.write(`${text}\n`);
