// Writes the format guide for AI models (src/schema/aiGuide.ts) to public/llms.txt, served at
// /llms.txt. --check: exit 1 when the file differs from the catalog (tests/ai-guide.test.ts does too).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { aiGuide } from '../src/schema/aiGuide.ts';

export const GUIDE_FILE = join(import.meta.dirname, '..', 'public', 'llms.txt');
const text = aiGuide();
if (process.argv.includes('--check')) {
  let now = '';
  try {
    now = readFileSync(GUIDE_FILE, 'utf8');
  } catch {}
  if (now !== text) {
    console.error('public/llms.txt is out of date: run npm run ai-guide');
    process.exit(1);
  }
  console.log('public/llms.txt: up to date');
} else {
  writeFileSync(GUIDE_FILE, text);
  console.log(`public/llms.txt: ${text.length} characters`);
}
