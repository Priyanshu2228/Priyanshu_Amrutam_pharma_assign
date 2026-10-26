# Data tier: KMS, PostgreSQL (Multi-AZ + read replica + PITR), Redis (Multi-AZ, TLS,
# AUTH), S3 for documents, Secrets Manager, and cross-region backup copies for DR.

data "aws_caller_identity" "current" {}

resource "aws_kms_key" "main" {
  description             = "${local.name} data encryption (RDS, Redis, S3, logs, secrets)"
  enable_key_rotation     = true # automatic yearly rotation of the CMK backing material
  deletion_window_in_days = 30
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AccountAdmin"
        Effect    = "Allow"
        Principal = { AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root" }
        Action    = "kms:*"
        Resource  = "*"
      },
      {
        Sid       = "CloudWatchLogs"
        Effect    = "Allow"
        Principal = { Service = "logs.${var.region}.amazonaws.com" }
        Action    = ["kms:Encrypt*", "kms:Decrypt*", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:Describe*"]
        Resource  = "*"
      }
    ]
  })
}

resource "aws_kms_alias" "main" {
  name          = "alias/${local.name}"
  target_key_id = aws_kms_key.main.key_id
}

# ------------------------------------------------------------------ PostgreSQL
resource "aws_db_subnet_group" "main" {
  name       = local.name
  subnet_ids = aws_subnet.data[*].id
}

resource "aws_db_parameter_group" "pg16" {
  name   = "${local.name}-pg16"
  family = "postgres16"
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
  parameter {
    name  = "log_min_duration_statement"
    value = "200"
  }
  parameter {
    name         = "shared_preload_libraries"
    value        = "pg_stat_statements"
    apply_method = "pending-reboot"
  }
  parameter {
    name  = "idle_in_transaction_session_timeout"
    value = "30000"
  }
}

resource "aws_db_instance" "primary" {
  identifier                            = "${local.name}-pg"
  engine                                = "postgres"
  engine_version                        = "16.6"
  instance_class                        = var.db_instance_class
  allocated_storage                     = 200
  max_allocated_storage                 = 2000
  storage_type                          = "gp3"
  storage_encrypted                     = true
  kms_key_id                            = aws_kms_key.main.arn
  db_name                               = "amrutam"
  username                              = "amrutam_admin"
  manage_master_user_password           = true # rotated by Secrets Manager
  master_user_secret_kms_key_id         = aws_kms_key.main.arn
  multi_az                              = true # synchronous standby in another AZ, automatic failover
  db_subnet_group_name                  = aws_db_subnet_group.main.name
  vpc_security_group_ids                = [aws_security_group.db.id]
  parameter_group_name                  = aws_db_parameter_group.pg16.name
  backup_retention_period               = 35 # point-in-time recovery window
  backup_window                         = "20:00-21:00" # 01:30-02:30 IST
  maintenance_window                    = "sun:21:30-sun:22:30"
  copy_tags_to_snapshot                 = true
  deletion_protection                   = true
  skip_final_snapshot                   = false
  final_snapshot_identifier             = "${local.name}-pg-final"
  performance_insights_enabled          = true
  performance_insights_kms_key_id       = aws_kms_key.main.arn
  performance_insights_retention_period = 7
  monitoring_interval                   = 30
  monitoring_role_arn                   = aws_iam_role.rds_monitoring.arn
  enabled_cloudwatch_logs_exports       = ["postgresql"]
  auto_minor_version_upgrade            = true
  iam_database_authentication_enabled   = true
}

# Read replica for search and analytics traffic (DATABASE_REPLICA_URL).
resource "aws_db_instance" "replica" {
  identifier                   = "${local.name}-pg-replica"
  replicate_source_db          = aws_db_instance.primary.identifier
  instance_class               = var.db_instance_class
  storage_encrypted            = true
  kms_key_id                   = aws_kms_key.main.arn
  vpc_security_group_ids       = [aws_security_group.db.id]
  parameter_group_name         = aws_db_parameter_group.pg16.name
  performance_insights_enabled = true
  skip_final_snapshot          = true
}

resource "aws_iam_role" "rds_monitoring" {
  name = "${local.name}-rds-monitoring"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "monitoring.rds.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "rds_monitoring" {
  role       = aws_iam_role.rds_monitoring.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"
}

# ------------------------------------------------------------------ Redis
resource "aws_elasticache_subnet_group" "main" {
  name       = local.name
  subnet_ids = aws_subnet.data[*].id
}

resource "random_password" "redis_auth" {
  length  = 48
  special = false
}

resource "aws_elasticache_replication_group" "main" {
  replication_group_id       = "${local.name}-redis"
  description                = "Cache, rate limits, session denylist, BullMQ"
  engine                     = "redis"
  engine_version             = "7.1"
  node_type                  = var.redis_node_type
  num_cache_clusters         = 3
  automatic_failover_enabled = true
  multi_az_enabled           = true
  subnet_group_name          = aws_elasticache_subnet_group.main.name
  security_group_ids         = [aws_security_group.redis.id]
  at_rest_encryption_enabled = true
  kms_key_id                 = aws_kms_key.main.arn
  transit_encryption_enabled = true
  auth_token                 = random_password.redis_auth.result
  snapshot_retention_limit   = 7
  # BullMQ requires keys never be evicted.
  parameter_group_name = aws_elasticache_parameter_group.redis.name
}

resource "aws_elasticache_parameter_group" "redis" {
  name   = "${local.name}-redis7"
  family = "redis7"
  parameter {
    name  = "maxmemory-policy"
    value = "noeviction"
  }
}

# ------------------------------------------------------------------ documents (S3)
resource "aws_s3_bucket" "documents" {
  bucket = "${local.name}-documents-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_public_access_block" "documents" {
  bucket                  = aws_s3_bucket.documents.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "documents" {
  bucket = aws_s3_bucket.documents.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.main.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_versioning" "documents" {
  bucket = aws_s3_bucket.documents.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_policy" "documents_tls_only" {
  bucket = aws_s3_bucket.documents.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [aws_s3_bucket.documents.arn, "${aws_s3_bucket.documents.arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
}

# ------------------------------------------------------------------ application secrets
# Values are set out-of-band (never in Terraform state): JWT secret, field-encryption
# keyring, audit HMAC key, payment webhook secret.
resource "aws_secretsmanager_secret" "app" {
  for_each   = toset(["JWT_ACCESS_SECRET", "FIELD_ENCRYPTION_KEYS", "AUDIT_HMAC_KEY", "PAYMENT_WEBHOOK_SECRET", "REDIS_URL", "DATABASE_URL", "DATABASE_REPLICA_URL"])
  name       = "${local.name}/${each.key}"
  kms_key_id = aws_kms_key.main.arn
}

# ------------------------------------------------------------------ backups / DR
resource "aws_backup_vault" "primary" {
  name        = "${local.name}-vault"
  kms_key_arn = aws_kms_key.main.arn
}

resource "aws_kms_key" "dr" {
  provider            = aws.dr
  description         = "${local.name} DR backup encryption"
  enable_key_rotation = true
}

resource "aws_backup_vault" "dr" {
  provider    = aws.dr
  name        = "${local.name}-vault-dr"
  kms_key_arn = aws_kms_key.dr.arn
}

resource "aws_backup_plan" "main" {
  name = "${local.name}-backup"
  rule {
    rule_name         = "daily"
    target_vault_name = aws_backup_vault.primary.name
    schedule          = "cron(30 21 * * ? *)"
    lifecycle { delete_after = 35 }
    copy_action {
      destination_vault_arn = aws_backup_vault.dr.arn
      lifecycle { delete_after = 35 }
    }
  }
  rule {
    rule_name         = "monthly-compliance"
    target_vault_name = aws_backup_vault.primary.name
    schedule          = "cron(0 22 1 * ? *)"
    lifecycle {
      cold_storage_after = 30
      delete_after       = 2555 # ~7 years medical-record retention
    }
  }
}

resource "aws_backup_selection" "main" {
  name         = "${local.name}-selection"
  plan_id      = aws_backup_plan.main.id
  iam_role_arn = aws_iam_role.backup.arn
  resources    = [aws_db_instance.primary.arn, aws_s3_bucket.documents.arn]
}

resource "aws_iam_role" "backup" {
  name = "${local.name}-backup"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "backup.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "backup" {
  for_each = toset([
    "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup",
    "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForRestores",
    "arn:aws:iam::aws:policy/AWSBackupServiceRolePolicyForS3Backup",
    "arn:aws:iam::aws:policy/AWSBackupServiceRolePolicyForS3Restore",
  ])
  role       = aws_iam_role.backup.name
  policy_arn = each.value
}
