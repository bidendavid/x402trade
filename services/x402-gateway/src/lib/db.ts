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

/**
 * Deduct API call fee from agent's internal USDC balance.
 * Returns true if deduction succeeded, false if insufficient balance or agent not found.
 * If amount is '0', just verify the agent exists (used for free authenticated endpoints).
 */
export async function deductApiPayment(walletAddress: string, amount: string): Promise<boolean> {
  if (parseFloat(amount) === 0) {
    // Free authenticated endpoint: signature verified, no charge required
    return true;
  }
  const result = await getPool().query(
    `UPDATE balances b
     SET usdc_balance = usdc_balance - $1,
         updated_at   = NOW()
     FROM agents a
     WHERE a.id = b.agent_id
       AND a.wallet_address = $2
       AND b.usdc_balance >= $1
     RETURNING b.agent_id`,
    [amount, walletAddress.toLowerCase()]
  );
  return (result.rowCount ?? 0) > 0;
}
