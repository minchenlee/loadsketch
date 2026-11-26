# 找上限（網頁）

這份文件是給要改網頁版「找上限」程式的人看的，說明相關檔案位置與實作細節。

## 檔案位置

- 執行列按鈕：`src/app/components/RunBar.tsx`。
- 找上限面板：`src/app/components/FindLimit.tsx` 的 `FindLimitPanel`。面板開在畫布旁邊，不蓋住畫布；開著時右側面板先收起來（`src/app/App.tsx`）。
- Worker 與搜尋進入點：`src/worker/limit.worker.ts` 跑 `src/app/findLimit.ts` 的 `searchCanvas()`，包住 `src/engine/limit.ts` 的 `findLimitOf()`。
- 元件卡片上色：`src/app/components/ComponentNode.tsx` 的 `LimitRow`，讀取 store 的 `limit`（`LimitMark`）。
- 畫布頂端進度提示：`src/app/components/Canvas.tsx` 的 `LimitNote`。

## 檢查與搜尋規則

- 流量與達標條件：流量用目前情境的設定、不含事件；達標條件用 CLI 預設（`DEFAULT_SLO`）。
- 縮小比例：每一步回報它用的縮小比例 `k`，`k>1` 時列進假設。
- 開始前檢查：用 `limitProblems()` 檢查設計與情境（和執行一樣的 `parseDesign()`，加上情境不含事件的 `parseScenario()`），有問題就列出、不搜尋。
- 不提前拒絕設計：這是唯一在開始前拒絕設計的地方；樣本裡沒看到的事不能拿來拒絕。
- 搜尋一定跑完：每一步用 `reachesWork()` 看 `workNodes()`（從 `client` 沿著不是 `boot`／`control` 的線走得到的 `KINDS` `station` 元件）有沒有收到請求。
- 找不到上限的條件：整個搜尋沒有一步失敗、也沒有一步有工作（`noWork()`）時，才說找不到上限，不給數字也不列步驟。
- 測試上限：`MAX_RPS` 可以用 `findLimitOf()` 的 `maxRps` 改小（測試用）。

## 面板狀態與顯示

- 面板狀態管理：狀態在 `limitReply()`；取消或關閉以後收到的回覆不改狀態。
- 畫布更新與結束標記：每一步的使用率放進 store 的 `limit`（`LimitMark`），每一步至少顯示 `STEP_SHOW_MS`，結束時 `finalMark()` 標出最先倒的元件。
- 取消與清除：編輯設計、執行模擬會取消搜尋；編輯、執行、新的搜尋或「清除」會清掉標記。
- 結論文字：用 `limitLines()` 產生（速率寫成「/秒」，CLI 的報告不變）。
- 儲存與 worker 結束：結果不存成版本；取消或關閉就結束 worker。
