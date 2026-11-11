# Fixture: a three-tier ECS service behind an ALB, with RDS (PostgreSQL).
# Only for `terraform plan` (scripts/gen-fixtures.sh), never `apply`: the credentials are fake and
# every endpoint points at 127.0.0.1:1. The plan runs in a sandbox that blocks outbound network.

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
    applicationautoscaling = "http://127.0.0.1:1"
    ec2                    = "http://127.0.0.1:1"
    ecs                    = "http://127.0.0.1:1"
    elbv2                  = "http://127.0.0.1:1"
    iam                    = "http://127.0.0.1:1"
    rds                    = "http://127.0.0.1:1"
    sts                    = "http://127.0.0.1:1"
  }
}

variable "db_password" {
  type      = string
  sensitive = true
  default   = "fixture-fake-db-password-DO-NOT-LEAK"
}

# A value that comes from outside the plan: the importer must not draw a line from it.
variable "payments_url" {
  type    = string
  default = "https://payments.example.invalid"
}

resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"
}

resource "aws_subnet" "a" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.0.1.0/24"
  availability_zone = "us-east-1a"
}

resource "aws_subnet" "b" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.0.2.0/24"
  availability_zone = "us-east-1b"
}

resource "aws_security_group" "alb" {
  name   = "alb"
  vpc_id = aws_vpc.main.id
  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
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

resource "aws_security_group" "db" {
  name   = "db"
  vpc_id = aws_vpc.main.id
  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.app.id]
  }
}

resource "aws_lb" "web" {
  name               = "web"
  load_balancer_type = "application"
  subnets            = [aws_subnet.a.id, aws_subnet.b.id]
  security_groups    = [aws_security_group.alb.id]
}

resource "aws_lb_target_group" "api" {
  name        = "api"
  port        = 8080
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.main.id
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.web.arn
  port              = 443
  protocol          = "HTTP"
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}

resource "aws_ecs_cluster" "main" {
  name = "main"
}

resource "aws_ecs_task_definition" "api" {
  family                   = "api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "1024"
  container_definitions = jsonencode([{
    name         = "api"
    image        = "example/api:1"
    portMappings = [{ containerPort = 8080 }]
    environment = [
      # References a resource: a presumed line from the service to the database.
      { name = "DB_HOST", value = aws_db_instance.main.address },
      # A fixed string and an outside variable: no line.
      { name = "CACHE_HOST", value = "cache.internal" },
      { name = "PAYMENTS_URL", value = var.payments_url },
    ]
  }])
}

resource "aws_ecs_service" "api" {
  name            = "api"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = 3
  launch_type     = "FARGATE"
  network_configuration {
    subnets         = [aws_subnet.a.id, aws_subnet.b.id]
    security_groups = [aws_security_group.app.id]
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = 8080
  }
}

resource "aws_appautoscaling_target" "api" {
  service_namespace  = "ecs"
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.api.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = 3
  # High enough that the pools of all tasks can pass the database limit (C1, C10).
  max_capacity       = 50
}

resource "aws_appautoscaling_policy" "api_cpu" {
  name               = "api-cpu"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.api.service_namespace
  resource_id        = aws_appautoscaling_target.api.resource_id
  scalable_dimension = aws_appautoscaling_target.api.scalable_dimension
  target_tracking_scaling_policy_configuration {
    target_value = 60
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}

resource "aws_db_subnet_group" "main" {
  name       = "main"
  subnet_ids = [aws_subnet.a.id, aws_subnet.b.id]
}

resource "aws_db_instance" "main" {
  identifier             = "main"
  engine                 = "postgres"
  instance_class         = "db.t3.medium"
  allocated_storage      = 50
  username               = "app"
  password               = var.db_password
  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.db.id]
  skip_final_snapshot    = true
}
