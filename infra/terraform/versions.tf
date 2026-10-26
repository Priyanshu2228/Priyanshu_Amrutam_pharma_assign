terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.70"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
  # Remote state with locking; bucket/table are bootstrapped once per account.
  backend "s3" {
    key            = "amrutam/telemed/terraform.tfstate"
    encrypt        = true
    dynamodb_table = "terraform-locks"
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = {
      Project     = "amrutam-telemed"
      Environment = var.environment
      ManagedBy   = "terraform"
      DataClass   = "phi"
    }
  }
}

# Disaster-recovery region for backup copies.
provider "aws" {
  alias  = "dr"
  region = var.dr_region
}
