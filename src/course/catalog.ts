// The course table of contents: the units of src/learn/course.ts (UNITS) and the lessons of the
// course outline (2026-11-17, 33 lessons). A lesson is ready when its file exists (COURSE_BY_ID);
// the others show as "coming soon" with the outline's title, so a lesson appears here as soon as
// its file lands. A lesson file not in the outline is shown too, in its unit.
import { tx } from '../i18n/index.ts';
import { COURSE, COURSE_BY_ID, UNITS as UNIT_TITLES } from '../learn/course.ts';
import type { Lesson } from '../learn/lesson.ts';

export interface CourseLesson {
  /** "3.1": unit and place in the unit. Also the ?lesson= value. */
  id: string;
  title: string; // message id
  minutes: number;
  wave: 1 | 2;
  /** The lesson text; none while it is not written. */
  lesson?: Lesson;
}

export interface Unit {
  id: number;
  title: string; // message id
  lessons: CourseLesson[];
}

/** The outline: id, title, the example it is planned on, minutes, wave. */
const OUTLINE: [string, string, string | undefined, number, 1 | 2][] = [
  ['0.1', tx('Read a run'), 'three-tier', 15, 1],
  ['1.1', tx("Little's law and one server"), 'single-server', 20, 1],
  ['1.2', tx('Where is the ceiling?'), 'three-tier', 20, 1],
  ['1.3', tx('Bounded queues, timeouts and CoDel'), 'lifo-codel', 25, 1],
  ['1.4', tx('Spikes, cron and daily cycles'), 'periodic', 20, 2],
  ['1.5', tx('Autoscaling is slow'), 'autoscale', 25, 1],
  ['2.1', tx('Hit ratio decides the database'), 'url-shortener', 20, 1],
  ['2.2', tx('Cache stampede'), 'cache-stampede', 25, 1],
  ['2.3', tx('Cold cache after a restart'), 'cache-cold-restart', 15, 2],
  ['2.4', tx('Read replicas and lag'), 'replica-lag', 25, 1],
  ['2.5', tx('Sharding and hot keys'), 'sharded', 25, 1],
  ['2.6', tx('Scatter-gather and quorum'), 'scatter-gather', 20, 2],
  ['3.1', tx('Retry storm'), 'retry-storm', 20, 1],
  ['3.2', tx('Retry budgets, throttling and deadlines'), 'retry-budget', 25, 1],
  ['3.3', tx('Rate limiting at the door'), 'flash-sale', 20, 1],
  ['3.4', tx('Load shedding by priority'), 'priority-shedding', 15, 2],
  ['3.5', tx('Serverless cold starts and connection limits'), 'serverless-db', 20, 2],
  ['4.1', tx('Slow dependency: timeout, bulkhead, fallback, breaker'), 'slow-dependency', 30, 1],
  ['4.2', tx('Gray failure, health checks and hedging'), 'gray-failure', 25, 1],
  ['4.3', tx('Failover, partitions and split brain'), 'split-brain', 25, 2],
  ['4.4', tx('Multi-region cutover and DNS'), 'region-cutover', 20, 2],
  ['4.5', tx('Control plane and bootstrap dependencies'), 'provisioning', 20, 2],
  ['4.6', tx('Bad deploys: canary vs global push'), 'bad-config-push', 20, 2],
  ['5.1', tx('Queues absorb bursts'), 'async-queue', 20, 1],
  ['5.2', tx('At-least-once, duplicates and the DLQ'), 'async-reliable', 25, 1],
  ['5.3', tx('FIFO and head-of-line blocking'), 'fifo-poison', 15, 2],
  ['5.4', tx('Dual writes and the outbox'), 'order-outbox', 20, 2],
  ['5.5', tx('Fan-out on write'), 'timeline-fanout', 15, 2],
  ['6.1', tx('Capstone: design a URL shortener from a brief'), undefined, 40, 1],
  ['6.2', tx('Incident replay: Slack 2022 cache flush'), 'saas-slack', 25, 1],
  ['6.3', tx('Incident replay: Stripe 2019'), 'saas-stripe', 25, 2],
  ['6.4', tx('On-call drills'), undefined, 80, 2],
  ['6.5', tx('Architect track: import Terraform, find the limit'), undefined, 30, 2],
];

const order = (id: string) => id.split('.').map(Number);
const byId = (a: { id: string }, b: { id: string }) => order(a.id)[0] - order(b.id)[0] || order(a.id)[1] - order(b.id)[1];

const outlined: CourseLesson[] = OUTLINE.map(([id, title, , minutes, wave]) => {
  const lesson = COURSE_BY_ID[id];
  return { id, title: lesson?.title ?? title, minutes: lesson?.minutes ?? minutes, wave: lesson?.wave ?? wave, lesson };
});
const extra: CourseLesson[] = COURSE.filter((l) => !OUTLINE.some(([id]) => id === l.id)).map((l) => ({ id: l.id!, title: l.title ?? l.id!, minutes: l.minutes ?? 0, wave: l.wave ?? 2, lesson: l }));

export const ALL_LESSONS: CourseLesson[] = [...outlined, ...extra].sort(byId);

export const UNITS: Unit[] = Object.entries(UNIT_TITLES)
  .map(([k, title]) => ({ id: Number(k), title, lessons: ALL_LESSONS.filter((l) => order(l.id)[0] === Number(k)) }))
  .sort((a, b) => a.id - b.id);

export function findLesson(id: string | null): CourseLesson | undefined {
  return ALL_LESSONS.find((l) => l.id === id);
}

/** The next lesson that is ready, after this one. */
export function nextReady(id: string): CourseLesson | undefined {
  const i = ALL_LESSONS.findIndex((l) => l.id === id);
  return ALL_LESSONS.slice(i + 1).find((l) => l.lesson);
}
