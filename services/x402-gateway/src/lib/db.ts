import { Pool } from 'pg';

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DB_URL || 'postgresql://agent:agentpass@localhost:5432/agent_exchange',
    });
  }
  return pool;
}
