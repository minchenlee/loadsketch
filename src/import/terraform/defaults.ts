// AWS and Terraform-provider defaults the importer fills in when a plan leaves a value unknown until
// apply. Each one names where it is written down (evidence `aws-default`, still definite). Provider docs are pinned to the provider version in the fixture lock file.
const PROVIDER_DOCS = 'https://github.com/hashicorp/terraform-provider-aws/blob/v6.72.0/website/docs/r';

export interface Default<T> { value: T; source: string }
const d = <T>(value: T, source: string): Default<T> => ({ value, source });

export const DEFAULTS = {
  targetGroup: {
    interval: d(30, `${PROVIDER_DOCS}/lb_target_group.html.markdown (health_check.interval: Defaults to 30)`),
    unhealthyThreshold: d(3, `${PROVIDER_DOCS}/lb_target_group.html.markdown (health_check.unhealthy_threshold: Defaults to 3)`),
    /** Seconds, by protocol: HTTP 6, TCP/TLS/HTTPS 10, GENEVE 5, Lambda targets 30. */
    timeout: d({ HTTP: 6, HTTPS: 10, TCP: 10, TLS: 10, GENEVE: 5, lambda: 30 } as Record<string, number>, `${PROVIDER_DOCS}/lb_target_group.html.markdown (health_check.timeout)`),
    algorithm: d('round_robin', `${PROVIDER_DOCS}/lb_target_group.html.markdown (load_balancing_algorithm_type: The default is round_robin)`),
  },
  lb: {
    internal: d(false, `${PROVIDER_DOCS}/lb.html.markdown (internal: Defaults to false)`),
  },
  dbInstance: {
    multiAz: d(false, 'https://docs.aws.amazon.com/AmazonRDS/latest/APIReference/API_CreateDBInstance.html (MultiAZ: default false)'),
  },
  lambda: {
    timeoutS: d(3, `${PROVIDER_DOCS}/lambda_function.html.markdown (timeout: Defaults to 3)`),
    memoryMiB: d(128, `${PROVIDER_DOCS}/lambda_function.html.markdown (memory_size: Defaults to 128)`),
    /** Account concurrency quota; accounts can have it raised, so the importer calls it an estimate. */
    accountConcurrency: d(1000, 'https://docs.aws.amazon.com/lambda/latest/dg/lambda-concurrency.html (default 1,000 concurrent executions per Region)'),
    scalePer10s: d(1000, 'https://docs.aws.amazon.com/lambda/latest/dg/scaling-behavior.html (1,000 execution environments every 10 seconds per function)'),
    /** Asynchronous invocations are retried twice: 3 attempts. */
    asyncAttempts: d(3, 'https://docs.aws.amazon.com/lambda/latest/dg/invocation-async-error-handling.html (retries twice)'),
  },
  sqs: {
    visibilityS: d(30, `${PROVIDER_DOCS}/sqs_queue.html.markdown (visibility_timeout_seconds: default 30)`),
    retentionS: d(345600, `${PROVIDER_DOCS}/sqs_queue.html.markdown (message_retention_seconds: default 345600, 4 days)`),
    delivery: d('at_least_once', 'https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/standard-queues.html (at-least-once delivery)'),
    noDepthLimit: d(100_000_000, 'https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/quotas-messages.html (number of stored messages: unlimited)'),
    noRedrive: d(0, `${PROVIDER_DOCS}/sqs_queue.html.markdown (redrive_policy: no dead-letter queue unless set)`),
  },
  apiGateway: {
    /** Account throttle; accounts can have it raised, so an estimate like the Lambda quota. */
    accountRate: d(10000, 'https://docs.aws.amazon.com/apigateway/latest/developerguide/limits.html (throttle quota per account per Region: 10,000 rps)'),
    accountBurst: d(5000, 'https://docs.aws.amazon.com/apigateway/latest/developerguide/limits.html (burst: 5,000 requests)'),
    restTimeoutMs: d(29000, `${PROVIDER_DOCS}/api_gateway_integration.html.markdown (timeout_milliseconds: default 29000)`),
    httpTimeoutMs: d(30000, `${PROVIDER_DOCS}/apigatewayv2_integration.html.markdown (timeout_milliseconds: default 30000 for HTTP APIs)`),
  },
  route53: {
    requestInterval: d(30, `${PROVIDER_DOCS}/route53_health_check.html.markdown (request_interval: default 30)`),
    failureThreshold: d(3, `${PROVIDER_DOCS}/route53_health_check.html.markdown (failure_threshold: default 3)`),
  },
  aurora: {
    failoverS: d(30, 'https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/Concepts.AuroraHighAvailability.html (failover typically completes within 30 seconds)'),
  },
  rdsProxy: {
    maxConnectionsPercent: d(100, `${PROVIDER_DOCS}/db_proxy_default_target_group.html.markdown (max_connections_percent: default 100)`),
  },
  elastiCache: {
    numCacheClusters: d(1, `${PROVIDER_DOCS}/elasticache_replication_group.html.markdown (num_cache_clusters: default 1 when num_node_groups is not set)`),
    automaticFailover: d(false, `${PROVIDER_DOCS}/elasticache_replication_group.html.markdown (automatic_failover_enabled: Defaults to false)`),
    multiAz: d(false, `${PROVIDER_DOCS}/elasticache_replication_group.html.markdown (multi_az_enabled: Defaults to false)`),
  },
} as const;
