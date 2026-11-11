# 參考知名服務的概念範例

這份文件說明 9 個參考知名服務公開資料做的範例：8 個單一概念範例（`url-shortener`、`cdn-offload`、`flash-sale`、`hot-shard`、`cache-cold-restart`、`location-writes`、`upload-tasks`、`timeline-fanout`），和 Stripe 的 `saas-stripe`。每個範例只取公開資料裡的一個重點，縮小成模擬器能跑的大小。比較完整的架構放在範例瀏覽器的「真實服務架構」分類，說明在 [examples-architectures.md](examples-architectures.md)。

先講清楚兩件事：

- 這些設計**不是**那家公司的真實架構。它們只取公開資料裡的一個重點，其他都簡化了。
- 數字（rps、毫秒、台數）是為了讓 60 秒的模擬在筆電上幾秒內跑完而選的，不是真實規模。

每個範例都有一個同名的情境檔 `examples/scenarios/<名稱>.json`。執行方法：

```sh
node cli/loadsketch.ts run examples/designs/timeline-fanout.json --scenario examples/scenarios/timeline-fanout.json
```

下面的數字都是種子 1、60 秒、前 5 秒暖機的結果。不帶 `--scenario`（預設 100 rps）時，9 個設計都沒有錯誤，最忙的元件都在 6% 以下。

| 範例 | 學什麼 | 情境 | 關鍵結果 |
|---|---|---|---|
| [Bitly](#1-bitly-風格短網址轉址) | LRU 快取命中率決定 DB 負載 | 3,000 rps、讀 99%、Zipf 1.0 | 命中率 73%，DB 副本最忙 69% |
| [Netflix](#2-netflix-風格cdn-擋住新劇上線的流量) | CDN 命中率擋住突波 | 2,000 rps，突波 4 倍 | 來源只收到 250 rps，錯誤 0% |
| [Shopify](#3-shopify-風格限時搶購) | 限流保護後端 | 400 rps，突波 10 倍 | 429 拒絕 49,870 個，成功請求 p99 100 ms |
| [Stripe](#4-stripe-風格付款-api-的重試與保險絲) | 重試放大、保險絲 | 銀行 90% 失敗 20 秒 | 保險絲跳開 5 次，p50 120 ms |
| [Discord](#5-discord-風格熱門頻道造成熱分片) | 熱分片拖垮整體 | 3,500 rps、Zipf 1.2 | 一個分片 100%，平均 46%，錯誤 4.29% |
| [Instagram](#6-instagram-風格快取失效後的驚群) | 快取故障後的驚群 | memcache 停 5 秒 | Django 滿載排隊 1,384 個，p99 596 ms |
| [Uber](#7-uber-風格司機位置更新寫入量大分片) | 寫入量只能靠分片 | 寫 80%，爬升到 2.5 倍 | 分片 0 主庫滿載；加副本沒用，加分片有用 |
| [Dropbox](#8-dropbox-風格上傳非同步任務) | 同步路徑上的慢依賴 | 物件儲存慢 6 倍 20 秒 | 錯誤 28.21%（逾時 6,638） |
| [Twitter](#9-twitter-風格首頁時間軸的寫入擴散fan-out) | fan-out on write 的積壓 | 1,500 rps，突波 4 倍 | 讀取 p99 57.5 ms；擴散延遲 p99 9.6 秒 |

---

## 1. Bitly 風格：短網址轉址

檔案：`url-shortener.json`，情境「讀取 99%：20 萬個短網址，點擊很集中」。

### 真實服務做什麼

短網址服務把一個短碼對應到原網址。建立一次，之後被點很多次。下面的系統設計案例估計讀寫比約 1000:1，轉址要在 100 ms 內完成，熱門的短碼放在 Redis 或 Memcached，用 LRU 淘汰；沒命中再查資料庫並寫回快取。

這是常見的系統設計題，不是 Bitly 自己公開的架構。我沒找到 Bitly 官方的架構文章。

來源：

- Hello Interview, *Design a URL Shortener Like Bit.ly*：<https://www.hellointerview.com/learn/system-design/answer-keys/bitly>

### 對應到元件

| 真實系統 | 模型 |
|---|---|
| 轉址伺服器 | `api`（API Server，4 台 × 32） |
| Redis 短碼快取 | `cache`，`mode: lru`，`capacityKeys: 20000` |
| 網址資料庫 | `db`，1 個副本，讀取 5 ms |
| 熱門程度 | 情境 `keys: { count: 200000, zipf: 1.0 }` |

### 簡化了什麼

- 沒有 301／302 轉址的瀏覽器快取，也沒有點擊統計（真實系統會非同步送到 Kafka）。
- 快取一開始是冷的，60 秒內的命中率包含冷啟動的未命中。

### 情境顯示什麼

```
請求：送出 165,681，成功 165,681，失敗 0（錯誤率 0.00%）
成功請求的延遲（ms）：平均 46.3，p50 44.9，p95 55.3，p99 63.6
cache  3,820.45 rps  命中率 73%
db       837.35 rps  忙碌 27%  最忙 52%
瓶頸：目前沒有元件接近上限；最忙的是網址資料庫 副本 1（最忙時 69%）。
```

27% 的讀取沒命中，落到資料庫副本。資料庫還有餘裕。

### 試試看

- 把 `cache.capacityKeys` 改成 `2000`：命中率掉到 52%，DB 收到 1,457 rps，副本 1 平均忙碌 90%，p99 從 63.6 升到 94.6 ms。快取容量小一點，資料庫就要扛兩倍。
- 把情境的 `zipf` 改成 `0`（每個短碼一樣熱門）：看 LRU 命中率怎麼變。

---

## 2. Netflix 風格：CDN 擋住新劇上線的流量

檔案：`cdn-offload.json`，情境「新一季上線：第 20 秒起流量變 4 倍」。

### 真實服務做什麼

Netflix 的 Open Connect 是自己的 CDN。快取設備（OCA）放在網路交換中心，也免費放進 ISP 的機房裡。Netflix 能預測會員要看什麼，所以在離峰的 fill window 先把大部分內容推到 OCA 上。AWS 上的控制平面依檔案位置、健康狀態和距離，把用戶端導到最合適的 OCA。

來源：

- Netflix Open Connect：<https://openconnect.netflix.com/en/>
- *Open Connect Overview*（PDF）：<https://openconnect.netflix.com/Open-Connect-Overview.pdf>

### 對應到元件

| 真實系統 | 模型 |
|---|---|
| OCA（ISP 內的快取設備） | `cdn`，`hitRatio: 0.95` |
| 回到 AWS 的來源 | `lb` → `origin`（2 台 × 32，排隊上限 200） |
| 影片檔存放處 | `s3`（Object Storage，GET 40 ms） |

### 簡化了什麼

- 模型的 CDN 容量無限，也沒有頻寬。真實的 OCA 有網卡和磁碟的上限。
- 沒有「事先推送」：模型的 CDN 只用固定命中率。
- 一個請求代表一次取檔，不是一段影片串流。

### 情境顯示什麼

```
請求：送出 230,678，成功 230,678，失敗 0（錯誤率 0.00%）
成功請求的延遲（ms）：平均 51.9，p50 44.9，p95 134，p99 186
cdn     4,194.31 rps  命中率 95%
origin    250.31 rps  忙碌 21%
瓶頸：目前沒有元件接近上限；最忙的是來源服務（最忙時 47%）。
```

使用者送了 4,194 rps，來源只收到 250 rps。突波幾乎全被 CDN 吃掉。

### 試試看

- 把 `cdn.hitRatio` 改成 `0.8`：來源收到 870 rps，排隊 142 個，8,236 個請求被拒（錯誤率 3.57%），p99 從 186 升到 519 ms。命中率只差 15 個百分點，來源的流量變成 3.5 倍。
- 保持 `0.8`，把 `origin.instances` 加到 `4`：看要加多少台才補得回 CDN 少擋的流量。

---

## 3. Shopify 風格：限時搶購

檔案：`flash-sale.json`，情境「開賣：第 15 秒起流量變 10 倍，持續 20 秒」。

### 真實服務做什麼

Kylie Cosmetics 這類商家開賣時，結帳流量幾乎每週都會暴增。2016 年 2 月的一次開賣讓她的商店和同一個資料庫分片上的其他商店一起掛掉。原因是每個結帳步驟都在改同一筆 MySQL 紀錄。Shopify 先在 Nginx/OpenResty 邊緣層加了漏桶節流：每 5 秒放行固定數量，多的人看到排隊頁，頁面會自己再試。通過的人拿到簽名 cookie，之後不再被擋。

來源：

- Shopify Engineering, *Surviving Flashes of High-Write Traffic Using Scriptable Load Balancers (Part I)*：<https://shopify.engineering/surviving-flashes-of-high-write-traffic-using-scriptable-load-balancers-part-i>

### 對應到元件

| 真實系統 | 模型 |
|---|---|
| 邊緣層的漏桶節流 | `limiter`（Rate Limiter，1,500 req/s，突發 300） |
| 結帳服務 | `checkout`（4 台 × 16） |
| 商店資料庫（MySQL） | `db`，寫入 12 ms，16 條連線 |

### 簡化了什麼

- 模型的限流器回 429。Shopify 回的是排隊頁，使用者會自動再試；模型沒有「被拒後再來」。
- 沒有「通過一次就不再被擋」的 cookie，每個請求各自計算。
- 限流是全站一個桶，不是每家商店一個桶。

### 情境顯示什麼

```
請求：送出 94,181，成功 44,311，失敗 49,870（錯誤率 52.95%）
  失敗原因：被限流（429） 49,870
成功請求的延遲（ms）：平均 57.9，p50 54.8，p95 81.5，p99 100
checkout  805.62 rps  忙碌 20%
db        805.67 rps  忙碌 20%  最忙 24%
瓶頸：目前沒有元件接近上限。
```

一半的請求被擋在門口。但被放行的人，結帳延遲和平常一樣（p99 100 ms），資料庫沒有被壓垮。

### 試試看

- 把 `limiter.ratePerSec` 和 `burst` 都改成 `100000`（等於拿掉限流）：結帳服務排隊 280 個，12,681 個請求排隊滿被拒，成功請求的 p99 從 100 升到 363 ms。失敗少了，但每個人都變慢，而且被拒的是排在後面、已經等很久的人。
- 把 `ratePerSec` 調到資料庫主庫剛好撐得住的值，找出「拒絕最少、延遲還正常」的點。

---

## 4. Stripe 風格：付款 API 的重試與保險絲

檔案：`saas-stripe.json`，情境「銀行第 20 秒起 90% 請求失敗，持續 20 秒」。

### 真實服務做什麼

Stripe 公開了四種限流和降載：每個使用者每秒請求數的限流（token bucket，用 Redis 實作）、同時進行中請求數的限制、保留容量給重要請求的降載，以及事故時的最後防線。另一篇文章說明 idempotency key：用戶端每個操作帶一個唯一 ID，重試時伺服器只做一次，所以網路斷線不會重複扣款；重試要用指數退避加隨機抖動（jitter），避免大家同時重試。

來源：

- Stripe, *Scaling your API with rate limiters*：<https://stripe.com/blog/rate-limiters>
- Stripe, *Designing robust and predictable APIs with idempotency*：<https://stripe.com/blog/idempotency>

### 對應到元件

| 真實系統 | 模型 |
|---|---|
| 請求限流 | `limiter`（800 req/s） |
| 付款 API | `api`（3 台 × 32） |
| idempotency key 紀錄 | `idem`（Database，每筆請求都寫或讀） |
| 呼叫銀行 | `cb`（保險絲）→ `bank`，逾時 500 ms，重試 2 次，退避 100 ms（full jitter） |

### 簡化了什麼

- 模型不檢查 idempotency key 是否重複；`idem` 只代表「每筆都要多一次資料庫存取」的成本。
- 限流是全站一個桶，不是每個使用者一個；沒有並行數限制，也沒有依重要程度降載。
- 銀行是一個 API Server，錯誤是隨機的。

### 情境顯示什麼

```
請求：送出 27,568，成功 20,486，失敗 7,082（錯誤率 25.69%）
  失敗原因：元件錯誤 669，保險絲跳開 6,413
成功請求的延遲（ms）：平均 138，p50 120，p95 246，p99 1011
cb    352.8 rps  保險絲跳開 6,413
bank 264.36 rps  元件錯誤 2,216
事件：23.6 秒保險絲跳開，之後每 3 秒試探一次，又跳開；40.2 秒恢復。
```

銀行一壞，保險絲在 3.6 秒後跳開。之後的付款請求立刻失敗（`circuit_open`），不再佔住付款 API 的執行緒。

### 試試看

- 拿掉保險絲（`api` 直接接 `bank`，保留逾時和重試）：銀行收到 464 rps（寫入只有約 350 rps，多的是重試），錯誤率 33.28%，出現 5,700 個逾時，p99 升到 2,706 ms，API Gateway 滿載。重試把壞掉的下游打得更兇。
- 把 `cb → bank` 的 `retries` 改成 `0`：銀行收到 232 rps（有重試時是 264），p99 從 1,011 降到 261 ms。下游壞掉時，重試只是多等。

---

## 5. Discord 風格：熱門頻道造成熱分片

檔案：`hot-shard.json`，情境「大型伺服器發公告：少數頻道非常熱」。

### 真實服務做什麼

Discord 的訊息依頻道和時間區段分割。一個大伺服器很熱時，同一個分割區被大量讀取，所在的節點變慢，連帶拖慢同節點上的其他查詢（hot partition）。他們從 177 台 Cassandra 換到 72 台 ScyllaDB，並在 API 和資料庫之間加了 Rust 寫的 data service：同一列的同時請求只查一次資料庫（request coalescing），並用一致性雜湊把同一個頻道的請求送到同一台 data service。

來源：

- Discord, *How Discord Stores Trillions of Messages*：<https://discord.com/blog/how-discord-stores-trillions-of-messages>

### 對應到元件

| 真實系統 | 模型 |
|---|---|
| API | `api`（4 台 × 32） |
| Rust data service | `data`（4 台 × 32，只轉送） |
| 訊息資料庫（依頻道分割） | `messages`（Sharded DB，8 個分片，每片 4 條連線） |
| 熱門頻道 | 情境 `keys: { count: 50000, zipf: 1.2 }` |

### 簡化了什麼

- `data` 沒有 request coalescing，也沒有依頻道路由，只是多一跳。模擬器沒有這個功能（見文末「缺的元件」）。
- 分割只看 key，沒有時間區段。

### 情境顯示什麼

```
請求：送出 193,154，成功 184,871，失敗 8,283（錯誤率 4.29%）
  失敗原因：排隊滿了被拒 8,283
成功請求的延遲（ms）：平均 622，p50 639，p95 772，p99 828
api       3,512.18 rps  忙碌 100%  排隊 1,811
messages  3,338.27 rps  平均忙碌 46%  最忙 100%
瓶頸：API（4 台都很忙）幾乎一直滿載……下游最忙的是訊息資料庫（分片）（最忙時 100%）。
```

8 個分片平均只忙 46%，但熱的那一片 100%。它變慢，API 的執行緒全卡在等它，所有人都變慢，連查冷頻道的人也一樣。

### 試試看

- 把 `messages.shards` 改成 `16`：錯誤變成 0，p99 降到 84 ms，但熱分片仍然平均忙碌 90%。加分片只是把「其他 key」分得更散，最熱的 key 還是只在一片上。
- 把情境的 `zipf` 改成 `0`：同樣 3,500 rps，看 8 個分片是否都很輕鬆。

---

## 6. Instagram 風格：快取失效後的驚群

檔案：`cache-cold-restart.json`，情境「memcache 第 25 秒停 5 秒，恢復時是冷的」。

### 真實服務做什麼

Instagram 2016 年的 QCon 投影片：使用者、貼文、好友關係放在 PostgreSQL，一個主庫，每個區域有副本；讀取在本地，寫入跨區到主庫。前面用 memcache，每秒數百萬次讀寫。快取被清掉時，所有 Django 伺服器同時去查資料庫（投影片寫 "Cache invalidated → All djangos try to access DB"）。他們用 memcache lease 解決：只讓一個請求去資料庫補值，其他人等或先用舊值。

來源：

- Lisa Guo, *Scaling Instagram Infrastructure*（QCon SF 2016 投影片）：<https://qconsf.com/sf2016/system/files/presentation-slides/scaling_instagram_infrastructure_-_qcon_sf_2016.pdf>

### 對應到元件

| 真實系統 | 模型 |
|---|---|
| Django | `django`（6 台 × 32） |
| memcache | `memcache`，`mode: lru`，3 台，容量 30,000 個 key |
| PostgreSQL 主庫＋副本 | `pg`，2 個副本，每台 8 條連線，讀取 6 ms |

### 簡化了什麼

- 用「快取停 5 秒」代表「快取被清空」。模型裡快取故障時，服務直接讀資料庫；恢復時快取是空的。
- 沒有 lease、沒有 stale 讀取（見「缺的元件」）。
- 只有一個區域。

### 情境顯示什麼

```
請求：送出 165,681，成功 165,681，失敗 0（錯誤率 0.00%）
成功請求的延遲（ms）：平均 87.7，p50 49.6，p95 417，p99 596
memcache  命中率 64%  元件故障 26,212
pg        1,341.73 rps
瓶頸：Django 在第 27 秒前後滿載（那一秒忙碌 100%，排隊 1,384 個）……下游最忙的是 PostgreSQL（最忙時 100%）。
```

平常 p50 約 50 ms。快取一停，資料庫副本忙到 100%，Django 的執行緒全在等資料庫，p99 升到 596 ms。沒有請求失敗，但整段變慢。

### 試試看

- 把 `pg.replicas` 改成 `4`：p99 降到 77.6 ms，副本最忙 65%。用更多副本也能扛過驚群，代價是平常閒置的機器。
- 把 `memcache.capacityKeys` 改成 `60000`：結果完全一樣。60 秒內讀過的 key 不到 3 萬個，所以容量不是限制；未命中多半是「第一次讀」（冷快取）。這正是驚群的來源。

---

## 7. Uber 風格：司機位置更新（寫入量大、分片）

檔案：`location-writes.json`，情境「尖峰時段：第 10 秒起 30 秒內流量爬到 2.5 倍」。

### 真實服務做什麼

Uber 的司機 App 一直回報位置。地理服務把這些短期資料放在 worker 的記憶體，不放資料庫。Ringpop 用一致性雜湊把 key 分到各台機器：收到請求的節點算出 key 屬於誰，再轉過去；用 SWIM gossip 協定偵測成員加入和故障。

來源：

- Uber Engineering, *Ringpop: Open Source Node.js Library*：<https://www.uber.com/blog/ringpop-open-source-nodejs-library/>

### 對應到元件

| 真實系統 | 模型 |
|---|---|
| 司機 App | `drivers`，讀取只有 20% |
| 位置服務 | `loc`（4 台 × 32） |
| 依 key 分散的位置資料 | `geo`（Sharded DB，4 個分片，每片 1 個副本，4 條連線，寫入 5 ms） |
| 司機分布 | 情境 `zipf: 0`（每個司機一樣頻繁） |

### 簡化了什麼

- Uber 把位置放在服務的記憶體裡；模擬器沒有「有狀態、依 key 路由的服務」，所以用分片資料庫代替。
- 沒有地理查詢（找附近司機），讀取只是一般的 key 查詢。
- 沒有節點加入或離開時的重新分配。

### 情境顯示什麼

```
請求：送出 161,779，成功 161,779，失敗 0（錯誤率 0.00%）
成功請求的延遲（ms）：平均 56.0，p50 51.6，p95 84.8，p99 109
geo  2,940.73 rps  忙碌 53%  最忙 74%  排隊 20.5
瓶頸：位置資料（分片） 分片 0 主庫在第 43 秒前後滿載（那一秒忙碌 100%，排隊 85 個）。
```

流量爬到 2.5 倍時，寫入都打在分片主庫上，主庫先滿。副本只分到讀取，幫不上忙。

### 試試看

- 把 `geo.replicas` 改成 `3`：主庫一樣在第 45 秒滿載，p99 還略升到 114 ms（每個副本也要套用寫入）。讀副本救不了寫入。
- 把 `geo.shards` 改成 `8`：最忙的分片只到 56%，p99 降到 66.8 ms。寫入量只能靠分片分攤。

---

## 8. Dropbox 風格：上傳＋非同步任務

檔案：`upload-tasks.json`，情境「物件儲存第 20 秒起慢 6 倍，持續 20 秒」。

### 真實服務做什麼

Dropbox 的 ATF（Async Task Framework）讓各團隊排程背景任務。Frontend 用 RPC 收請求，寫進任務儲存（Edgestore）；Store Consumer 約每 2 秒撈出到期的任務，放進 SQS；每台機器的 Controller 拉任務交給 Executor 執行。保證至少執行一次（at-least-once），設計目標每秒 1 萬個任務，文章寫作時每秒約 9,000 個。

來源：

- Dropbox Tech, *How we designed Dropbox ATF: an async task framework*：<https://dropbox.tech/infrastructure/asynchronous-task-scheduling-at-dropbox>

### 對應到元件

| 真實系統 | 模型 |
|---|---|
| 上傳 API（同步寫檔案區塊） | `api` → `blob`（Object Storage，PUT 60 ms，逾時 2 秒） |
| SQS | `tasks`（Queue） |
| Executor | `exec`（Worker，4 台 × 8，50 ms） |
| 中繼資料 | `meta`（Database，1 個副本） |

### 簡化了什麼

- 沒有 Store Consumer 的 2 秒輪詢、沒有優先順序、沒有任務排程時間。
- 模型的 worker 故障時，訊息算失敗，不會重送；真實的 ATF 是 at-least-once。
- 讀取（列出檔案）也走同一個上傳 API，所以會被寫入拖慢。

### 情境顯示什麼

```
請求：送出 33,094，成功 23,757，失敗 9,337（錯誤率 28.21%）
  失敗原因：逾時 6,638，排隊滿了被拒 2,699
成功請求的延遲（ms）：平均 320，p50 80.7，p95 2048，p99 2816
非同步工作（進佇列到處理完）：15,069 件，p50 59.3 ms，p99 1309 ms
瓶頸：API Gateway 在第 23 秒前後滿載……下游最忙的是上傳 API（最忙時 100%）。
```

物件儲存本身不忙（2%），只是慢。上傳 API 的執行緒都卡在等 PUT，連讀取也排不到，使用者端逾時 6,638 次。

### 試試看

- 把 PUT 移到非同步路徑（把 `api → blob` 這條線改成 `exec → blob`）：前台錯誤變成 0，p99 69.5 ms。但 executor 變成 100% 忙碌，佇列結束時還有 5,194 則，非同步延遲 p99 升到 20 秒。慢的依賴沒有消失，只是從「使用者等」變成「任務晚做」。
- 再把 `exec.instances` 加到 `8`，看佇列能不能在突發結束後消化完。

---

## 9. Twitter 風格：首頁時間軸的寫入擴散（fan-out）

檔案：`timeline-fanout.json`，情境「大事件：第 20 秒起流量變 4 倍，持續 15 秒」。

### 真實服務做什麼

2013 年的資料：每天約 4 億則推文，平均每秒 5K 則，大事件時超過 12K；時間軸讀取每秒約 30 萬次，所以是讀多寫少的系統。Twitter 在發文時就把推文 ID 塞進每個追蹤者的時間軸（存在 Redis 叢集，每人最多約 800 筆，複製 3 份），讀取只要查一次。代價是寫入擴散：送到 100 萬個追蹤者，中位數 3.5 秒，p99 可能到 5 分鐘；名人帳號會讓佇列積壓，甚至回覆比原文先出現，所以他們改成名人推文在讀取時才合併。

來源：

- High Scalability, *The Architecture Twitter Uses To Deal With 150M Active Users*：<https://highscalability.com/the-architecture-twitter-uses-to-deal-with-150m-active-users/>
- Raffi Krikorian, *Timelines at Scale*（QCon SF 2012，InfoQ）：<https://www.infoq.com/presentations/Twitter-Timeline-Scalability/>

### 對應到元件

| 真實系統 | 模型 |
|---|---|
| 時間軸 API | `api`（6 台 × 32），讀取走快取，寫入丟佇列 |
| Redis 時間軸 | `tlcache`（命中率 97%），沒命中讀 `timelines` |
| fan-out 佇列和服務 | `fanout`（Queue）→ `fanworker`（4 台 × 4，40 ms） |
| 時間軸儲存 | `timelines`（Sharded DB，8 個分片） |

### 簡化了什麼

- 模型沒有「一則推文寫 N 次」的放大。用 worker 的 40 ms 處理時間代表「一則推文要寫到很多人的時間軸」。
- 沒有名人和一般帳號的混合策略。
- 發文和讀時間軸一起變 4 倍；真實的大事件主要是發文暴增。

### 情境顯示什麼

```
請求：送出 150,475，成功 150,475，失敗 0（錯誤率 0.00%）
成功請求的延遲（ms）：平均 45.9，p50 44.9，p95 52.1，p99 57.5
非同步工作（進佇列到處理完）：14,924 件，p50 3368 ms，p99 9576 ms
fanout     平均積壓 1,001 則
fanworker  271.35 rps  忙碌 75%
瓶頸：擴散 worker（4 台都很忙）在第 22 秒前後滿載。
```

讀時間軸的人完全沒感覺（p99 57.5 ms）。但發文後，追蹤者要等中位數 3.4 秒、p99 9.6 秒才看得到。

### 試試看

- 把 `fanworker.instances` 改成 `8`：非同步延遲 p99 從 9,576 降到 186 ms，worker 最忙 92%。
- 把 `fanworker.serviceMs` 改成 `200`（模擬名人：一則推文要寫給更多人）：看佇列在突波結束後要多久才消化完。

---

## 缺的元件

下面這些課題，模擬器目前沒有對應的元件或參數，所以沒有做進範例，或只做了近似：

| 課題 | 出現在 | 缺什麼 |
|---|---|---|
| Request coalescing | Discord | 同一個 key 同時多個請求時，只往下游送一次。 |
| 依 key 路由到服務實例 | Discord、Uber（Ringpop） | Load Balancer 的一致性雜湊策略，以及「有狀態、依 key 分配的服務」。 |
| Memcache lease／stale-while-revalidate | Instagram | 快取沒命中時只讓一個請求去補值，其他人等待或讀舊值。 |
| 每個使用者一個限流桶、並行數限制、依重要程度降載 | Stripe | Rate Limiter 只有全站一個桶；沒有 concurrency limiter 和 load shedder。 |
| Idempotency（去重） | Stripe | 重試時判斷「已經做過」並回傳上次的結果。 |
| 被拒後自動再來／排隊頁 | Shopify | 用戶端的重試行為（被 429 後過一陣子再送），以及等候室的先來先服務。 |
| Fan-out 倍數 | Twitter | 一則訊息在 worker 產生 N 次下游寫入。 |
| CDN 容量和預先推送 | Netflix | CDN 的頻寬上限，以及命中率隨時間變化（例如情境事件改命中率）。 |
| At-least-once 重送 | Dropbox | Worker 失敗時把訊息放回佇列。 |
| 地理查詢 | Uber | 「找附近的 key」這種跨分片的範圍查詢。 |
