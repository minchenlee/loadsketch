// Component catalog: one entry per node kind. The engine, the JSON Schema, the canvas palette and
// the inspector all read this table, so a kind's parameters are defined in exactly one place.

export type Category = 'traffic' | 'edge' | 'compute' | 'resilience' | 'data' | 'messaging';

/** Show a parameter only when another enum parameter has this value, or one of these values (the inspector hides it otherwise). */
export interface ParamWhen {
  param: string;
  value: string | string[];
}

/** Does `when` hold for this value of its enum parameter? */
export const whenHolds = (w: ParamWhen, v: unknown): boolean => (Array.isArray(w.value) ? w.value.includes(v as string) : v === w.value);

export type ParamSpec = (
  | { type: 'int'; default: number; min: number; max: number; unit?: string; label: string; help: string }
  | { type: 'number'; default: number; min: number; max: number; unit?: string; label: string; help: string }
  | { type: 'ratio'; default: number; label: string; help: string }
  | { type: 'dist'; default: { mean: number; cv: number }; max: number; label: string; help: string }
  | { type: 'enum'; default: string; options: { value: string; label: string }[]; label: string; help: string }
) & { when?: ParamWhen };

export interface KindSpec {
  kind: string;
  label: string;
  labelEn: string;
  category: Category;
  icon: string; // lucide-react icon name
  /** Has instances with slots and a FIFO queue (requests can wait here). */
  station: boolean;
  /** How it routes: 'one' forwards each request to one downstream edge; 'plan' calls downstreams itself. */
  routing: 'one' | 'plan' | 'leaf' | 'queue';
  summary: string;
  params: Record<string, ParamSpec>;
}

const instances = (d: number): ParamSpec => ({
  type: 'int', default: d, min: 1, max: 1000, label: '實例數', help: '同時跑幾台。流量平均分給每一台。',
});
const concurrency = (d: number, what = '同時處理幾個請求'): ParamSpec => ({
  type: 'int', default: d, min: 1, max: 100000, label: '每台同時處理數', help: `每台${what}（執行緒、連線或 worker 數）。滿了就排隊。`,
});
const queueLimit = (d: number): ParamSpec => ({
  type: 'int', default: d, min: 0, max: 10000000, label: '排隊上限', help: '每台最多排幾個請求。滿了就直接拒絕（queue_full）。0 表示不排隊。',
});
const AUTO: ParamWhen = { param: 'autoscale', value: 'on' };
const LRU: ParamWhen = { param: 'mode', value: 'lru' };
const PROBE: ParamWhen = { param: 'healthCheck', value: ['liveness', 'deep'] };
const OUTLIER: ParamWhen = { param: 'outlier', value: 'on' };
const DNS_FAILOVER: ParamWhen = { param: 'failover', value: 'on' };
/** Queue order and CoDel for request queues of front-end servers (Facebook, "Fail at Scale"). */
const queueing = (): Record<string, ParamSpec> => ({
  queueOrder: {
    type: 'enum', default: 'fifo', label: '排隊順序',
    options: [
      { value: 'fifo', label: '先來先做（FIFO）' },
      { value: 'lifo', label: '後來先做（LIFO）' },
      { value: 'adaptive_lifo', label: '塞車時改成後來先做（adaptive LIFO）' },
    ],
    help: '從排隊中先拿哪個請求。過載時，排最久的請求，呼叫端多半已經放棄了；先做最新的請求，做完的才有人收。adaptive LIFO：平常 FIFO，排隊超過 100 ms 都沒清空時改成 LIFO。',
  },
  codelTargetMs: {
    type: 'number', default: 0, min: 0, max: 60000, unit: 'ms', label: 'CoDel 排隊目標',
    help: '控制排隊延遲（CoDel，Facebook 的做法）。排隊在最近 100 ms 內清空過：一個請求最多排 100 ms；一直沒清空（塞車）：最多排這麼久。超過的請求輪到時直接丟掉（CoDel），不做白工。Facebook 用 5 ms。0 表示不用。',
  },
});
/** Autoscaling (like a Kubernetes HPA): "instances" becomes the minimum. */
const autoscale = (max: number): Record<string, ParamSpec> => ({
  autoscale: {
    type: 'enum', default: 'off', label: '自動擴充',
    options: [
      { value: 'off', label: '關（固定台數）' },
      { value: 'on', label: '開（依忙碌率加減台數）' },
    ],
    help: '開啟後，「實例數」是最少台數。每隔一段時間看平均忙碌率：太忙就加機器，太閒就減機器。新機器要等開機時間才接請求，剛上線時比較慢（冷啟動）。',
  },
  maxInstances: { type: 'int', default: max, min: 1, max: 1000, label: '最多台數', help: '自動擴充的上限。', when: AUTO },
  targetUtil: {
    type: 'ratio', default: 0.6, label: '目標忙碌率', when: AUTO,
    help: '希望每台平均多忙。需要的台數 = 現有台數 × 忙碌率 ÷ 目標（差不到 10% 就不動）。',
  },
  scaleEveryS: { type: 'number', default: 60, min: 1, max: 3600, unit: 's', label: '偵測間隔', help: '多久看一次忙碌率並決定加減。用 1 分鐘指標的雲端擴充約 1 分鐘一次；Kubernetes HPA 是 15 秒。', when: AUTO },
  scaleDownS: {
    type: 'number', default: 300, min: 0, max: 3600, unit: 's', label: '縮減穩定窗', when: AUTO,
    help: '要減機器，得這段時間內每次檢查都不需要那麼多台；減的時候一次減到這段時間內需要的最多台數。像 Kubernetes HPA 的縮減穩定窗（預設 300 秒），避免流量一抖就減、又馬上加回來。0 表示一不需要就減。',
  },
  bootS: {
    type: 'number', default: 120, min: 0, max: 3600, unit: 's', label: '開機時間', when: AUTO,
    help: '決定加機器後，要多久才開始接請求（開 VM、拉 image、通過 health check）。新 VM 約 1–3 分鐘；容器在已有的節點上只要數秒。',
  },
  warmS: {
    type: 'number', default: 20, min: 0, max: 3600, unit: 's', label: '暖機時間', when: AUTO,
    help: '新機器上線後，處理時間從「冷啟動倍數」線性降回正常要多久（JIT、連線池、本機快取）。0 表示不暖機。',
  },
  coldFactor: { type: 'number', default: 3, min: 1, max: 100, label: '冷啟動倍數', help: '新機器剛上線時，處理時間是平常的幾倍。', when: AUTO },
});
const errorRate: ParamSpec = { type: 'ratio', default: 0, label: '錯誤率', help: '處理完後隨機失敗的比例。' };
const dist = (mean: number, cv: number, label: string, help: string, max = 600000): ParamSpec => ({
  type: 'dist', default: { mean, cv }, max, label, help,
});

const dbParams = (): Record<string, ParamSpec> => ({
  replicas: { type: 'int', default: 0, min: 0, max: 15, label: '讀副本數', help: '主庫之外的唯讀副本。讀取可以分給副本，寫入只到主庫。' },
  connections: concurrency(50, '同時處理幾個查詢'),
  readMs: dist(3, 1, '讀取時間', '一次讀取查詢的處理時間。'),
  writeMs: dist(10, 1, '寫入時間', '一次寫入的處理時間。'),
  queueLimit: queueLimit(500),
  errorRate,
  readFrom: {
    type: 'enum', default: 'replicas', label: '讀取來源',
    options: [
      { value: 'replicas', label: '只讀副本（沒有副本就讀主庫）' },
      { value: 'primary', label: '只讀主庫' },
      { value: 'any', label: '主庫和副本輪流' },
    ],
    help: '讀取查詢送到哪裡。',
  },
  replicaApplyRatio: {
    type: 'ratio', default: 0.3, label: '副本套用寫入成本',
    help: '主庫每寫一次，每個副本也要花「寫入時間 × 這個比例」套用它。所以副本救不了寫入量。0 表示不計（也不計算讀到舊資料）。',
  },
  replicaDelayMs: {
    type: 'number', default: 0, min: 0, max: 600000, unit: 'ms', label: '複製延遲',
    help: '主庫寫完後，要多久才把這筆寫入送到副本（網路、批次傳送）。這段時間加上副本排隊和套用的時間，就是複製延遲（replication lag）。在這段時間讀副本，會讀到舊資料。',
  },
  maxLagMs: {
    type: 'int', default: 0, min: 0, max: 3600000, unit: 'ms', label: '副本延遲上限',
    help: '副本落後超過這個時間，讀取就不送給它（像 proxy 的 max replication lag 檢查）。全部副本都太落後時，讀主庫。0 表示不檢查。',
  },
  localReplicas: {
    type: 'int', default: 0, min: 0, max: 15, label: '留在主庫區域的副本數',
    help: '設了「副本所在區域」時，前幾個副本留在主庫的區域，其餘放到副本所在區域。讀取會先找呼叫端所在區域的副本。',
  },
  failover: {
    type: 'enum', default: 'off', label: '自動 failover',
    options: [
      { value: 'off', label: '關（主庫故障就不能寫）' },
      { value: 'auto', label: '自動（副本升為主庫）' },
    ],
    help: '主庫故障後，把最跟得上的副本升為主庫。複製是非同步的：主庫已經回覆成功、但還沒送到這個副本的寫入，就遺失了。需要讀副本，而且「副本套用寫入成本」大於 0（才追蹤複製進度）。',
  },
  failoverS: {
    type: 'number', default: 90, min: 0, max: 3600, unit: 's', label: 'failover 時間', when: { param: 'failover', value: 'auto' },
    help: '主庫故障到副本接手要多久：偵測、確認、選新主庫、改連線。這段時間寫入全部失敗。RDS Multi-AZ 執行個體約 60–120 秒；Multi-AZ cluster 約 20–35 秒。',
  },
  fencing: {
    type: 'enum', default: 'off', label: '隔離舊主庫（fencing）', when: { param: 'failover', value: 'auto' },
    options: [
      { value: 'off', label: '關（舊主庫還收寫入）' },
      { value: 'on', label: '開（舊主庫拒絕寫入）' },
    ],
    help: '網路分區時，副本那一側以為主庫故障，升了新主庫。舊主庫其實還活著，它那一側的使用者還在寫：兩邊各自收寫入（split brain），分區結束後資料分歧。開啟 fencing（像 STONITH 或 epoch token）時，新主庫一升起，舊主庫就拒絕寫入。',
  },
  readYourWrites: {
    type: 'enum', default: 'off', label: '讀到自己的寫入',
    options: [
      { value: 'off', label: '關（照「讀取來源」）' },
      { value: 'primary', label: '寫入後一段時間讀主庫' },
    ],
    help: '使用者剛寫入就讀，讀到還沒複製過去的副本，會看不到自己的寫入（read-your-writes 失敗）。開啟時，寫入後「視窗」內的讀取送到主庫。代價：主庫讀取變多。',
  },
  rywWindowMs: {
    type: 'int', default: 2000, min: 0, max: 3600000, unit: 'ms', label: '讀主庫的視窗', when: { param: 'readYourWrites', value: 'primary' },
    help: '寫入後多久之內的讀取送到主庫。應該大於一般的複製延遲。',
  },
  locks: {
    type: 'enum', default: 'off', label: '列鎖',
    options: [
      { value: 'off', label: '不計（寫入互不等待）' },
      { value: 'row', label: '列鎖（同一個 key 的寫入排隊）' },
    ],
    help: '寫入同一列（同一個 key）要先拿到這一列的鎖。熱門 key 的寫入會一個接一個做：等鎖的寫入佔著連線，延遲和排隊變長。這個 key 的寫入量最多是 1 ÷（寫入時間＋握鎖時間）。',
  },
  lockHoldMs: {
    type: 'number', default: 0, min: 0, max: 600000, unit: 'ms', label: '寫完後再握鎖', when: { param: 'locks', value: 'row' },
    help: '寫入做完後，交易還要握著鎖多久才 commit（交易裡還有別的查詢、或應用程式在交易中呼叫別的服務）。',
  },
});

export const KINDS: Record<string, KindSpec> = {
  client: {
    kind: 'client', label: '使用者', labelEn: 'Client', category: 'traffic', icon: 'Users', station: false, routing: 'one',
    summary: '產生流量。流量大小在情境（scenario）設定。有多個使用者時，依權重分配流量。',
    params: {
      weight: { type: 'number', default: 1, min: 0, max: 1000, label: '流量權重', help: '有多個使用者節點時，依權重分配情境的總流量。' },
      deadline: {
        type: 'enum', default: 'off', label: 'Deadline 傳遞',
        options: [
          { value: 'off', label: '不傳（每條線各自計時）' },
          { value: 'propagate', label: '往下傳（像 gRPC deadline）' },
        ],
        help: '往下傳：請求帶著「使用者放棄的時間點」。每一跳最多等到那時候；已經過期的請求在排隊時直接丟掉，不再白做；過期後也不再重試。',
      },
      priority: {
        type: 'enum', default: 'normal', label: '請求優先級',
        options: [
          { value: 'critical', label: '關鍵（結帳、登入）' },
          { value: 'normal', label: '一般' },
          { value: 'batch', label: '可丟棄（batch、爬蟲、bot）' },
        ],
        help: '這個使用者送出的請求是哪一級。過載時，設了「降載門檻」的元件會先丟「可丟棄」的請求；限流器也可以只限「可丟棄」的請求。',
      },
    },
  },
  dns: {
    kind: 'dns', label: 'DNS', labelEn: 'DNS', category: 'edge', icon: 'Globe', station: false, routing: 'one',
    summary: '把網域名稱換成 IP。客戶端會快取結果，所以只有少數請求要多等一次查詢。有多條出線時依權重分流（例如分到兩個區域）。開啟 failover 時，會把故障的目標從答案裡拿掉。',
    params: {
      lookupMs: dist(20, 0.5, '查詢時間', '快取沒命中時，多等的查詢時間。'),
      resolverCacheHit: { type: 'ratio', default: 0.95, label: '客戶端快取命中率', help: '不用重新查詢的請求比例。' },
      failover: {
        type: 'enum', default: 'off', label: 'DNS failover',
        options: [
          { value: 'off', label: '關（一直照權重分）' },
          { value: 'on', label: '開（健康檢查，拿掉故障的目標）' },
        ],
        help: '開啟後，DNS 每秒檢查每個目標（例如每個區域的負載平衡器）。目標連續故障到「偵測時間」，就不再出現在答案裡；恢復同樣久，再放回來。客戶端快取舊答案，所以改道要再等 TTL 才全部生效。',
      },
      detectS: { type: 'number', default: 10, min: 1, max: 600, unit: 's', label: '偵測時間', help: '目標要連續故障（或恢復）多久，DNS 才改答案。', when: DNS_FAILOVER },
      ttlS: {
        type: 'number', default: 60, min: 0, max: 86400, unit: 's', label: 'TTL', when: DNS_FAILOVER,
        help: '客戶端把 DNS 答案快取多久。DNS 改答案後，還拿著舊答案的客戶端會繼續送到故障的目標；TTL 內逐步換成新答案（快取沒命中、重新查詢的請求立刻拿到新答案）。TTL 短，改道快。查詢多少由「客戶端快取命中率」決定，這裡不跟著 TTL 變。',
      },
    },
  },
  cdn: {
    kind: 'cdn', label: 'CDN', labelEn: 'CDN', category: 'edge', icon: 'Cloud', station: false, routing: 'one',
    summary: '離使用者近的快取。讀取命中就直接回應；沒命中才轉給後面的來源（origin）。寫入一律轉給來源。容量視為無限。',
    params: {
      hitRatio: { type: 'ratio', default: 0.8, label: '命中率', help: '讀取請求在 CDN 命中的比例。' },
      edgeMs: dist(10, 0.5, '邊緣延遲', 'CDN 節點本身的處理時間。'),
    },
  },
  api_gateway: {
    kind: 'api_gateway', label: 'API Gateway', labelEn: 'API gateway', category: 'edge', icon: 'DoorOpen', station: true, routing: 'one',
    summary: '前門：驗證、依讀寫分流到後端。它是代理，會占著位置等後端回應。',
    params: {
      instances: instances(2),
      concurrency: concurrency(256),
      serviceMs: dist(1, 0.5, '處理時間', '驗證和路由花的時間。'),
      queueLimit: queueLimit(1000),
      shedAt: {
        type: 'ratio', default: 0, label: '降載門檻（丟 batch）',
        help: '一台的排隊數到「排隊上限 × 這個比例」時，新來的「可丟棄」請求直接拒絕（shed），把位置留給一般和關鍵請求。0 表示不分優先級。',
      },
      ...queueing(),
      ...autoscale(10),
    },
  },
  load_balancer: {
    kind: 'load_balancer', label: 'Load Balancer', labelEn: 'Load balancer', category: 'edge', icon: 'Split', station: false, routing: 'one',
    summary: '把請求分給後面所有節點的所有實例。可以選分配策略。會跳過它認為不健康的實例：預設立刻知道哪台故障；也可以改成定期 health check，或看回應自動剔除出錯的實例（outlier detection）。容量視為無限。',
    params: {
      policy: {
        type: 'enum', default: 'round_robin', label: '分配策略',
        options: [
          { value: 'round_robin', label: '輪流（round robin）' },
          { value: 'least_conn', label: '最少連線（least connections）' },
          { value: 'p2c', label: '隨機挑兩台取較閒（power of two）' },
          { value: 'random', label: '隨機' },
        ],
        help: '怎麼選下一個實例。',
      },
      latencyMs: dist(0.3, 0.3, '轉送延遲', 'LB 自己的處理時間。'),
      healthCheck: {
        type: 'enum', default: 'instant', label: 'Health check',
        options: [
          { value: 'instant', label: '立刻知道（理想化）' },
          { value: 'liveness', label: '存活檢查（只看程序在不在）' },
          { value: 'deep', label: '深度檢查（真的跑一次請求）' },
        ],
        help: '負載平衡器怎麼知道哪台壞了。「立刻知道」是理想情況。存活檢查只發現當機，看不到「還活著但變慢或一直出錯」的實例（gray failure）。深度檢查會發現出錯和太慢的實例。',
      },
      hcIntervalS: { type: 'number', default: 5, min: 0.1, max: 600, unit: 's', label: '檢查間隔', help: '每台多久檢查一次。', when: PROBE },
      hcThreshold: { type: 'int', default: 2, min: 1, max: 100, label: '連續幾次才切換', help: '連續失敗幾次才移出；移出後連續成功幾次才放回。', when: PROBE },
      hcTimeoutMs: {
        type: 'number', default: 1000, min: 1, max: 600000, unit: 'ms', label: '檢查逾時', when: { param: 'healthCheck', value: 'deep' },
        help: '深度檢查的請求超過這個時間沒回應，算一次失敗。',
      },
      outlier: {
        type: 'enum', default: 'off', label: '自動剔除出錯的實例',
        options: [
          { value: 'off', label: '關' },
          { value: 'on', label: '開（outlier detection）' },
        ],
        help: '看真實請求的回應：某台連續失敗（錯誤、逾時、故障）達到門檻，就暫時不送給它。最多同時剔除一半的實例。',
      },
      outlierErrors: { type: 'int', default: 5, min: 1, max: 1000, label: '連續失敗幾次剔除', help: '同一台連續幾個請求失敗就剔除。', when: OUTLIER },
      ejectS: { type: 'number', default: 30, min: 0.1, max: 3600, unit: 's', label: '剔除多久', help: '剔除後多久再放回來試。', when: OUTLIER },
    },
  },
  rate_limiter: {
    kind: 'rate_limiter', label: 'Rate Limiter', labelEn: 'Rate limiter', category: 'resilience', icon: 'Gauge', station: false, routing: 'one',
    summary: '限流。令牌桶：每秒補固定數量的令牌，最多存「突發額度」個；也可以限制同時處理中的請求數。超過的請求立刻回 429（rate_limited）。可以全部共用一個額度，或每個使用者（租戶）各有一個。',
    params: {
      limit: {
        type: 'enum', default: 'rate', label: '限制什麼',
        options: [
          { value: 'rate', label: '每秒請求數（令牌桶）' },
          { value: 'concurrency', label: '同時處理中的請求數' },
          { value: 'both', label: '兩個都限' },
        ],
        help: '每秒請求數擋的是「來得太快」；同時處理中的請求數擋的是「佔著不放」（像 Stripe 的並行上限），下游變慢時它會先擋。',
      },
      ratePerSec: { type: 'number', default: 1000, min: 0, max: 10000000, unit: 'req/s', label: '每秒上限', help: '長期平均每秒放行幾個請求。' },
      burst: { type: 'int', default: 100, min: 1, max: 10000000, label: '突發額度', help: '桶子最多存幾個令牌，也就是一次最多放行幾個。' },
      maxConcurrent: { type: 'int', default: 100, min: 1, max: 10000000, label: '同時處理上限', help: '已經放行、還沒拿到回應的請求最多幾個。' },
      scope: {
        type: 'enum', default: 'global', label: '額度怎麼分',
        options: [
          { value: 'global', label: '全部共用一個' },
          { value: 'per_client', label: '每個使用者（租戶）各一個' },
        ],
        help: '每個使用者各一個：一個大客戶用完自己的額度，不會吃掉別人的。',
      },
      appliesTo: {
        type: 'enum', default: 'all', label: '限哪些請求',
        options: [
          { value: 'all', label: '全部' },
          { value: 'batch', label: '只限「可丟棄」的請求（bot、batch）' },
        ],
        help: '只限可丟棄的請求時，一般和關鍵請求直接放行。',
      },
    },
  },
  service: {
    kind: 'service', label: 'API Server', labelEn: 'API server', category: 'compute', icon: 'Server', station: true, routing: 'plan',
    summary: '處理請求，再呼叫下游。等下游時仍占著自己的位置（像 thread pool），所以下游變慢會連帶讓它排隊。同時連到 cache 和 DB 時，讀取走 cache-aside。',
    params: {
      instances: instances(2),
      concurrency: concurrency(32),
      serviceMs: dist(5, 1, '處理時間', '自己的運算時間，不含等下游。'),
      queueLimit: queueLimit(500),
      shedAt: {
        type: 'ratio', default: 0, label: '降載門檻（丟 batch）',
        help: '一台的排隊數到「排隊上限 × 這個比例」時，新來的「可丟棄」請求直接拒絕（shed），把位置留給一般和關鍵請求。0 表示不分優先級。',
      },
      ...queueing(),
      errorRate,
      calls: {
        type: 'enum', default: 'sequential', label: '呼叫下游的方式',
        options: [
          { value: 'sequential', label: '依序（一個做完才下一個）' },
          { value: 'parallel', label: '平行（同時發出，等全部回來）' },
        ],
        help: '有多個下游時，依序還是平行呼叫。',
      },
      outbox: {
        type: 'enum', default: 'off', label: '寫入後送訊息（outbox）',
        options: [
          { value: 'off', label: '關（寫 DB、再送 queue，兩件事分開做）' },
          { value: 'on', label: '開（transactional outbox）' },
        ],
        help: '寫入同時要寫 DB 和送訊息到 queue 時：關掉時兩件事分開做，一個成功一個失敗就不一致（dual write）。打開時訊息和資料在同一筆交易寫進 DB 的 outbox 表，再由 relay 送到 queue，失敗就重試到送達；請求在 DB 寫成功時就回成功。',
      },
      outboxRetryMs: { type: 'number', default: 1000, min: 1, max: 600000, unit: 'ms', label: 'outbox 重試間隔', help: 'relay 送訊息失敗後，等多久再送一次。', when: { param: 'outbox', value: 'on' } },
      ...autoscale(10),
    },
  },
  circuit_breaker: {
    kind: 'circuit_breaker', label: 'Circuit Breaker', labelEn: 'Circuit breaker', category: 'resilience', icon: 'Unplug', station: false, routing: 'one',
    summary: '保險絲。最近一段時間下游失敗太多就「跳開」，之後的請求立刻失敗（circuit_open），不再等下游。過一陣子放少量請求試探，成功就恢復。通常搭配出線的逾時。',
    params: {
      failureRatio: { type: 'ratio', default: 0.5, label: '跳開門檻', help: '統計視窗內失敗比例超過這個值就跳開。' },
      minCalls: { type: 'int', default: 20, min: 1, max: 100000, label: '最少呼叫數', help: '視窗內至少要有這麼多呼叫才判斷。' },
      windowS: { type: 'number', default: 10, min: 1, max: 600, unit: 's', label: '統計視窗', help: '看最近幾秒的成功和失敗。' },
      openMs: { type: 'number', default: 5000, min: 1, max: 600000, unit: 'ms', label: '跳開時間', help: '跳開後等多久才開始試探。' },
      halfOpenCalls: { type: 'int', default: 5, min: 1, max: 1000, label: '試探請求數', help: '試探時放行幾個請求；全部成功就恢復。' },
    },
  },
  cache: {
    kind: 'cache', label: 'Cache', labelEn: 'Cache', category: 'data', icon: 'MemoryStick', station: true, routing: 'plan',
    summary: '記憶體快取（像 Redis）。命中就不用查 DB。可以用固定命中率，或用 LRU 依容量和 key 的熱門程度算出命中率。key 依雜湊分到各實例。',
    params: {
      mode: {
        type: 'enum', default: 'fixed', label: '命中率模式',
        options: [
          { value: 'fixed', label: '固定命中率' },
          { value: 'lru', label: 'LRU（依容量、key 分布算）' },
        ],
        help: '固定：每次讀取依命中率隨機決定。LRU：真的記住 key，容量滿了淘汰最久沒用的；一開始是冷的。',
      },
      hitRatio: { type: 'ratio', default: 0.9, label: '命中率（固定模式）', help: '讀取命中的比例。', when: { param: 'mode', value: 'fixed' } },
      capacityKeys: { type: 'int', default: 10000, min: 1, max: 10000000, label: '容量（key 數，LRU）', help: '全部實例合計最多存幾個 key。', when: LRU },
      ttlS: { type: 'number', default: 0, min: 0, max: 86400, unit: 's', label: 'TTL（LRU）', help: '存多久過期。0 表示不過期。', when: LRU },
      ttlJitter: {
        type: 'ratio', default: 0, label: 'TTL jitter', when: LRU,
        help: '每次寫入時，TTL 隨機縮短 0 到這個比例（0.2 = 最多短 20%）。同時寫入的 key 就不會同時過期、同時去查 DB。',
      },
      stampede: {
        type: 'enum', default: 'none', label: '防擊穿（stampede）', when: LRU,
        options: [
          { value: 'none', label: '不保護' },
          { value: 'coalesce', label: '合併查詢（read-through）' },
          { value: 'lease', label: 'Lease（cache-aside）' },
        ],
        help: '熱門 key 過期時，很多請求同時沒命中，一起去查 DB。合併查詢：快取後面直接接 DB 時，同一個 key 只查一次，其他請求等結果。Lease：服務自己查 DB 時，第一個沒命中的拿到 lease 去查，其他的稍等再問一次快取。',
      },
      leaseMs: {
        type: 'number', default: 2000, min: 10, max: 60000, unit: 'ms', label: 'Lease 有效時間', when: { param: 'stampede', value: 'lease' },
        help: '拿到 lease 的請求要在這段時間內把值寫回快取；過了還沒寫回，下一個沒命中的請求拿新的 lease。',
      },
      leaseWaitMs: {
        type: 'number', default: 20, min: 1, max: 5000, unit: 'ms', label: '等待後重問', when: { param: 'stampede', value: 'lease' },
        help: '沒拿到 lease 的請求等多久再問一次快取。',
      },
      instances: instances(1),
      concurrency: concurrency(8, '同時處理幾個操作'),
      opMs: dist(0.3, 0.5, '操作時間', '一次 get／set 的時間。'),
      queueLimit: queueLimit(10000),
    },
  },
  database: {
    kind: 'database', label: 'Database', labelEn: 'Database', category: 'data', icon: 'Database', station: true, routing: 'leaf',
    summary: '關聯式資料庫，一個主庫加可選的讀副本。寫入只到主庫；讀取依設定分給副本或主庫。每台的連線數就是它同時能處理的查詢數。',
    params: dbParams(),
  },
  sharded_db: {
    kind: 'sharded_db', label: 'Sharded DB', labelEn: 'Sharded database', category: 'data', icon: 'Layers', station: true, routing: 'leaf',
    summary: '資料依 key 的雜湊分到多個分片，每個分片是一組主庫加副本。熱門 key 會讓某個分片特別忙（熱點）。',
    params: {
      shards: { type: 'int', default: 4, min: 1, max: 256, label: '分片數', help: '資料分成幾份。' },
      ...dbParams(),
    },
  },
  queue: {
    kind: 'queue', label: 'Queue', labelEn: 'Queue', category: 'messaging', icon: 'ListOrdered', station: false, routing: 'queue',
    summary: '訊息佇列（像 SQS、Kafka）。收到訊息就回應，訊息排著等 worker 拿。接在它後面的所有 worker 一起分攤訊息。',
    params: {
      maxDepth: { type: 'int', default: 100000, min: 1, max: 100000000, label: '最大深度', help: '最多存幾則訊息。滿了就拒絕寫入（queue_full）。' },
      enqueueMs: dist(2, 0.5, '寫入延遲', '寫入並確認收到的時間。'),
      delivery: {
        type: 'enum', default: 'at_most_once', label: '交付方式',
        options: [
          { value: 'at_most_once', label: '交出就刪（最多一次）' },
          { value: 'at_least_once', label: '做完才刪（至少一次）' },
        ],
        help: '最多一次：worker 失敗或故障，訊息就遺失。至少一次（像 SQS）：worker 成功才刪除；失敗或太慢，訊息在 visibility timeout 後重新出現，可能被處理兩次。',
      },
      visibilityTimeoutMs: { type: 'int', default: 30000, min: 1, max: 43200000, unit: 'ms', label: 'Visibility timeout', help: '訊息交給 worker 後隱藏多久。這段時間內沒做完（或失敗），訊息會重新出現給別的 worker。比處理時間短，就會重複處理。', when: { param: 'delivery', value: 'at_least_once' } },
      maxReceives: { type: 'int', default: 0, min: 0, max: 1000, label: '最多接收次數（DLQ）', help: '一則訊息被拿走這麼多次還沒成功，就移到 dead-letter queue（DLQ），不再重試。0 表示沒有 DLQ，會一直重試。', when: { param: 'delivery', value: 'at_least_once' } },
      messageTtlS: { type: 'number', default: 0, min: 0, max: 1209600, unit: 's', label: '訊息保留時間', help: '訊息放了這麼久還沒處理完就丟掉（過期）。0 表示永遠保留。' },
      ordering: {
        type: 'enum', default: 'standard', label: '順序',
        options: [
          { value: 'standard', label: '一般（不保證順序）' },
          { value: 'fifo', label: 'FIFO（同一組依序）' },
        ],
        help: 'FIFO（像 SQS FIFO、Kafka 的 partition）：同一組（同一個 key）的訊息一次只交出一則，前一則做完、失敗丟掉或進 DLQ 才交下一則。前一則卡住（處理很慢、毒訊息一直重試），後面整組都等（head-of-line blocking）。',
      },
      groups: { type: 'int', default: 16, min: 1, max: 100000, label: '訊息分組數', help: 'FIFO 時，訊息依 key 分成幾組（像 message group 或 partition 數）。組越少，越容易互相卡住；也限制同時能處理的訊息數。', when: { param: 'ordering', value: 'fifo' } },
    },
  },
  worker: {
    kind: 'worker', label: 'Worker', labelEn: 'Worker', category: 'compute', icon: 'Cog', station: true, routing: 'plan',
    summary: '背景工人。從前面的 queue 拿訊息來處理，可以再呼叫 DB 或 object storage。它的速度決定 queue 會不會越積越多。',
    params: {
      instances: instances(2),
      concurrency: concurrency(4, '同時處理幾則訊息'),
      serviceMs: dist(50, 1, '處理時間', '處理一則訊息的運算時間，不含等下游。'),
      queueLimit: queueLimit(100),
      errorRate,
      poisonRate: { type: 'ratio', default: 0, label: '毒訊息比例', help: '這個比例的訊息內容有問題，每次處理都失敗。搭配 queue 的「至少一次」和 DLQ 看效果。' },
      calls: {
        type: 'enum', default: 'sequential', label: '呼叫下游的方式',
        options: [
          { value: 'sequential', label: '依序' },
          { value: 'parallel', label: '平行' },
        ],
        help: '有多個下游時，依序還是平行呼叫。',
      },
      outbox: {
        type: 'enum', default: 'off', label: '寫入後送訊息（outbox）',
        options: [
          { value: 'off', label: '關（寫 DB、再送 queue，兩件事分開做）' },
          { value: 'on', label: '開（transactional outbox）' },
        ],
        help: '寫入同時要寫 DB 和送訊息到 queue 時：關掉時兩件事分開做，一個成功一個失敗就不一致（dual write）。打開時訊息和資料在同一筆交易寫進 DB 的 outbox 表，再由 relay 送到 queue，失敗就重試到送達；請求在 DB 寫成功時就回成功。',
      },
      outboxRetryMs: { type: 'number', default: 1000, min: 1, max: 600000, unit: 'ms', label: 'outbox 重試間隔', help: 'relay 送訊息失敗後，等多久再送一次。', when: { param: 'outbox', value: 'on' } },
      ...autoscale(10),
    },
  },
  function: {
    kind: 'function', label: 'Function', labelEn: 'Function', category: 'compute', icon: 'Zap', station: true, routing: 'plan',
    summary: '無伺服器函式（像 AWS Lambda）。每個執行環境一次只處理 1 個請求。沒有空的環境就開一個新的（冷啟動，這個請求要多等）；用完閒置一段時間後收回。同時的環境數到上限、或開新環境的速度超過擴充速率時，新請求被拒（throttle，429）；從 queue 來的訊息則留在 queue 裡等。',
    params: {
      maxConcurrency: {
        type: 'int', default: 1000, min: 1, max: 100000, label: '併發上限',
        help: '同時最多幾個執行環境（每個 1 個請求）。到上限後同步呼叫被拒（429）。AWS 帳號每個區域預設 1000，可以用保留併發（reserved concurrency）設得更低。',
      },
      provisioned: {
        type: 'int', default: 0, min: 0, max: 100000, label: '預先備好的環境',
        help: '一開始就備好、不會被收回的環境數（provisioned concurrency）。用到它們的請求沒有冷啟動。算在併發上限裡。',
      },
      serviceMs: dist(50, 1, '處理時間', '一個請求自己的運算時間，不含等下游。'),
      coldStartMs: dist(300, 0.5, '冷啟動時間', '開一個新環境要多久（下載程式碼、啟動執行環境、跑初始化程式）。這段時間算在觸發它的請求的延遲裡。Node.js、Python 約 100–500 ms；Java 沒有 SnapStart 時常常超過 1 秒。'),
      idleS: {
        type: 'number', default: 600, min: 1, max: 7200, unit: 's', label: '閒置回收時間',
        help: '環境沒有請求這麼久就被收回，下一個請求要再冷啟動。AWS 沒有公布，實際約 5–15 分鐘。',
      },
      scalePer10s: {
        type: 'int', default: 1000, min: 1, max: 100000, label: '擴充速率（每 10 秒）',
        help: '每 10 秒最多開幾個新環境。超過的請求被拒（429）。AWS Lambda 每個函式每 10 秒最多 1000 個。',
      },
      errorRate,
      calls: {
        type: 'enum', default: 'sequential', label: '呼叫下游的方式',
        options: [
          { value: 'sequential', label: '依序' },
          { value: 'parallel', label: '平行' },
        ],
        help: '有多個下游時，依序還是平行呼叫。',
      },
    },
  },
  object_storage: {
    kind: 'object_storage', label: 'Object Storage', labelEn: 'Object storage', category: 'data', icon: 'Archive', station: true, routing: 'leaf',
    summary: '物件儲存（像 S3）。容量很大但每次存取比較慢。讀取是 GET，寫入是 PUT。',
    params: {
      getMs: dist(30, 0.6, 'GET 時間', '讀一個物件到第一個位元組的時間。'),
      putMs: dist(60, 0.6, 'PUT 時間', '寫一個物件的時間。'),
      concurrency: concurrency(2000),
      queueLimit: queueLimit(10000),
      errorRate,
    },
  },
};

export const KIND_NAMES = Object.keys(KINDS);

export const CATEGORY_LABEL: Record<Category, string> = {
  traffic: '流量',
  edge: '入口與網路',
  compute: '運算',
  resilience: '保護',
  data: '資料',
  messaging: '非同步',
};

export const EDGE_PARAMS: Record<string, ParamSpec> = {
  on: {
    type: 'enum', default: 'all', label: '走哪些請求',
    options: [
      { value: 'all', label: '全部' },
      { value: 'read', label: '只走讀取' },
      { value: 'write', label: '只走寫入' },
      { value: 'boot', label: '只在開機時用' },
      { value: 'control', label: '控制面（監控、協調）' },
    ],
    help: '這條線只給讀取、只給寫入，或全部。「只在開機時用」：自動擴充的新機器開機時呼叫一次（拿設定、註冊、拉映像檔），全部成功才上線；平常的請求不走這條線。「控制面」：自動擴充、資料庫自動 failover、DNS failover 每次做決定前先呼叫它（拿監控數字、問協調服務）；失敗就看不到，這次不動作。平常的請求也不走。',
  },
  weight: { type: 'number', default: 1, min: 0, max: 1000, label: '權重', help: '節點從多條線選一條時，依權重選。' },
  latencyMs: { type: 'number', default: 0.5, min: 0, max: 60000, unit: 'ms', label: '網路延遲（單程）', help: '從使用者出發的線預設 20 ms（網際網路），其他預設 0.5 ms（同機房）。' },
  timeoutMs: { type: 'number', default: 0, min: 0, max: 600000, unit: 'ms', label: '逾時', help: '呼叫方最多等多久。0 表示不設。逾時後下游仍會做完（白工）。' },
  retries: { type: 'int', default: 0, min: 0, max: 10, label: '重試次數', help: '失敗後最多再試幾次。限流（429）和保險絲跳開不重試。' },
  backoffMs: { type: 'number', default: 50, min: 0, max: 60000, unit: 'ms', label: '重試等待基準', help: '第 n 次重試前隨機等 0 到 基準 × 2^(n−1) 毫秒（full jitter）。' },
  retryBudget: {
    type: 'number', default: 0, min: 0, max: 10, label: '重試預算',
    help: '最近 10 秒內，這條線的重試數最多是首次呼叫數的幾倍（Google 建議 0.1 = 10%）。超過就不重試，直接回報失敗。0 表示不限。',
  },
  throttleK: {
    type: 'number', default: 0, min: 0, max: 10, label: '自適應限流 K',
    help: '呼叫端自己限流（Google SRE 的 adaptive throttling）。看最近 10 秒：送出 requests 次、成功 accepts 次；新的呼叫以 max(0, (requests − K × accepts) ÷ (requests + 1)) 的機率直接在本地失敗，不送出去。K = 2 是書上的建議值，越小擋得越早。0 表示不用。',
  },
  bulkhead: {
    type: 'int', default: 0, min: 0, max: 100000, label: '隔艙（同時呼叫上限）',
    help: '呼叫端每台最多同時有幾個呼叫走這條線（bulkhead）。滿了就直接失敗（隔艙已滿），不再佔用更多執行緒。這樣一個變慢的下游只會卡住這幾個名額，不會卡住整台。0 表示不限。',
  },
  hedgeMs: {
    type: 'number', default: 0, min: 0, max: 600000, unit: 'ms', label: '對沖請求',
    help: '讀取送出後這麼久還沒回應，就再送一份（hedged request），先成功的那份算數。通常設成 p95 延遲，用多送約 5% 的請求壓低長尾延遲。輸的那份下游仍會做完。只用在讀取（寫入重送不安全）。0 表示不用。',
  },
  fanout: {
    type: 'int', default: 0, min: 0, max: 256, label: '扇出（同時送幾份）',
    help: '每個呼叫同時送給終點的幾份，等它們回來才算完成（scatter-gather）。分片資料庫：送給幾個分片（例如搜尋要問每個分片）；資料庫：送給主庫和副本裡的幾台（寫入直接寫到每一份）；其他節點：送給幾台不同的實例。大於可用的數量時，就送給全部。份數越多，越可能碰到一台慢的，所以長尾延遲會被放大。0 表示只送一份。',
  },
  quorum: {
    type: 'int', default: 0, min: 0, max: 256, label: 'Quorum（等幾份）',
    help: '扇出時，成功的份數到這個數字就回覆，不等其他份（像 Cassandra、DynamoDB 的 quorum：3 份等 2 份）。失敗太多、湊不到這個數字時就失敗。沒等到的份數仍會做完。0 表示等全部。',
  },
  connectMs: {
    type: 'number', default: 0, min: 0, max: 60000, unit: 'ms', label: '建立連線',
    help: '開一條新連線要多久（TCP＋TLS 握手，跨區時常要好幾個來回）。連線用完會留著給下一個呼叫（keep-alive），閒置太久就關掉；同時呼叫變多、或閒置後的第一個呼叫，要先付這段時間。0 表示不算。',
  },
  keepAlive: {
    type: 'enum', default: 'on', label: '連線重用（keep-alive）',
    options: [
      { value: 'on', label: '開（連線用完留著）' },
      { value: 'off', label: '關（每個呼叫都開新連線）' },
    ],
    help: '關掉時，每個呼叫都要付一次建立連線的時間。只在「建立連線」大於 0 時有作用。',
  },
  idleS: {
    type: 'number', default: 60, min: 0, max: 3600, unit: 's', label: '閒置多久關連線',
    help: '一條連線閒置這麼久就關掉；下一個呼叫要重新建立。只在「建立連線」大於 0 時有作用。',
  },
  fallback: {
    type: 'enum', default: 'off', label: '降級回應',
    options: [
      { value: 'off', label: '關（失敗就往上回報失敗）' },
      { value: 'on', label: '開（失敗時改用備用回應）' },
    ],
    help: '這條線的呼叫最後還是失敗時（重試用完、逾時、保險絲跳開、隔艙已滿），呼叫端改用備用回應（fallback，例如預設推薦清單），請求照樣成功，但算「降級回應」。適合不是必要的下游。',
  },
};

export const CLIENT_EDGE_LATENCY_MS = 20;
/** Default one-way latency between two regions, ms (US east ↔ west coast: a round trip of about 70 ms). */
export const INTER_REGION_MS = 35;

export type Dist = { mean: number; cv: number };
export type ResolvedParams = Record<string, number | string | Dist>;

/** Fill defaults and normalise distributions to { mean, cv }. Does not mutate the input. */
export function resolveParams(kind: string, params: Record<string, unknown> | undefined): ResolvedParams {
  const spec = KINDS[kind];
  const out: ResolvedParams = {};
  if (!spec) return out;
  for (const [name, p] of Object.entries(spec.params)) {
    const v = params?.[name];
    if (p.type === 'dist') {
      if (typeof v === 'number') out[name] = { mean: v, cv: p.default.cv };
      else if (v && typeof v === 'object') {
        const o = v as { mean?: number; cv?: number };
        out[name] = { mean: o.mean ?? p.default.mean, cv: o.cv ?? p.default.cv };
      } else out[name] = { ...p.default };
    } else {
      out[name] = (v as number | string | undefined) ?? p.default;
    }
  }
  return out;
}

/**
 * Whether an edge's `fanout` works: the target needs instances or shards, and the edge is called
 * one call at a time. A queue hands each message to one worker; a load balancer picks one backend.
 */
export function fanoutApplies(fromKind: string, toKind: string): boolean {
  return !!KINDS[toKind]?.station && fromKind !== 'queue' && fromKind !== 'load_balancer';
}
