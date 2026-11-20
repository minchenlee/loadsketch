// The tries of one simulator frame stack (tests/course/pageTries.ts). In lessons 3.1–6.2 every try
// says what it changes from the original design, so a later try must set back what an earlier one
// changed: with the earlier patches under it, it must give the same design as on its own
// (Fable review M1, M2).
import { describe, expect, it } from 'vitest';
import { COURSE } from '../../src/learn/course.ts';
import { applyPatches } from '../../src/learn/oncall.ts';
import { pageTries } from './pageTries.ts';
import { design } from './run.ts';

const MINE = ['3.1', '3.2', '3.3', '4.1', '4.2', '5.1', '5.2', '6.1', '6.2'];

describe('a try gives the same design whether or not the earlier tries of its frame are under it', () => {
  for (const l of COURSE.filter((x) => MINE.includes(x.id!))) {
    it(l.id!, () => {
      for (const t of pageTries(l)) {
        const d = design(t.example);
        expect(applyPatches(d, t.stacked), `step ${t.step}`).toEqual(applyPatches(d, t.own));
      }
    });
  }
});
