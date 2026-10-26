import '../setup-env';
import { Client } from 'pg';
import { migrate } from '../../src/db/migrate';

/** Rebuilds the test schema from migrations once per integration run. */
export default async function setup() {
  const url = process.env.DATABASE_URL!;
  const dbName = new URL(url).pathname.slice(1);
  if (!dbName.endsWith('_test')) {
    throw new Error(`Refusing to reset "${dbName}": integration tests only run against *_test databases`);
  }
  const client = new Client({ connectionString: url });
  try {
    await client.connect();
  } catch (err) {
    throw new Error(
      `Integration tests need PostgreSQL at ${url} and Redis at ${process.env.REDIS_URL}. ` +
        `Start them with "docker compose up -d postgres redis". (${(err as Error).message})`,
    );
  }
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await client.end();
  await migrate(url, () => undefined);
}
