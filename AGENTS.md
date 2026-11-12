# AGENTS.md

給要改 loadsketch 的 agent 和人。先讀「規則」，再看你要做的事在哪一節。English summary at the end.

`scripts/check-agents-md.ts` 會檢查這份文件：每個路徑都存在、每個「檔案＋名稱」都在那個檔案裡找得到、每個指令都能執行。改了程式碼裡的名稱，要一起改這裡。

## 結構

- `src/schema/`：設計檔和情境檔的格式（zod）、元件種類（`kinds.ts`）、設計檢查。不依賴瀏覽器。
- `src/engine/`：離散事件模擬。`sim.ts` 的 `Simulation` 是全部元件的行為；`scale.ts` 把大流量縮成 1/k 來跑；`theory.ts` 是排隊理論的對照。不依賴瀏覽器。
- `src/core/index.ts`：給瀏覽器以外的程式（CLI、之後的 IaC 匯入）用的入口，轉出 schema、engine 和 `costOf`。不能碰到 `src/app/`、React、DOM，learn 只能用 `cost.ts`（`tests/boundary.test.ts` 沿 import 往下查）。
- `src/schema/aiGuide.ts`：給 AI 讀的格式說明（英文），從 `KINDS`、`EDGE_PARAMS` 和英文翻譯產生。`npm run ai-guide`（`scripts/ai-guide.ts` 的 `aiGuideFiles()`）寫：完整說明 `aiGuide()` 到 `public/llms-full.txt`，短索引 `llmsIndex()` 到 `public/llms.txt`，Agent Skill 的 `skillMd()` 和 `referenceMd()` 到 `skills/loadsketch/`、`public/skills/loadsketch/`，以及 `public/skills/loadsketch.zip`（`scripts/zip.ts`，不壓縮、固定時間）；貼上設計的對話框（`src/app/components/PasteDesign.tsx`）用 `aiPrompt()` 複製給 AI 的提示。
- `src/learn/`：課程、值班題、限制題、需求題、成本、診斷。讀模擬結果，不改引擎。
- `src/site/main.tsx`：介紹頁（網址 `/`）。模擬器在 `/app/`（`app/index.html`）；介紹頁上會動的畫面是 iframe 裡的模擬器，用 `?embed=1`（`src/app/App.tsx` 的 `EMBED`）。
- `src/app/`：React 介面。狀態在 `store.ts`（zustand）；模擬在 Web Worker 跑（`src/worker/sim.worker.ts`）。
- `cli/loadsketch.ts`：命令列（run、validate、fmt、schema、import），用 schema、engine 和 `src/import/`。
- `src/import/terraform/`：Terraform plan JSON 轉成設計檔（`plan.ts` 解析、`graph.ts` 資源圖、`rules.ts` 對應規則、`fill.ts` 補值（`instances.ts` 機型表、`answers.ts` 答案檔）、`checks.ts` 靜態檢查、`index.ts` 組裝）。報告文字在 `src/i18n/importReport.ts`。匯入的設計檔在 node 和 edge 帶選填的 `source`；手寫的設計檔不會有。只回傳訊息 id；文字在 `src/i18n/importMessages.ts`。fixture 在 `tests/import/fixtures/`。
- `examples/designs/`、`examples/scenarios/`：範例（JSON）。新增範例就是新增檔案。
- `docs/model.md`：模擬模型的說明（中文）。
- `docs/design-system.md`：介面的外觀和動態規則（token、玻璃、彈性動畫、畫布卡片、頂端列）。

## 指令

```sh
npm run test:quick          # 約 10 秒：快的單元測試＋i18n 檢查。每次改完先跑這個
npm run test:slow           # 慢的單元測試（含 golden）
npx vitest run tests/golden.test.ts
UPDATE_GOLDEN=1 npx vitest run tests/golden.test.ts
npm run i18n:check
node scripts/i18n-extract.ts
npm run typecheck
npx playwright test         # e2e，約 3 分鐘
npm run schema              # 格式改了以後，重新產生 schema/*.json
npm run ai-guide            # 元件、參數或它們的英文改了以後，重新產生 llms.txt、llms-full.txt、SKILL.md、reference.md 和 zip（tests/ai-guide.test.ts 會檢查）
npm run loadsketch -- run examples/designs/three-tier.json --json
npm run loadsketch -- import terraform tests/import/fixtures/ecs-rds.plan.json --out /tmp/x.json   # 加 --answers <檔> 套答案檔；--report <檔.md> 寫報告；--strict 有確定的 high 就回傳 1
node scripts/check-agents-md.ts
```

## 規則

1. **修前要失敗。** 修 bug 或改引擎行為時，先寫一個在修改前會失敗的測試，確認它失敗，再改程式碼。
2. **golden 測試。** `tests/golden.test.ts` 用固定 seed 跑每個範例，記下結果的雜湊（`tests/golden.json`）。只改結構、不改行為時，雜湊必須完全一樣。有意改變行為時，用 `UPDATE_GOLDEN=1` 更新，並在 commit 訊息寫原因。
3. **i18n。** 介面文字寫成中文原文：`t('…')` 立刻翻譯，`tx('…')` 只標記、顯示時才翻譯。改完跑 `node scripts/i18n-extract.ts`，再到 `src/i18n/en.ts` 把空字串補上英文；`npm run i18n:check` 要回報 0 則缺英文。
4. **不用 HTML `<select>` 和 `<input type="number">`。** 用 `src/app/components/Select.tsx` 的 `Select` 和 `NumberField`。e2e 會檢查（`e2e/app.spec.ts` 的 "dropdowns are our own menus"）。
5. **速度預算看 CPU 時間。** 測試要檢查「跑得夠快」時，用 `tests/helpers.ts` 的 `cpuMs()`，不要用牆上時間：機器忙的時候牆上時間會變長。
6. **格式只加不改。** `loadsketch/design@1` 只加選填欄位，不改已有欄位的意思；舊的設計檔和分享連結要能打開。格式改了要跑 `npm run schema`（`tests/format.test.ts` 會檢查 `schema/` 有沒有更新）。
7. **改 UI 先讀 `docs/design-system.md`。** 玻璃只給浮在別的內容上面的東西；彈性曲線只用在 `transform`；資料（數字、圖表、請求的點）不加裝飾動畫；連線和箭頭是灰色；類別色光暈保持很淡；每個新動畫都要在 `prefers-reduced-motion` 時關閉。改了這些規則，要一起改那份文件。

## 新增一種元件：要改的檔案

照順序改。漏改時，括號裡的測試會失敗。

1. `src/schema/kinds.ts` 的 `KINDS`：加一項。`station`（有實例、槽和排隊）和 `routing`（`one`／`plan`／`leaf`／`queue`）決定引擎走哪條共用路徑；`params` 用 `ParamSpec`，Inspector 的欄位由它自動產生。`label`、`summary`、參數的 `label`、`help` 是中文訊息 id。
2. `src/schema/design.ts`：
   - `nodeSchemas`：只有這種元件才有的頂層欄位（例如 `replicaRegion`）。
   - `STORE_KINDS`（cache 讀穿到它、扇出寫入每一份）和 `PAUSABLE`（能收 `pause` 事件）：屬於這類就加進去。
   - `checkDesign()` 裡有依種類的檢查；需要就加。
3. `src/engine/sim.ts`：
   - `handle()` 的 `switch (n.kind)`：請求到達時走哪條路（轉送、平衡、排隊）。
   - `runJob()` 的 `switch (n.kind)`：一個工作在實例上怎麼做完。
   - `buildPlan()`：`routing: 'plan'` 的元件怎麼決定要呼叫哪些下游。
   - 檔案開頭的 `STORE_KINDS`：和 `src/schema/design.ts`、`src/app/components/FlowEdge.tsx` 的 `STORE_KINDS` 要一致（三份）。
4. `src/engine/scale.ts`：`ROLLOUT_KINDS`（能部署新版本）；`nodeMaxK()` 決定這種元件最多能縮幾倍。
5. `src/learn/cost.ts`：`MACHINE`（按台計價）或 `MANAGED`（託管，按請求計價），擇一。
6. `src/learn/constraints.ts` 的 `KIND_POINTS`：複雜度點數。
7. `src/app/paramLayout.ts` 的 `GROUPS`：每個參數都要分組（`tests/params-ui.test.ts` 會檢查沒有參數落在「其他」）。
8. `src/app/ui.ts` 的 `ICONS`：`src/schema/kinds.ts` 的 `KINDS` 用到的 lucide 圖示名稱要在這裡。
9. `src/app/components/ComponentNode.tsx` 的 `paramSummary()`：畫布卡片上的一行摘要。
10. `src/i18n/en.ts`：跑 `node scripts/i18n-extract.ts` 後補英文。補完再跑 `npm run ai-guide`（`tests/ai-guide.test.ts` 會檢查 `npm run ai-guide` 產生的每個檔案）。
11. 測試：在 `tests/components.test.ts` 加行為測試；加一個範例到 `examples/designs/`（`tests/examples.test.ts` 會要求它有分類：`src/app/examples.ts` 的 `CATEGORIES`），再跑 `UPDATE_GOLDEN=1 npx vitest run tests/golden.test.ts`。
12. 格式改了：`npm run schema`。

## 改既有行為：在哪裡

都在 `src/engine/sim.ts`。用名稱搜尋，不要用行號（行號會變）。

- **請求怎麼流**：`send()` 產生請求 → `callEdge()` 走一條線（逾時、重試、backoff、預算、扇出）→ `handle()` 依元件種類分派 → `balance()` 選實例 → `submit()` 排隊 → `runJob()` 做完 → `finish()` 記結果。
- **重試、逾時、重試預算、hedging**：`callEdge()`；扇出和 quorum：`scatter()`、`fanoutTargets()`。
- **熔斷器**：`breaker()`。
- **限流和 client 端 throttling**：`limit()`、`thrBucket()`。
- **快取**（cache-aside、讀穿、lease、coalescing、TTL）：`cacheOp()`、`cachePut()`；跨區複製：`cacheReplicate()`。
- **資料庫**：複製和讀到舊資料：`replicate()`；failover：`scheduleFailover()`、`promote()`；網路分區：`schedulePartition()`；列鎖：`unlock()`。
- **佇列和 worker**（至少一次、DLQ、FIFO 分組、過期）：`enqueue()`、`dispatch()`、`deliver()`、`reappear()`、`msgExpired()`。
- **outbox 和 dual write**：`dualWriteSteps()`、`relay()`。
- **自動擴充**：`scheduleScale()`、`scaleNow()`、`bootUp()`；開機依賴和控制面：`control()`。
- **health check 和 outlier detection**：`scheduleHealthChecks()`、`probe()`、`outlierNote()`。
- **情境事件**（down、slow、spike、shift、rollout…）：`scheduleEvents()`、`scheduleShift()`、`scheduleRollout()`。
- **DNS**：`scheduleDnsChecks()`、`dnsPick()`。
- **結果和瓶頸說明**：`resultRaw()`、`why()`、`explain()`。
- 排隊理論的對照：`src/engine/theory.ts` 的 `mgc()`、`erlangC()`。

改完：先 `npm run test:quick`，再 `npx vitest run tests/golden.test.ts`。只有你想改的那些範例雜湊變了，才是對的。

## 新增其他東西

- **範例**：在 `examples/designs/` 加 JSON，在 `src/app/examples.ts` 的 `CATEGORIES` 放進一個分類；要搭配特定情境時，加到 `src/app/exampleScenarios.ts` 的 `EXAMPLE_SCENARIO`。
- **情境**：在 `examples/scenarios/` 加 JSON。適用任何設計的，加到 `src/app/store.ts` 的 `GENERAL_SCENARIOS`。
- **情境事件種類**：`src/schema/design.ts` 的 `ScenarioEvent`（zod union），`src/engine/sim.ts` 的 `scheduleEvents()`，情境編輯器 `src/app/scenarioEdit.ts`。
- **頂端列**：`src/app/components/TopBar.tsx`。新動作預設放進檔案選單或更多選單（`src/app/components/Menu.tsx` 的 `Menu`），不加新的文字按鈕。例外：使用者要求的 GitHub 圖示按鈕（只有圖示，在面板按鈕和「更多」之間；手機放進「更多」選單；embed 不顯示）。repo 網址只寫在 `src/repo.ts` 的 `REPO`。
- **畫布的動態**（進場、拖曳傾斜、換範例時的飛行）：`src/app/motion.ts` 和 `src/app/components/Canvas.tsx`。對話框的關閉動畫：`src/app/modal.ts` 的 `useExit()`。面板開關：`src/app/components/Slide.tsx` 的 `Slide`。
- **手機版面（480px 以下）**：`src/app/phone.ts`、`src/app/components/Phone.tsx`（底部分頁和抽屜）；規則在 `docs/design-system.md` 第 8 節。
- **右側面板的分頁**：`src/app/components/Inspector.tsx`（分頁清單和 `Tab` 型別）；元件從 `useApp` 讀狀態。
- **版本和比較**：版本存在瀏覽器（`src/app/versions.ts`，格式 `loadsketch/versions@1`），面板是 `src/app/components/Versions.tsx`。比較畫面是 `src/app/components/Compare.tsx` 和 `src/app/compare.ts`；重跑時每個版本一個 worker（`src/worker/compare.worker.ts`），這個分頁跑完的曲線留在記憶體（`src/app/curves.ts` 的 `curves`，最多 8 個，不存進 localStorage），有曲線的版本不重跑。差異清單是 `src/app/designDiff.ts` 的 `diffDesigns()`；線的配對在 `pairEdges()`，貼上設計也用它。
- **貼上設計**：`src/app/pasteDesign.ts`。`readPasted()` 用白話說哪裡不合格式；`keepSources()` 把模型漏掉的 Terraform 匯入來源補回，改過的值改標成使用者填（`src/app/sources.ts` 的 `editedSources()`）。對話框是 `src/app/components/PasteDesign.tsx`。
- **元件樣板**：`src/app/presets.ts`（格式 `loadsketch/presets@1`，存在 localStorage，可以匯出和匯入）。只存名稱、種類和 params。元件列的「我的樣板」在 `src/app/components/Palette.tsx`；「存成樣板」在 `src/app/components/Inspector.tsx`。
- **自訂服務**（kind `custom`，`src/schema/kinds.ts` 的 `CUSTOM_KIND`）：使用者自己填名稱、圖示、時間、容量、錯誤率、呼叫方式和價格。引擎走和 API 伺服器一樣的共用路徑。成本是台數 × 使用者填的單價（`src/learn/cost.ts`）。練習題不能用：`src/learn/constraints.ts` 的 `customUsed()`。新增一種練習題的判定時，要呼叫它。
- **課程（範例題目、挑戰）**：`src/learn/lessons.ts`，格式在 `src/learn/lesson.ts`（`Lesson`、`Question`、`Challenge`）。
- **值班題**：`src/learn/oncall.ts` 的 `INCIDENTS`。
- **需求題**（從需求和幾乎空白的畫布開始）：`src/learn/briefs.ts` 的 `BRIEFS`。每題要有 `reference`（過關）和 `naive`（最常見的第一版，不過關），`tests/briefs.test.ts` 會跑這兩個設計。零件的速度是已知條件：處理時間不能比該種元件的預設值短（`floors` 可以另外給），命中率不能比預設高；`fixed` 的節點不能改也不能刪。題目用的情境裡，指定節點的事件（down、slow…）只能指向 `fixed` 的節點：使用者自己加的節點 id 事先不知道。

## English summary

loadsketch is a discrete-event simulator for system designs, with a React UI and a CLI. Layers: `src/schema` (format, component kinds, checks) → `src/engine` (simulation; `Simulation` in `sim.ts` holds every component's behaviour) → `src/learn` (lessons, on-call drills, cost) → `src/app` (UI; the simulation runs in a Web Worker). The schema and engine do not use the DOM.

Rules: write a test that fails before the fix; keep `tests/golden.test.ts` hashes identical unless you mean to change behaviour (then `UPDATE_GOLDEN=1` and say why); UI text is Chinese source text in `t()`/`tx()` (`src/i18n/index.ts`), then run `node scripts/i18n-extract.ts` and fill `src/i18n/en.ts`; no native `<select>` or number inputs; speed budgets use CPU time (`cpuMs()` in `tests/helpers.ts`); the design format only gains optional fields.

UI changes follow `docs/design-system.md`: glass only for things that float over other content, the spring curve only on `transform`, no decorative motion on data, grey edges and arrows, a faint category glow, and every animation off under `prefers-reduced-motion`.

Versions, the compare view, pasted designs, component presets and the custom service: see "新增其他東西" (`src/app/versions.ts`, `src/app/designDiff.ts`, `src/app/pasteDesign.ts`, `src/app/presets.ts`, `CUSTOM_KIND` in `src/schema/kinds.ts`). A practice judge must reject a custom service (`customUsed()` in `src/learn/constraints.ts`).

To add a component kind, follow "新增一種元件" above: `KINDS` in `src/schema/kinds.ts`, the kind sets in `src/schema/design.ts`, the `handle()` and `runJob()` switches in `src/engine/sim.ts`, `src/engine/scale.ts`, cost, complexity points, parameter groups, icon, card summary, English strings, tests and an example. Run `npm run test:quick` (about 10 s) after every change, the golden test after engine changes, and `npx playwright test` before you finish.
