// Lessons in the side panel of /app/, by example: the retry storm (course lesson 3.1), and course
// lesson 2.1. Course lessons live in src/learn/course/ (COURSE in course.ts); only the ones listed
// here open on the Learn tab of their example (three-tier, the example most e2e tests open, stays
// without one).
import type { Lesson } from './lesson.ts';
import { COURSE_BY_ID } from './course.ts';

const retryStorm = COURSE_BY_ID['3.1'];
const cacheHitRatio = COURSE_BY_ID['2.1'];

export const LESSONS: Record<string, Lesson> = { [retryStorm.example]: retryStorm, [cacheHitRatio.example]: cacheHitRatio };
