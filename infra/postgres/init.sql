-- Runs once when the local Postgres volume is created: a separate database for tests.
CREATE DATABASE amrutam_test OWNER amrutam;
\c amrutam
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
