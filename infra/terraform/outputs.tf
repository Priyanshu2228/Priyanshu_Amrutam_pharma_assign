output "alb_dns_name" {
  value = aws_lb.api.dns_name
}

output "db_primary_endpoint" {
  value = aws_db_instance.primary.address
}

output "db_replica_endpoint" {
  value = aws_db_instance.replica.address
}

output "redis_primary_endpoint" {
  value = aws_elasticache_replication_group.main.primary_endpoint_address
}

output "documents_bucket" {
  value = aws_s3_bucket.documents.bucket
}

output "ecs_cluster" {
  value = aws_ecs_cluster.main.name
}
