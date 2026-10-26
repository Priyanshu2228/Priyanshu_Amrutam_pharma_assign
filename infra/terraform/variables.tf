variable "environment" {
  type    = string
  default = "production"
}

variable "region" {
  type    = string
  default = "ap-south-1" # Mumbai: keeps Indian health data in-country (DPDP Act)
}

variable "dr_region" {
  type    = string
  default = "ap-south-2" # Hyderabad
}

variable "vpc_cidr" {
  type    = string
  default = "10.40.0.0/16"
}

variable "image" {
  description = "Container image (immutable digest) built by CI"
  type        = string
}

variable "domain_certificate_arn" {
  description = "ACM certificate for the public API hostname"
  type        = string
}

variable "api_desired_count" {
  type    = number
  default = 3
}

variable "api_max_count" {
  type    = number
  default = 20
}

variable "worker_desired_count" {
  type    = number
  default = 2
}

variable "db_instance_class" {
  type    = string
  default = "db.r6g.xlarge"
}

variable "redis_node_type" {
  type    = string
  default = "cache.r7g.large"
}
