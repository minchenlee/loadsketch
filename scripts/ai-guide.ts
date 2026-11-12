// Writes the files made from the format guide for AI models (src/schema/aiGuide.ts):
// - public/llms.txt: a short index (llmstxt.org), served at /llms.txt;
// - public/llms-full.txt: the full guide (the prompt for an AI holds the same text);
// - the Agent Skill skills/loadsketch/SKILL.md and reference.md, their copies in
//   public/skills/loadsketch/, and public/skills/loadsketch.zip (both in a loadsketch folder).
// --check: exit 1 when a file differs from the catalog (tests/ai-guide.test.ts does too).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { aiGuide, llmsIndex, referenceMd, skillMd } from '../src/schema/aiGuide.ts';
import { storeZip } from './zip.ts';

const root = join(import.meta.dirname, '..');

/** Every file made from the catalog, with its content. */
export function aiGuideFiles(): [string, string | Buffer][] {
  const skill = skillMd();
  const reference = referenceMd();
  return [
    ['public/llms.txt', llmsIndex()],
    ['public/llms-full.txt', aiGuide()],
    ['skills/loadsketch/SKILL.md', skill],
    ['skills/loadsketch/reference.md', reference],
    ['public/skills/loadsketch/SKILL.md', skill],
    ['public/skills/loadsketch/reference.md', reference],
    [
      'public/skills/loadsketch.zip',
      storeZip([
        ['loadsketch/SKILL.md', skill],
        ['loadsketch/reference.md', reference],
      ]),
    ],
  ];
}

if (import.meta.main ?? process.argv[1] === import.meta.filename) {
  const check = process.argv.includes('--check');
  let stale = 0;
  for (const [name, content] of aiGuideFiles()) {
    const file = join(root, name);
    const want = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    if (check) {
      let now: Buffer | null = null;
      try {
        now = readFileSync(file);
      } catch {}
      if (!now || !now.equals(want)) {
        console.error(`${name} is out of date: run npm run ai-guide`);
        stale++;
      } else console.log(`${name}: up to date`);
    } else {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, want);
      console.log(`${relative(root, file)}: ${want.length} bytes`);
    }
  }
  if (stale) process.exit(1);
}
