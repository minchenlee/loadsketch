// Terraform plan JSON fixtures. The plans are made by scripts/gen-fixtures.sh inside
// a sandbox that blocks outbound network; these tests check the script keeps that rule, that the
// sandbox really blocks, that the scrubber removes secrets, and that each saved plan is readable.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const FIXTURES = join(ROOT, 'tests', 'import', 'fixtures');
const SCRIPT = join(ROOT, 'scripts', 'gen-fixtures.sh');
const SETS = ['ecs-rds', 'lambda-sqs-rds', 'aurora-cache-multiaz'];
/** Every fake secret a main.tf defines (they all contain "fixture-fake"), plus the fake access key. */
const fakes = (set: string) => [...new Set(readFileSync(join(FIXTURES, set, 'main.tf'), 'utf8').match(/fixture-fake[\w-]*|AKIA[A-Z0-9]{16}/g) ?? [])];

describe('gen-fixtures.sh', () => {
  const lines = readFileSync(SCRIPT, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const tf = lines.map((l, i) => [l, i] as const).filter(([l]) => /\bterraform\b/.test(l) && !/^(echo|\[)/.test(l) && !l.includes('{ echo'));

  it('never applies or destroys', () => {
    expect(lines.filter((l) => /terraform\b.*\b(apply|destroy|import)\b/.test(l))).toEqual([]);
  });

  it('runs every terraform plan and show inside the sandbox', () => {
    const offline = tf.filter(([l]) => /\b(plan|show)\b/.test(l));
    expect(offline.length).toBeGreaterThanOrEqual(2);
    for (const [l] of offline) expect(l, l).toMatch(/^sandboxed terraform /);
    // The only terraform outside the sandbox is `init`, and only behind --init.
    for (const [l] of tf.filter(([l]) => !l.startsWith('sandboxed'))) expect(l, l).toMatch(/terraform -chdir=\S+ init /);
  });

  it('proves the sandbox blocks before the first plan', () => {
    const proof = lines.findIndex((l) => /sandboxed curl .*https:\/\/example\.com/.test(l));
    const firstPlan = tf.find(([l]) => /\bplan\b/.test(l))![1];
    expect(proof).toBeGreaterThanOrEqual(0);
    expect(proof).toBeLessThan(firstPlan);
    expect(lines[proof]).toMatch(/^if sandboxed curl/);
    expect(lines.slice(proof, proof + 3).join('\n')).toContain('exit 1');
  });

  it('uses the offline sandbox profile', () => {
    // No network except localhost, plus Unix sockets in the per-user temp folder for the provider plugins.
    expect(readFileSync(SCRIPT, 'utf8')).toContain(`SANDBOX='(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:*"))(allow network-outbound (remote unix-socket (path-regex #"^(/private)?/var/folders/")))'`);
    expect(readFileSync(SCRIPT, 'utf8')).toContain('TMPDIR="$(getconf DARWIN_USER_TEMP_DIR)"');
  });

  it('checks that the sandbox starts before it trusts a failed request', () => {
    const start = lines.findIndex((l) => l.includes('"$(sandboxed /bin/echo ok)" != ok'));
    const proof = lines.findIndex((l) => /sandboxed curl/.test(l));
    expect(start).toBeGreaterThanOrEqual(0);
    expect(start).toBeLessThan(proof);
  });
});

// sandbox-exec is a macOS tool (scripts/gen-fixtures.sh makes the fixtures on macOS): skipped elsewhere
describe.skipIf(process.platform !== 'darwin')('the sandbox', () => {
  const profile = readFileSync(SCRIPT, 'utf8').match(/SANDBOX='([^']+)'/)![1];
  const userTmp = spawnSync('getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8' }).stdout.trim();
  const sandboxed = (cmd: string[]) => spawnSync('sandbox-exec', ['-p', profile, ...cmd], { encoding: 'utf8', env: { ...process.env, TMPDIR: userTmp } });

  it('starts (otherwise a failed request proves nothing)', () => {
    const r = sandboxed(['/bin/echo', 'ok']);
    expect(r.stderr).toBe('');
    expect(r.stdout.trim()).toBe('ok');
  });

  it('blocks https://example.com and a bare IP', () => {
    for (const url of ['https://example.com', 'https://1.1.1.1']) {
      const r = sandboxed(['curl', '-s', '-m', '5', '-o', '/dev/null', url]);
      expect(r.error).toBeUndefined();
      expect(r.status, url).not.toBe(0);
      expect(r.stderr, url).not.toContain('sandbox_apply');
    }
  });

  it('lets a process talk to its child over a Unix socket in the temp folder (Terraform -> provider)', () => {
    const py = "import os,socket,tempfile,threading\np=os.path.join(tempfile.mkdtemp(),'plugin1')\ns=socket.socket(socket.AF_UNIX);s.bind(p);s.listen(1)\ndef a():\n c,_=s.accept();c.sendall(b'hi');c.close()\nthreading.Thread(target=a,daemon=True).start()\nc=socket.socket(socket.AF_UNIX);c.connect(p);print(c.recv(2).decode())\n";
    const r = sandboxed(['python3', '-I', '-c', py]);
    expect(r.stderr).toBe('');
    expect(r.stdout.trim()).toBe('hi');
  });
});

describe('scrub-plan.ts', () => {
  it('removes masked values, sensitive variables, provider keys and every copy of them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scrub-'));
    const pw = 'fixture-fake-db-password-DO-NOT-LEAK';
    const raw = {
      format_version: '1.2',
      variables: { db_password: { value: pw }, region: { value: 'us-east-1' } },
      planned_values: { root_module: { resources: [{ address: 'aws_db_instance.main', values: { password: pw, engine: 'postgres' }, sensitive_values: { password: true } }] } },
      resource_changes: [{ address: 'aws_db_instance.main', change: { before: null, after: { password: pw, tags: { note: `copy ${pw}` } }, before_sensitive: false, after_sensitive: { password: true } } }],
      configuration: {
        provider_config: { aws: { expressions: { access_key: { constant_value: 'AKIAFIXTUREFAKEKEY00' }, secret_key: { constant_value: 'fixture-fake-secret-key-not-real' } } } },
        root_module: { variables: { db_password: { default: pw, sensitive: true }, region: { default: 'us-east-1' } } },
      },
    };
    writeFileSync(join(dir, 'raw.json'), JSON.stringify(raw));
    writeFileSync(join(dir, 'main.tf'), `# ${pw} fixture-fake-secret-key-not-real AKIAFIXTUREFAKEKEY00\n`);
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'scrub-plan.ts'), join(dir, 'raw.json'), join(dir, 'main.tf')], { encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    for (const s of [pw, 'fixture-fake-secret-key-not-real', 'AKIAFIXTUREFAKEKEY00']) expect(r.stdout).not.toContain(s);
    const out = JSON.parse(r.stdout);
    expect(out.variables.region.value).toBe('us-east-1');
    expect(out.planned_values.root_module.resources[0].values).toEqual({ password: '(sensitive)', engine: 'postgres' });
    expect(out.resource_changes[0].change.after.tags.note).toBe('copy (sensitive)');
  });

  it('removes sensitive outputs and short secrets, with their copies', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scrub-'));
    const tok = 'fixture-fake-output-token';
    const raw = {
      format_version: '1.2',
      planned_values: { outputs: { token: { sensitive: true, value: tok }, url: { sensitive: false, value: 'https://x.invalid' } }, root_module: { resources: [{ address: 'aws_db_instance.main', values: { password: 'abcde', port: 5432 }, sensitive_values: { password: true } }] } },
      output_changes: { token: { before: null, after: tok, before_sensitive: false, after_sensitive: true } },
      configuration: { root_module: { outputs: { token: { sensitive: true } }, resources: [{ expressions: { password: { constant_value: 'abcde' }, note: { constant_value: 'abcdef-abcde' }, tags: { constant_value: { abcde: 'x', [`k-${tok}`]: 'y', '(sensitive)': 'z' } } } }] } },
    };
    writeFileSync(join(dir, 'raw.json'), JSON.stringify(raw));
    writeFileSync(join(dir, 'main.tf'), `# ${tok}\n`);
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'scrub-plan.ts'), join(dir, 'raw.json'), join(dir, 'main.tf')], { encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.stdout).not.toContain(tok);
    const out = JSON.parse(r.stdout);
    expect(out.planned_values.outputs.url.value).toBe('https://x.invalid');
    expect(out.planned_values.outputs.token.value).toBe('(sensitive)');
    expect(out.output_changes.token.after).toBe('(sensitive)');
    expect(out.configuration.root_module.resources[0].expressions.password.constant_value).toBe('(sensitive)');
    // A short secret is only replaced where it is the whole value, not inside other text.
    expect(out.configuration.root_module.resources[0].expressions.note.constant_value).toBe('abcdef-abcde');
    expect(out.planned_values.root_module.resources[0].values.port).toBe(5432);
    // Secrets used as map keys; colliding keys stay apart.
    expect(out.configuration.root_module.resources[0].expressions.tags.constant_value).toEqual({ '(sensitive)': 'x', 'k-(sensitive)': 'y', '(sensitive)#2': 'z' });
  });

  it('keeps keys named like Object properties unchanged', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scrub-'));
    const raw = '{"format_version":"1.2","variables":{"constructor":{"value":"a"},"toString":{"value":"b"},"__proto__":{"value":"c"}},"planned_values":{"root_module":{"resources":[{"values":{"tags":{"hasOwnProperty":"d"}},"sensitive_values":{"tags":{},"constructor":true}}]}}}';
    writeFileSync(join(dir, 'raw.json'), raw);
    writeFileSync(join(dir, 'main.tf'), '#\n');
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'scrub-plan.ts'), join(dir, 'raw.json'), join(dir, 'main.tf')], { encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(JSON.stringify(JSON.parse(r.stdout))).toBe(JSON.stringify(JSON.parse(raw)));
  });

  it('fails when a fake secret it cannot see as sensitive is still there', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scrub-'));
    writeFileSync(join(dir, 'raw.json'), JSON.stringify({ format_version: '1.2', variables: { note: { value: 'fixture-fake-leak' } } }));
    writeFileSync(join(dir, 'main.tf'), '# fixture-fake-leak\n');
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'scrub-plan.ts'), join(dir, 'raw.json'), join(dir, 'main.tf')], { encoding: 'utf8' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('fixture-fake-leak');
  });
});

describe.each(SETS)('fixture %s', (set) => {
  const path = join(FIXTURES, `${set}.plan.json`);
  // Skipped until scripts/gen-fixtures.sh has run (it needs the Terraform CLI). M20 is not done while
  // this is skipped.
  it.skipIf(!existsSync(path))('the plan JSON is readable, has format_version and no fake secret', () => {
    const text = readFileSync(path, 'utf8');
    const plan = JSON.parse(text);
    expect(plan.format_version).toMatch(/^\d+\.\d+/);
    expect(plan.resource_changes.length).toBeGreaterThan(0);
    for (const s of fakes(set)) expect(text, s).not.toContain(s);
  });
  it('main.tf defines fake secrets for the leak check to look for', () => {
    expect(fakes(set).length).toBeGreaterThanOrEqual(2);
  });
});
