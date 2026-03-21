import { Pool } from 'pg';

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    const url = process.env.DB_URL;
    if (!url && process.env.NODE_ENV === 'production') {
      throw new Error('DB_URL must be set in production');
    }
    pool = new Pool({
      connectionString: url || 'postgresql://agent:agentpass@localhost:5432/agent_exchange',
    });
  }
  return pool;
}
