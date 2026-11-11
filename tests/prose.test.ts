// The side panel lays out design text: steps as a list, sources as links. Nothing may get lost.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { splitAction, splitSources, splitSteps, stepGap } from '../src/app/components/Prose.tsx';
import { EN } from '../src/i18n/en.ts';

const dir = join(import.meta.dirname, '..', 'examples', 'designs');
const designs = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
const both = (s: string) => [s, EN[s] || s];
const squash = (s: string) => s.replace(/[\s、,，。.:：;；]+/g, '');
const URL_RE = /https?:\/\/[^\s，、。）)]+/g;

describe('design text layout', () => {
  it('splits numbered steps only when they run 1, 2, 3', () => {
    expect(splitSteps('do this: 1) a. 2) b. 3) c.')).toEqual({ lead: 'do this:', steps: ['a.', 'b.', 'c.'] });
    expect(splitSteps('only 1) one step')).toBeNull();
    expect(splitSteps('2) b 3) c')).toBeNull();
    // a marker out of order means this is not a list
    expect(splitSteps('1) first 3) stray 2) second')).toBeNull();
  });

  it('every step of every note has a bold action, in both languages', () => {
    expect(splitAction('Raise the retries to 5 and watch. More text here.')).toEqual({ action: 'Raise the retries to 5 and watch.', rest: 'More text here.' });
    expect(splitAction('把重試改成 5 次：負載變大')).toEqual({ action: '把重試改成 5 次：', rest: '負載變大' });
    // a colon inside a URL is not the end of the action
    expect(splitAction('Open https://localhost:8080/health: it answers')).toEqual({ action: 'Open https://localhost:8080/health:', rest: 'it answers' });
    expect(splitAction('Open https://localhost:8080/health and look')).toEqual({ action: 'Open https://localhost:8080/health and look', rest: '' });
    // questions and exclamations end a sentence too
    expect(splitAction('Check this? Then change that.')).toEqual({ action: 'Check this?', rest: 'Then change that.' });
    expect(splitAction('看看這裡？再改那裡。')).toEqual({ action: '看看這裡？', rest: '再改那裡。' });
    expect(splitAction('see https://example.com: ok').action).toBe('see https://example.com:');
    // a URL next to CJK text ends at the CJK punctuation, as a link does
    expect(splitAction('Open https://x.io/health，然後把重試改成5次：負載變大')).toEqual({ action: 'Open https://x.io/health，然後把重試改成5次：', rest: '負載變大' });
    // a space follows an action that ends in ASCII punctuation, none after CJK punctuation
    for (const t of ['Check this? Then change that.', 'Stop! Then look.', 'Do it: now', 'Do it. Now'])
      expect(stepGap(splitAction(t).action, splitAction(t).rest), t).toBe(' ');
    expect(stepGap('看看這裡？', '再改那裡。')).toBe('');
    expect(stepGap('改成 5 次：', '負載變大')).toBe('');
    const notes = designs.flatMap((d) => (d.notes ?? []).map((n: { text: string }) => n.text)).filter((t: string) => /^試試看/.test(t));
    for (const zh of notes) for (const text of both(zh)) {
      const s = splitSteps(text.replace(/^(試試看|Try it|Try this)[:：]\s*/, ''))!;
      for (const step of s.steps) expect(splitAction(step).action, step.slice(0, 50)).not.toBe('');
    }
  });

  it('every "try it" note becomes steps with every word kept, in both languages', () => {
    const notes = designs.flatMap((d) => (d.notes ?? []).map((n: { text: string }) => n.text)).filter((t: string) => /^試試看/.test(t));
    expect(notes.length).toBeGreaterThanOrEqual(5);
    for (const zh of notes) for (const text of both(zh)) {
      const s = splitSteps(text.replace(/^(試試看|Try it|Try this)[:：]\s*/, ''))!;
      expect(s, text.slice(0, 40)).not.toBeNull();
      expect(s.steps.length).toBeGreaterThanOrEqual(2);
      expect(squash(s.lead + s.steps.join('')).replace(/\d\)/g, '')).toBe(squash(text.replace(/^(試試看|Try it|Try this)[:：]\s*/, '')).replace(/\d\)/g, ''));
    }
  });

  it('every description with sources keeps every URL and every word, in both languages', () => {
    const descs = designs.map((d) => d.description ?? '').filter((t: string) => t.includes('http'));
    expect(descs.length).toBeGreaterThanOrEqual(5);
    for (const zh of descs) for (const text of both(zh)) {
      const { body, sources, tail } = splitSources(text);
      const urls = [...text.matchAll(URL_RE)].map((m) => m[0].replace(/[.,]+$/, ''));
      expect(sources.map((s) => s.url), text.slice(0, 40)).toEqual(urls);
      expect(body).not.toMatch(/https?:/);
      expect(tail).not.toMatch(/https?:/);
      const words = squash(body + sources.map((s) => s.url + s.note).join('') + tail);
      expect(words.length).toBe(squash(text.replace(/(來源|Sources?)[:：]/, '')).length);
    }
  });
});
