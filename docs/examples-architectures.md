# 真實服務架構：Instagram、Uber、Netflix

這份文件說明範例瀏覽器「真實服務架構」分類裡的 3 個範例。它們和[概念範例](examples-saas.md)不同：概念範例只取一個重點，這 3 個把整套架構畫出來（14–17 個元件），再用一個情境看故障怎麼在元件之間擴散。

| 範例 | 年份 | 元件 | 情境 | 情境結果 | 改了什麼之後 |
|---|---|---|---|---|---|
| [`saas-instagram`](#instagram-2011) | 2011 | 16 | 部署時重啟 3 台 Memcached，回來是冷的 | 錯誤 7.30%，p99 853 ms | PostgreSQL 連線 2：錯誤 0% |
| [`saas-uber`](#uber-2015) | 2015 | 14 | 流量爬到 3 倍，一台地理索引副本變慢 5 倍 | 失敗 3,403 個（0.79%） | 最大可接受延遲 500 ms：失敗約 50 個 |
| [`saas-netflix`](#netflix-2016) | 2016 | 17 | Chaos Kong：關掉 us-east 60 秒 | 錯誤 9.15%，瀏覽 API 失敗 27.5% | 降級回應＋TTL 5 秒＋推薦 4 台：錯誤 1.9% |

先講清楚兩件事：

- 元件和連線照公開資料畫，但台數、rps、毫秒是縮小值，讓模擬在筆電上幾秒內跑完。
- 每個範例的「簡化」便利貼寫了哪些部分沒有模擬。

執行方法：

```sh
node cli/loadsketch.ts run examples/designs/saas-netflix.json --scenario examples/scenarios/saas-netflix.json
```

下面的數字都是種子 1。在 app 裡，「試試看」便利貼有同樣的步驟。

---

## Instagram 2011

檔案：`saas-instagram.json`，情境「部署時第 30 秒重啟 3 台 Memcached，回來是冷的」（3,000 rps，90 秒）。App 的請求依 API 分：feed 81%、地理搜尋 9%、上傳 10%；「載入照片」的使用者只走 CloudFront。

### 架構

App → Route53 → Amazon ELB（終結 SSL）→ NGINX → 一組 Django。Django 依 API 呼叫不同的下游：feed 查 Memcached、PostgreSQL、Redis；地理搜尋查 Solr；上傳寫 PostgreSQL、S3，再丟進 Gearman。資料在 12 個分片的 PostgreSQL，前面是 6 台 Memcached；Redis 存 feed 和 session；地理搜尋用 Solr；照片在 S3＋CloudFront；分享和 fan-out 丟進 Gearman，由 Python worker 處理。

來源：

- Instagram Engineering, *What Powers Instagram: Hundreds of Instances, Dozens of Technologies*：<https://instagram-engineering.com/what-powers-instagram-hundreds-of-instances-dozens-of-technologies-adf2e22da2ad>
- Instagram Engineering, *Sharding & IDs at Instagram*：<https://instagram-engineering.com/sharding-ids-at-instagram-1cf5a71e5a5c>
- Nishtala et al., *Scaling Memcache at Facebook*（NSDI 2013，lease）：<https://www.usenix.org/conference/nsdi13/technical-sessions/presentation/nishtala>

### 情境顯示什麼

不帶事件時沒有錯誤，命中率約 81%。第 30 秒一半的 Memcached 回來是空的：整段命中率掉到 66%，沒命中的讀取打到 PostgreSQL，分片滿載。Django 的執行緒都在等資料庫。錯誤率 7.30%，p99 853 ms。每個 API 分開看：feed 和上傳各失敗約 13%（上傳失敗 1,692 次），因為它們共用資料庫；地理搜尋走 Solr，沒有失敗，但 p99 也到約 0.9 秒，因為它和 feed 共用同一組 Django 執行緒。載入照片走 CloudFront，沒有受影響。

### 試試看

1. 把 PostgreSQL 的「連線數」改成 2（像加大 pgbouncer 連線池）：錯誤歸零。
2. 改回 1，把 Memcached 的防擊穿改成 lease：沒有解決。錯誤降到約 3.9%，但 p99 拉長到約 1.8 秒。lease 解決「很多請求同時查同一個 key」；這裡是一半的快取都空了，各查各的 key，等 lease 的請求只是多佔住執行緒。

---

## Uber 2015

檔案：`saas-uber.json`，情境「跨年夜：流量爬到 3 倍，第 60 秒一台地理索引副本變慢 5 倍」（2,000 rps，90 秒，讀取 30%）。

### 架構

司機和乘客 App → API 閘道。位置更新寫進依 S2 cell 分片的地理索引（8 個分片，各 2 個副本）。叫車時 DISCO 讀地理索引找附近的車，再問路線／ETA，透過 Supply 派單、Demand 記錄需求，狀態存 Riak。行程結束後的工作進佇列，由 post-trip worker 處理評分、email、付款。

來源：

- High Scalability, *How Uber Scales Their Real-Time Market Platform*（Matt Ranney，QCon London 2015）：<https://highscalability.com/how-uber-scales-their-real-time-market-platform/>
- InfoQ 演講影片：<https://www.infoq.com/presentations/uber-market-platform/>
- Uber Engineering, *Ringpop*：<https://www.uber.com/blog/ringpop-open-source-nodejs-library/>

### 情境顯示什麼

流量到 3 倍時最忙的分片到約 92%。第 60 秒分片 0 的一台副本變慢 5 倍：它要回答讀取，也要套用所有複製過來的寫入，很快就跟不上。讀到它的請求逾時或被拒，失敗 3,403 個（0.79%）。

### 試試看

1. 刪掉第 60 秒的事件，把分片數改成 16：最忙的分片降到約 50%。寫入量只能靠加分片分攤。
2. 改回 8 個分片、副本改成 4：最忙的還是約 91%。加副本只分攤讀取。
3. 放回事件，把地理索引的「最大可接受延遲」設成 500 ms：DISCO 跳過落後的副本，失敗降到約 50 個。

---

## Netflix 2016

檔案：`saas-netflix.json`，情境「Chaos Kong：第 30 秒關掉 us-east 60 秒」（3,000 rps，120 秒，讀取 90%）。

### 架構

影片串流（三分之二的流量）走 Open Connect，ISP 機房裡的快取沒命中才回 S3 母檔。瀏覽和播放前的 API 經 DNS 分到 us-east 或 us-west。每個區域有 Zuul → API 服務 → EVCache／Cassandra，推薦服務用 Hystrix 包起來。DNS 開了 failover：10 秒偵測，TTL 60 秒。

來源：

- Netflix Tech Blog, *Caching for a Global Netflix*：<https://netflixtechblog.com/caching-for-a-global-netflix-7bcc457012f1>
- Zuul wiki：<https://github.com/Netflix/zuul/wiki>
- Hystrix wiki：<https://github.com/Netflix/Hystrix/wiki>
- Open Connect：<https://openconnect.netflix.com/>

### 情境顯示什麼

不帶事件時錯誤率 0.02%。關掉 us-east 後，影片串流沒有失敗；瀏覽 API 失敗 27.5%，整段錯誤率 9.15%。失敗分三種：

- 打到死區（18,160）：DNS 偵測要 10 秒，之後裝置的 DNS 快取還會送到 us-east，直到 TTL 過期。
- 逾時（7,511）和保險絲跳開（4,577）：全部流量擠到 us-west，推薦服務滿載，超過 Hystrix 的 300 ms。

### 試試看

照順序改，每一步都保留前一步：

| 步驟 | 錯誤率 | p99 | 說明 |
|---|---|---|---|
| 原始情境 | 9.15% | 961 ms | |
| 1. 兩條 API→Hystrix 連線打開「降級回應」 | 5.49% | 1,197 ms | 推薦失敗回預設清單，約 12,000 個降級回應 |
| 2. DNS TTL 改成 5 秒 | 2.81% | 2,761 ms | 打到死區降到 6,194；流量更快搬到 us-west，排隊變長 |
| 3. 兩區推薦服務改成 4 台 | 1.87% | 202 ms | 每區有能吃下全部流量的容量；剩下的是偵測那 10 秒 |

只改 TTL、不開降級回應，錯誤率是 9.95%，反而更糟：流量更快到 us-west，推薦服務更早滿載。

### 簡化了什麼

- 只畫兩個區域（Netflix 是三個）。
- EVCache 和 Cassandra 的跨區複製沒有模擬。切區時快取變冷造成的驚群模擬不了，這正是原文做跨區複製的原因。
- 真實的切區是 Zuul 和 DNS 一起慢慢搬流量，這裡只有 DNS failover。
