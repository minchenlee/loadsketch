// Writes the files made from the format guide for AI models (src/schema/aiGuide.ts):
// public/llms.txt (served at /llms.txt), and the Agent Skill skills/loadsketch/SKILL.md with its
// copy public/skills/loadsketch/SKILL.md (served at /skills/loadsketch/SKILL.md).
// --check: exit 1 when a file differs from the catalog (tests/ai-guide.test.ts does too).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { aiGuide, skillMd } from '../src/schema/aiGuide.ts';

const root = join(import.meta.dirname, '..');
export const GUIDE_FILE = join(root, 'public', 'llms.txt');
export const SKILL_FILE = join(root, 'skills', 'loadsketch', 'SKILL.md');
export const SKILL_PUBLIC_FILE = join(root, 'public', 'skills', 'loadsketch', 'SKILL.md');

const files: [string, string][] = [
  [GUIDE_FILE, aiGuide()],
  [SKILL_FILE, skillMd()],
  [SKILL_PUBLIC_FILE, skillMd()],
];
const check = process.argv.includes('--check');
let stale = 0;
for (const [file, text] of files) {
  const name = relative(root, file);
  if (check) {
    let now = '';
    try {
      now = readFileSync(file, 'utf8');
    } catch {}
    if (now !== text) {
      console.error(`${name} is out of date: run npm run ai-guide`);
      stale++;
    } else console.log(`${name}: up to date`);
  } else {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    console.log(`${name}: ${text.length} characters`);
  }
}
if (stale) process.exit(1);
