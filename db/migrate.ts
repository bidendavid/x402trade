/**
 * Database migration runner.
 * Usage: npx ts-node db/migrate.ts
 * Reads DB_URL from environment (or .env at project root).
 */
import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const pool = new Pool({
  connectionString: process.env.DB_URL || 'postgresql://agent:agentpass@localhost:5432/agent_exchange',
});

async function migrate(): Promise<void> {
  const migrationsDir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  console.log(`Running ${files.length} migration(s)...`);

  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    console.log(`  Applying: ${file}`);
    await pool.query(sql);
    console.log(`  Done: ${file}`);
  }

  console.log('All migrations applied.');
  await pool.end();
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
