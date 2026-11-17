// A choice in a course question needs its own message id. A short id the interface already uses
// (“None” is the stampede protection option, translated 「不保護」) shows the interface's
// translation under the question (Fable review M3).
import { expect, it } from 'vitest';
import { COURSE } from '../../src/learn/course.ts';
import { KINDS } from '../../src/schema/kinds.ts';

const MINE = ['3.1', '3.2', '3.3', '4.1', '4.2', '5.1', '5.2', '6.1', '6.2'];
const strings = (x: unknown, out: Set<string>): Set<string> => {
  if (typeof x === 'string') out.add(x);
  else if (x && typeof x === 'object') for (const v of Object.values(x)) strings(v, out);
  return out;
};

it('no choice of a question in 3.1–6.2 reuses a text of the component kinds', () => {
  const ui = strings(KINDS, new Set());
  for (const l of COURSE.filter((x) => MINE.includes(x.id!))) {
    for (const q of l.questions) for (const o of q.options) expect(ui.has(o.text), `${l.id} ${q.id}: ${o.text}`).toBe(false);
  }
});
