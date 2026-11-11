// Lessons that ship with the examples. First theme: the retry storm.
import { t, tx } from '../i18n/index.ts';
import { keepRetries, noMoreCapacity, type Goal, type Lesson } from './lesson.ts';
import { peakAmp, recoveryS, spikeEnd, type RunData } from './metrics.ts';

const ms = (x: number) => `${Math.round(x)} ms`;
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

const recovery = (run: RunData) => recoveryS(run, spikeEnd(run.scenario));
const recoveryText = (run: RunData) => {
  const s = recovery(run);
  if (s === Infinity) return t('到結束都沒有恢復');
  if (s === 0) return t('突波結束時已經沒有失敗');
  return t('突波結束後 {s} 秒恢復', { s: Math.round(s) });
};

const failUnder10: Goal = {
  text: tx('整場失敗率低於 10%'),
  check: (run) => ({ ok: run.result.summary.errorRate < 0.1, value: pct(run.result.summary.errorRate) }),
};

const retryStorm: Lesson = {
  example: 'retry-storm',
  intro: tx('三層式網站，每一跳都設逾時 150 ms、重試 3 次。第 20–30 秒流量變 3 倍。先猜會發生什麼，再按「執行」。'),
  scenario: 'retry-storm',
  questions: [
    {
      id: 'recover',
      topic: 'recovery',
      text: tx('第 20–30 秒流量變 3 倍。第 30 秒流量回到正常後，系統會怎樣？'),
      options: [
        { id: 'fast', text: tx('幾秒內恢復正常') },
        { id: 'slow', text: tx('慢慢恢復，要 10 秒以上') },
        { id: 'never', text: tx('一直壞下去') },
      ],
      answer: (run) => {
        const s = recovery(run);
        return s <= 5 ? 'fast' : s === Infinity ? 'never' : 'slow';
      },
      measured: recoveryText,
      explain: tx('突波時，逾時的呼叫被重試，每個請求最多送 4 次。突波結束後，排隊裡還塞滿重試，新請求一樣等太久、逾時、再被重試：系統停在壞的狀態。'),
      explainFor: {
        fast: tx('這個設計在突波時沒讓重試堆起來（限制了重試，或很快拒絕），排隊沒有塞滿，所以流量一回到正常就恢復。'),
        slow: tx('重試在突波時堆起來了，但沒有多到讓系統一直卡住：排隊慢慢消化完才恢復。'),
      },
    },
    {
      id: 'amp',
      topic: 'retry',
      text: tx('突波時，API 伺服器每秒收到的請求，最多是平常的幾倍？'),
      options: [
        { id: 'x3', text: tx('約 3 倍，和使用者流量一樣') },
        { id: 'x6', text: tx('約 6 倍') },
        { id: 'x10', text: tx('超過 10 倍') },
      ],
      answer: (run) => {
        const x = peakAmp(run, 'api', 20, 30);
        return x < 4.5 ? 'x3' : x < 9 ? 'x6' : 'x10';
      },
      measured: (run) => t('最多是平常的 {x} 倍', { x: peakAmp(run, 'api', 20, 30).toFixed(1) }),
      explain: tx('負載平衡器到 API 的呼叫失敗（逾時或被拒絕）後會重試 3 次。API 滿載時大部分呼叫都失敗，所以 API 收到的是使用者流量的好幾倍。'),
      explainFor: { x3: tx('重試沒有放大流量：API 收到的請求和使用者流量差不多一樣多。') },
    },
  ],
  challenges: [
    {
      id: 'retry-storm/recover',
      title: tx('自己恢復'),
      text: tx('突波結束後 5 秒內恢復正常，而且不能加機器。'),
      goals: [{ text: tx('突波結束後 5 秒內恢復（之後每一秒的失敗都低於 5%）'), check: (run) => ({ ok: recovery(run) <= 5, value: recoveryText(run) }) }],
      rules: [noMoreCapacity],
      hint: tx('看連線上的重試設定。「重試預算」限制重試佔呼叫的比例，突波時重試就不會越滾越多。'),
    },
    {
      id: 'retry-storm/fail-less',
      title: tx('少丟一點'),
      text: tx('整場的失敗率低於 10%，而且不能加機器。'),
      goals: [failUnder10],
      rules: [noMoreCapacity],
      hint: tx('突波時 API 伺服器的處理能力不夠，一定有請求要失敗。讓它們排 150 ms 才逾時，不如馬上拒絕：試試把 API 伺服器的「排隊上限」調小，或改用 CoDel 佇列。'),
    },
    {
      id: 'retry-storm/keep-retries',
      title: tx('重試照留'),
      text: tx('每條原本有重試的連線至少還要重試 1 次，整場失敗率低於 10%，成功請求的 p99 低於 130 ms。'),
      goals: [
        failUnder10,
        { text: tx('成功請求的 p99 低於 130 ms'), check: (run) => ({ ok: run.result.summary.latencyMs.p99 < 130, value: ms(run.result.summary.latencyMs.p99) }) },
      ],
      rules: [noMoreCapacity, keepRetries],
      hint: tx('把排隊上限調小後，被拒絕的呼叫會被重試，又把流量放大。再加上重試預算，限制重試的總量。'),
    },
  ],
};

export const LESSONS: Record<string, Lesson> = { [retryStorm.example]: retryStorm };
