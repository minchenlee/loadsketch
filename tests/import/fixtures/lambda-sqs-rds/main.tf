# Fixture: API Gateway -> Lambda (api) -> RDS (MySQL), and an SQS queue that a second Lambda (worker)
# reads and writes to the same database. A DynamoDB table holds sessions.
# Only for `terraform plan` (scripts/gen-fixtures.sh), never `apply`: the credentials are fake and
# every endpoint points at 127.0.0.1:1. The plan runs in a sandbox that blocks outbound network.
#
# What each part is for:
#   C2  api has no reserved concurrency (account default 1000, an estimate) and talks to the DB
#       without RDS Proxy; worker has reserved 50 and maximum_concurrency 20 on its event source.
#   C5  API Gateway integration 29 s < api timeout 60 s; jobs visibility 120 s < worker timeout 60 s x 6.
#   C6  SDK 3 attempts x jobs maxReceiveCount 5 = 15 > 10. The DLQ ARN is built from the DLQ's name
#       (known at plan), so the redrive policy can be read; an ARN reference would be unknown until apply.
#   C7  the audit queue has no redrive_policy (api calls it synchronously: no async DLQ is needed).
#   C8  stage throttling 5000 rps > what api can take (memory_size left at the AWS default 128 MB).
#   C11 the sessions table is PROVISIONED with no application autoscaling target.
# Environment values: one reference makes the whole variables map unknown in the plan, so a pool
# size there (DB_POOL_MAX) cannot be read; the importer uses its estimate.

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

provider "aws" {
  region                      = "us-east-1"
  access_key                  = "AKIAFIXTUREFAKEKEY00"
  secret_key                  = "fixture-fake-secret-key-not-real"
  skip_credentials_validation = true
  skip_requesting_account_id  = true
  skip_metadata_api_check     = true
  skip_region_validation      = true

  endpoints {
    apigateway = "http://127.0.0.1:1"
    dynamodb   = "http://127.0.0.1:1"
    ec2        = "http://127.0.0.1:1"
    iam        = "http://127.0.0.1:1"
    lambda     = "http://127.0.0.1:1"
    rds        = "http://127.0.0.1:1"
    sqs        = "http://127.0.0.1:1"
    sts        = "http://127.0.0.1:1"
  }
}

variable "account_id" {
  type    = string
  default = "123456789012"
}

variable "db_password" {
  type      = string
  sensitive = true
  default   = "fixture-fake-db-password-DO-NOT-LEAK"
}

resource "aws_vpc" "main" {
  cidr_block = "10.1.0.0/16"
}

resource "aws_subnet" "a" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.1.1.0/24"
  availability_zone = "us-east-1a"
}

resource "aws_subnet" "b" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.1.2.0/24"
  availability_zone = "us-east-1b"
}

resource "aws_security_group" "fn" {
  name   = "fn"
  vpc_id = aws_vpc.main.id
}

resource "aws_security_group" "db" {
  name   = "db"
  vpc_id = aws_vpc.main.id
  ingress {
    from_port       = 3306
    to_port         = 3306
    protocol        = "tcp"
    security_groups = [aws_security_group.fn.id]
  }
}

resource "aws_iam_role" "fn" {
  name = "fn"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = "sts:AssumeRole", Principal = { Service = "lambda.amazonaws.com" } }]
  })
}

# --- Database ---

resource "aws_db_subnet_group" "main" {
  name       = "main"
  subnet_ids = [aws_subnet.a.id, aws_subnet.b.id]
}

resource "aws_db_instance" "main" {
  identifier             = "main"
  engine                 = "mysql"
  instance_class         = "db.t3.small"
  allocated_storage      = 20
  username               = "app"
  password               = var.db_password
  multi_az               = false
  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.db.id]
  skip_final_snapshot    = true
}

resource "aws_dynamodb_table" "sessions" {
  name           = "sessions"
  billing_mode   = "PROVISIONED"
  read_capacity  = 100
  write_capacity = 50
  hash_key       = "id"
  attribute {
    name = "id"
    type = "S"
  }
}

# --- Queues ---

resource "aws_sqs_queue" "jobs_dlq" {
  name = "jobs-dlq"
}

resource "aws_sqs_queue" "jobs" {
  name                       = "jobs"
  visibility_timeout_seconds = 120
  message_retention_seconds  = 86400
  redrive_policy = jsonencode({
    deadLetterTargetArn = "arn:aws:sqs:us-east-1:${var.account_id}:${aws_sqs_queue.jobs_dlq.name}"
    maxReceiveCount     = 5
  })
}

# No redrive_policy: C7.
resource "aws_sqs_queue" "audit" {
  name = "audit"
}

# --- Functions ---

resource "aws_lambda_function" "api" {
  function_name = "api"
  role          = aws_iam_role.fn.arn
  runtime       = "nodejs20.x"
  handler       = "index.handler"
  s3_bucket     = "fixture-code"
  s3_key        = "api.zip"
  timeout       = 60
  vpc_config {
    subnet_ids         = [aws_subnet.a.id, aws_subnet.b.id]
    security_group_ids = [aws_security_group.fn.id]
  }
  environment {
    variables = {
      # References to resources: presumed lines api -> db, api -> jobs, api -> audit, api -> sessions.
      DB_HOST       = aws_db_instance.main.address
      JOBS_URL      = aws_sqs_queue.jobs.url
      AUDIT_URL     = aws_sqs_queue.audit.url
      SESSION_TABLE = aws_dynamodb_table.sessions.name
      # A fixed string: no line.
      FEATURE_FLAGS = "flags.internal"
    }
  }
}

resource "aws_lambda_function" "worker" {
  function_name                  = "worker"
  role                           = aws_iam_role.fn.arn
  runtime                        = "nodejs20.x"
  handler                        = "index.handler"
  s3_bucket                      = "fixture-code"
  s3_key                         = "worker.zip"
  memory_size                    = 1024
  timeout                        = 60
  reserved_concurrent_executions = 50
  vpc_config {
    subnet_ids         = [aws_subnet.a.id, aws_subnet.b.id]
    security_group_ids = [aws_security_group.fn.id]
  }
  environment {
    variables = {
      DB_HOST     = aws_db_instance.main.address
      DB_POOL_MAX = "2"
    }
  }
}

resource "aws_lambda_event_source_mapping" "jobs_worker" {
  event_source_arn        = aws_sqs_queue.jobs.arn
  function_name           = aws_lambda_function.worker.arn
  batch_size              = 10
  function_response_types = ["ReportBatchItemFailures"]
  scaling_config {
    maximum_concurrency = 20
  }
}

# --- API Gateway (REST) ---

resource "aws_api_gateway_rest_api" "main" {
  name = "main"
}

resource "aws_api_gateway_resource" "orders" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_rest_api.main.root_resource_id
  path_part   = "orders"
}

resource "aws_api_gateway_method" "orders_post" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.orders.id
  http_method   = "POST"
  authorization = "NONE"
}

resource "aws_api_gateway_integration" "orders_post" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.orders.id
  http_method             = aws_api_gateway_method.orders_post.http_method
  type                    = "AWS_PROXY"
  integration_http_method = "POST"
  uri                     = aws_lambda_function.api.invoke_arn
}

resource "aws_api_gateway_deployment" "main" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  depends_on  = [aws_api_gateway_integration.orders_post]
}

resource "aws_api_gateway_stage" "prod" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  deployment_id = aws_api_gateway_deployment.main.id
  stage_name    = "prod"
}

resource "aws_api_gateway_method_settings" "all" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  stage_name  = aws_api_gateway_stage.prod.stage_name
  method_path = "*/*"
  settings {
    throttling_rate_limit  = 5000
    throttling_burst_limit = 2000
  }
}
