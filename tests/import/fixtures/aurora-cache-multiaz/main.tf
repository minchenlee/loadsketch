# Fixture: Route 53 failover record -> CloudFront -> ALB -> EC2 Auto Scaling group in three AZs,
# with ElastiCache (Redis, Multi-AZ) and Aurora PostgreSQL (writer + 2 readers) behind RDS Proxy.
# Only for `terraform plan` (scripts/gen-fixtures.sh), never `apply`: the credentials are fake and
# every endpoint points at 127.0.0.1:1. The plan runs in a sandbox that blocks outbound network.
#
# Mostly the "does not fire" side of the checks:
#   C1/C2 the app reaches Aurora through RDS Proxy (max_connections_percent 50); the check compares
#         against the proxy limit.
#   C3    subnets in three AZs, cache with automatic failover, Aurora with 3 instances: no finding.
#   C5    ALB idle_timeout 30 s with no known backend timeout: no finding.
#   C9    Route 53 request_interval 30 x failure_threshold 3 = 90 s: not over 90, no finding.
#   C4    no scaling policy on the ASG (min = max = 6): only "the most rps it can take" (info).
#   C1    6 instances x DB_POOL_SIZE: user_data references other resources, so the plan has no value
#         for it and the pool is the estimate.

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
    autoscaling = "http://127.0.0.1:1"
    cloudfront  = "http://127.0.0.1:1"
    ec2         = "http://127.0.0.1:1"
    elasticache = "http://127.0.0.1:1"
    elbv2       = "http://127.0.0.1:1"
    iam         = "http://127.0.0.1:1"
    rds         = "http://127.0.0.1:1"
    route53     = "http://127.0.0.1:1"
    secretsmanager = "http://127.0.0.1:1"
    sts         = "http://127.0.0.1:1"
  }
}

variable "db_password" {
  type      = string
  sensitive = true
  default   = "fixture-fake-db-password-DO-NOT-LEAK"
}

variable "zone_id" {
  type    = string
  default = "Z0FIXTUREZONE"
}

resource "aws_vpc" "main" {
  cidr_block = "10.2.0.0/16"
}

resource "aws_subnet" "az" {
  for_each          = { a = "10.2.1.0/24", b = "10.2.2.0/24", c = "10.2.3.0/24" }
  vpc_id            = aws_vpc.main.id
  cidr_block        = each.value
  availability_zone = "us-east-1${each.key}"
}

resource "aws_security_group" "alb" {
  name   = "alb"
  vpc_id = aws_vpc.main.id
}

resource "aws_security_group" "app" {
  name   = "app"
  vpc_id = aws_vpc.main.id
  ingress {
    from_port       = 8080
    to_port         = 8080
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }
}

resource "aws_security_group" "data" {
  name   = "data"
  vpc_id = aws_vpc.main.id
  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.app.id]
  }
  ingress {
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [aws_security_group.app.id]
  }
}

# --- Data ---

resource "aws_rds_cluster" "main" {
  cluster_identifier     = "main"
  engine                 = "aurora-postgresql"
  master_username        = "app"
  master_password        = var.db_password
  vpc_security_group_ids = [aws_security_group.data.id]
  skip_final_snapshot    = true
}

resource "aws_rds_cluster_instance" "main" {
  count              = 3
  identifier         = "main-${count.index}"
  cluster_identifier = aws_rds_cluster.main.id
  engine             = aws_rds_cluster.main.engine
  instance_class     = "db.r6g.large"
}

resource "aws_secretsmanager_secret" "db" {
  name = "db"
}

resource "aws_iam_role" "proxy" {
  name = "proxy"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = "sts:AssumeRole", Principal = { Service = "rds.amazonaws.com" } }]
  })
}

resource "aws_db_proxy" "main" {
  name                   = "main"
  engine_family          = "POSTGRESQL"
  role_arn               = aws_iam_role.proxy.arn
  vpc_subnet_ids         = [for s in aws_subnet.az : s.id]
  vpc_security_group_ids = [aws_security_group.data.id]
  auth {
    auth_scheme = "SECRETS"
    secret_arn  = aws_secretsmanager_secret.db.arn
  }
}

resource "aws_db_proxy_default_target_group" "main" {
  db_proxy_name = aws_db_proxy.main.name
  connection_pool_config {
    max_connections_percent = 50
  }
}

resource "aws_db_proxy_target" "main" {
  db_proxy_name         = aws_db_proxy.main.name
  target_group_name     = aws_db_proxy_default_target_group.main.name
  db_cluster_identifier = aws_rds_cluster.main.id
}

resource "aws_elasticache_subnet_group" "main" {
  name       = "main"
  subnet_ids = [for s in aws_subnet.az : s.id]
}

resource "aws_elasticache_replication_group" "cache" {
  replication_group_id       = "cache"
  description                = "session and page cache"
  engine                     = "redis"
  node_type                  = "cache.r6g.large"
  num_cache_clusters         = 2
  automatic_failover_enabled = true
  multi_az_enabled           = true
  subnet_group_name          = aws_elasticache_subnet_group.main.name
  security_group_ids         = [aws_security_group.data.id]
}

# --- App tier ---

resource "aws_launch_template" "app" {
  name_prefix   = "app-"
  image_id      = "ami-0fixture000000000"
  instance_type = "c6g.xlarge"
  # References to resources: presumed lines app -> proxy and app -> cache.
  user_data = base64encode(join("\n", [
    "DB_HOST=${aws_db_proxy.main.endpoint}",
    "CACHE_HOST=${aws_elasticache_replication_group.cache.primary_endpoint_address}",
    "DB_POOL_SIZE=20",
  ]))
  vpc_security_group_ids = [aws_security_group.app.id]
}

resource "aws_lb" "web" {
  name               = "web"
  load_balancer_type = "application"
  subnets            = [for s in aws_subnet.az : s.id]
  security_groups    = [aws_security_group.alb.id]
  idle_timeout       = 30
}

resource "aws_lb_target_group" "app" {
  name     = "app"
  port     = 8080
  protocol = "HTTP"
  vpc_id   = aws_vpc.main.id
  health_check {
    path                = "/health"
    interval            = 10
    unhealthy_threshold = 2
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.web.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }
}

resource "aws_autoscaling_group" "app" {
  name                      = "app"
  min_size                  = 6
  max_size                  = 6
  desired_capacity          = 6
  vpc_zone_identifier       = [for s in aws_subnet.az : s.id]
  target_group_arns         = [aws_lb_target_group.app.arn]
  health_check_type         = "ELB"
  health_check_grace_period = 90
  launch_template {
    id      = aws_launch_template.app.id
    version = "$Latest"
  }
}

# --- Edge ---

resource "aws_cloudfront_distribution" "web" {
  enabled = true
  origin {
    domain_name = aws_lb.web.dns_name
    origin_id   = "alb"
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "http-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }
  default_cache_behavior {
    target_origin_id       = "alb"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods         = ["GET", "HEAD"]
    min_ttl                = 0
    default_ttl            = 60
    max_ttl                = 300
    forwarded_values {
      query_string = true
      cookies {
        forward = "all"
      }
    }
  }
  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }
  viewer_certificate {
    cloudfront_default_certificate = true
  }
}

resource "aws_route53_health_check" "web" {
  fqdn              = aws_cloudfront_distribution.web.domain_name
  type              = "HTTPS"
  port              = 443
  resource_path     = "/health"
  request_interval  = 30
  failure_threshold = 3
}

resource "aws_route53_record" "primary" {
  zone_id         = var.zone_id
  name            = "app.example.invalid"
  type            = "CNAME"
  ttl             = 60
  records         = [aws_cloudfront_distribution.web.domain_name]
  set_identifier  = "primary"
  health_check_id = aws_route53_health_check.web.id
  failover_routing_policy {
    type = "PRIMARY"
  }
}
