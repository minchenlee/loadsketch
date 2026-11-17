// The course table of contents: 7 units, 33 lessons (the course outline of 2026-11-17).
// A lesson shows as ready when its text exists (LESSONS in src/learn/lessons.ts, keyed by example);
// the others show as "coming soon", so a lesson appears here as soon as its text lands.
// Titles are message ids (tx); the lesson text itself lives in src/learn/.
import { tx } from '../i18n/index.ts';
import { LESSONS } from '../learn/lessons.ts';
import type { Lesson } from '../learn/lesson.ts';

export interface CourseLesson {
  /** "3.1": unit and place in the unit. Also the ?lesson= value. */
  id: string;
  title: string; // message id
  /** The example it opens; none for a lesson that is a practice problem or a guide. */
  example?: string;
  minutes: number;
  wave: 1 | 2;
}

export interface Unit {
  id: number;
  title: string; // message id
  lessons: CourseLesson[];
}

const L = (id: string, title: string, example: string | undefined, minutes: number, wave: 1 | 2): CourseLesson => ({ id, title, example, minutes, wave });

export const UNITS: Unit[] = [
  { id: 0, title: tx('Orientation'), lessons: [L('0.1', tx('Read a run'), 'three-tier', 15, 1)] },
  {
    id: 1,
    title: tx('Capacity and queueing'),
    lessons: [
      L('1.1', tx("Little's law and one server"), 'single-server', 20, 1),
      L('1.2', tx('Where is the ceiling?'), 'three-tier', 20, 1),
      L('1.3', tx('Bounded queues, timeouts and CoDel'), 'lifo-codel', 25, 1),
      L('1.4', tx('Spikes, cron and daily cycles'), 'periodic', 20, 2),
      L('1.5', tx('Autoscaling is slow'), 'autoscale', 25, 1),
    ],
  },
  {
    id: 2,
    title: tx('Caching and data'),
    lessons: [
      L('2.1', tx('Hit ratio decides the database'), 'url-shortener', 20, 1),
      L('2.2', tx('Cache stampede'), 'cache-stampede', 25, 1),
      L('2.3', tx('Cold cache after a restart'), 'cache-cold-restart', 15, 2),
      L('2.4', tx('Read replicas and lag'), 'replica-lag', 25, 1),
      L('2.5', tx('Sharding and hot keys'), 'sharded', 25, 1),
      L('2.6', tx('Scatter-gather and quorum'), 'scatter-gather', 20, 2),
    ],
  },
  {
    id: 3,
    title: tx('Overload and retries'),
    lessons: [
      L('3.1', tx('Retry storm'), 'retry-storm', 20, 1),
      L('3.2', tx('Retry budgets, throttling and deadlines'), 'retry-budget', 25, 1),
      L('3.3', tx('Rate limiting at the door'), 'flash-sale', 20, 1),
      L('3.4', tx('Load shedding by priority'), 'priority-shedding', 15, 2),
      L('3.5', tx('Serverless cold starts and connection limits'), 'serverless-db', 20, 2),
    ],
  },
  {
    id: 4,
    title: tx('Failure and resilience'),
    lessons: [
      L('4.1', tx('Slow dependency: timeout, bulkhead, fallback, breaker'), 'slow-dependency', 30, 1),
      L('4.2', tx('Gray failure, health checks and hedging'), 'gray-failure', 25, 1),
      L('4.3', tx('Failover, partitions and split brain'), 'split-brain', 25, 2),
      L('4.4', tx('Multi-region cutover and DNS'), 'region-cutover', 20, 2),
      L('4.5', tx('Control plane and bootstrap dependencies'), 'provisioning', 20, 2),
      L('4.6', tx('Bad deploys: canary vs global push'), 'bad-config-push', 20, 2),
    ],
  },
  {
    id: 5,
    title: tx('Async and messaging'),
    lessons: [
      L('5.1', tx('Queues absorb bursts'), 'async-queue', 20, 1),
      L('5.2', tx('At-least-once, duplicates and the DLQ'), 'async-reliable', 25, 1),
      L('5.3', tx('FIFO and head-of-line blocking'), 'fifo-poison', 15, 2),
      L('5.4', tx('Dual writes and the outbox'), 'order-outbox', 20, 2),
      L('5.5', tx('Fan-out on write'), 'timeline-fanout', 15, 2),
    ],
  },
  {
    id: 6,
    title: tx('Capstones'),
    lessons: [
      L('6.1', tx('Capstone: design a URL shortener from a brief'), undefined, 40, 1),
      L('6.2', tx('Incident replay: Slack 2022 cache flush'), 'saas-slack', 25, 1),
      L('6.3', tx('Incident replay: Stripe 2019'), 'saas-stripe', 25, 2),
      L('6.4', tx('On-call drills'), undefined, 80, 2),
      L('6.5', tx('Architect track: import Terraform, find the limit'), undefined, 30, 2),
    ],
  },
];

export const ALL_LESSONS: CourseLesson[] = UNITS.flatMap((u) => u.lessons);

/** The lesson text, when it is written. */
export function lessonOf(l: CourseLesson): Lesson | undefined {
  return l.example ? LESSONS[l.example] : undefined;
}

export function findLesson(id: string | null): CourseLesson | undefined {
  return ALL_LESSONS.find((l) => l.id === id);
}

/** The next lesson that is ready, after this one. */
export function nextReady(id: string): CourseLesson | undefined {
  const i = ALL_LESSONS.findIndex((l) => l.id === id);
  return ALL_LESSONS.slice(i + 1).find((l) => lessonOf(l));
}
