// The course: lessons in units, each a file in src/learn/course/ (one lesson per file, so writers
// do not edit the same lines). A lesson file default-exports a Lesson with id, title, unit, order,
// minutes and wave set. Pure: no React, no DOM.
import { tx } from '../i18n/index.ts';
import type { Lesson } from './lesson.ts';

/** The units of the course, by number (Lesson.unit). Titles are message ids. */
export const UNITS: Record<number, string> = {
  0: tx('Orientation'),
  1: tx('Capacity and queueing'),
  2: tx('Caching and data'),
  3: tx('Overload and retries'),
  4: tx('Failure and resilience'),
  5: tx('Async and messaging'),
  6: tx('Capstones'),
};

const files = import.meta.glob('./course/*.ts', { eager: true, import: 'default' }) as Record<string, Lesson>;

/** Every course lesson, in course order (unit, then order). */
export const COURSE: Lesson[] = Object.values(files).sort((a, b) => (a.unit ?? 0) - (b.unit ?? 0) || (a.order ?? 0) - (b.order ?? 0));

/** A course lesson by its number ("2.1"). */
export const COURSE_BY_ID: Record<string, Lesson> = Object.fromEntries(COURSE.map((l) => [l.id!, l]));

/** The lessons of one unit, in order. */
export const lessonsOfUnit = (unit: number): Lesson[] => COURSE.filter((l) => l.unit === unit);
