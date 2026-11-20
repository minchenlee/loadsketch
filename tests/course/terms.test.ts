// Words that must not mix in zh-TW (Fable review M5). 3.2's throttling is the caller rejecting by
// itself: 「自適應限流」, as in the interface. A bare 「限流」 is rate limiting (3.3, 6.2), which is
// a different thing.
import { expect, it } from 'vitest';
import { COURSE, COURSE_BY_ID } from '../../src/learn/course.ts';
import { ZH } from '../../src/i18n/zh-TW.ts';
import { keepThrottle } from '../../src/learn/lessonKit2.ts';

const strings = (x: unknown, out: Set<string>): Set<string> => {
  if (typeof x === 'string') out.add(x);
  else if (x && typeof x === 'object') for (const v of Object.values(x)) strings(v, out);
  return out;
};

const MINE = ['3.1', '3.2', '3.3', '4.1', '4.2', '5.1', '5.2', '6.1', '6.2'];

it('3.1–6.2 spell English as the interface does (utilization, modeled)', () => {
  for (const id of strings(COURSE.filter((l) => MINE.includes(l.id!)), new Set())) expect(id).not.toMatch(/utilis|modell/);
});

it('6.2 says connected and booting clients: “started” and “starting” are one letter apart (Fable S1)', () => {
  for (const id of strings(COURSE_BY_ID['6.2'], new Set())) expect(id).not.toMatch(/start(ed|ing) clients/);
});

it('3.2 calls adaptive throttling 「自適應限流」 in zh-TW, and never a bare 「限流」', () => {
  const ids = strings([COURSE_BY_ID['3.2'], keepThrottle(3)], new Set());
  for (const id of ids) {
    const zh = ZH[id];
    if (!zh) continue;
    expect(zh.replace(/自適應限流（adaptive throttling/g, '自適應限流'), id).not.toMatch(/throttling|(?<!自適應)限流/i);
  }
});
