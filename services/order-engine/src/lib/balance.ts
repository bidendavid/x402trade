/**
 * Balance locking for order placement.
 * Writes directly to the shared PostgreSQL balances table.
 * - Buy order: lock usdcAmount = amount * price
 * - Sell order: lock ethAmount = amount
 */
import { getPool } from './db';
import { getRedis } from './redis';

async function invalidateCache(walletAddress: string): Promise<void> {
  await getRedis().del(`balance:wallet:${walletAddress.toLowerCase()}`);
}

export async function lockForBuy(wallet: string, usdcAmount: string): Promise<void> {
  const pool = getPool();
  const result = await pool.query(
    `UPDATE balances b
     SET usdc_balance = usdc_balance - $1,
         usdc_locked  = usdc_locked  + $1,
         updated_at   = NOW()
     FROM agents a
     WHERE a.id = b.agent_id
       AND a.wallet_address = $2
       AND b.usdc_balance >= $1
     RETURNING b.agent_id`,
    [usdcAmount, wallet.toLowerCase()]
  );
  if ((result.rowCount ?? 0) === 0) {
    // Insufficient balance — not a fatal error for market orders, just warn
    console.warn(`[balance] Could not lock ${usdcAmount} USDC for ${wallet} (insufficient or agent not found)`);
  }
  await invalidateCache(wallet);
}

export async function lockForSell(wallet: string, ethAmount: string): Promise<void> {
  const pool = getPool();
  const result = await pool.query(
    `UPDATE balances b
     SET eth_balance = eth_balance - $1,
         eth_locked  = eth_locked  + $1,
         updated_at  = NOW()
     FROM agents a
     WHERE a.id = b.agent_id
       AND a.wallet_address = $2
       AND b.eth_balance >= $1
     RETURNING b.agent_id`,
    [ethAmount, wallet.toLowerCase()]
  );
  if ((result.rowCount ?? 0) === 0) {
    console.warn(`[balance] Could not lock ${ethAmount} ETH for ${wallet}`);
  }
  await invalidateCache(wallet);
}

export async function unlockForCancel(wallet: string, usdcAmount: string, ethAmount: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE balances b
     SET usdc_balance = usdc_balance + $1,
         usdc_locked  = GREATEST(0, usdc_locked  - $1),
         eth_balance  = eth_balance  + $2,
         eth_locked   = GREATEST(0, eth_locked   - $2),
         updated_at   = NOW()
     FROM agents a
     WHERE a.id = b.agent_id
       AND a.wallet_address = $3`,
    [usdcAmount, ethAmount, wallet.toLowerCase()]
  );
  await invalidateCache(wallet);
}
