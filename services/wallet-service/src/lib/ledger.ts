import { PoolClient } from 'pg';
import { getPool } from './db';
import { getRedis } from './redis';

export interface AgentRow {
  id: number;
  wallet_address: string;
  score: number;
  is_active: boolean;
  is_blacklisted: boolean;
}

export interface BalanceRow {
  agent_id: number;
  usdc_balance: string;
  usdc_locked: string;
  eth_balance: string;
  eth_locked: string;
  updated_at: Date;
}

async function invalidateBalanceCache(walletAddress: string): Promise<void> {
  const redis = getRedis();
  await redis.del(`balance:wallet:${walletAddress.toLowerCase()}`);
}

export async function getOrCreateAgent(walletAddress: string): Promise<AgentRow> {
  const pool = getPool();
  const addr = walletAddress.toLowerCase();

  // Try read first (fast path)
  const existing = await pool.query<AgentRow>(
    'SELECT id, wallet_address, score, is_active, is_blacklisted FROM agents WHERE wallet_address = $1',
    [addr]
  );
  if (existing.rows.length > 0) return existing.rows[0];

  // Create with balance row inside a transaction
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');
    const agentResult = await client.query<AgentRow>(
      `INSERT INTO agents (wallet_address, score, is_active, is_blacklisted)
       VALUES ($1, 100, true, false)
       ON CONFLICT (wallet_address) DO UPDATE SET wallet_address = EXCLUDED.wallet_address
       RETURNING id, wallet_address, score, is_active, is_blacklisted`,
      [addr]
    );
    const agent = agentResult.rows[0];
    await client.query(
      `INSERT INTO balances (agent_id, usdc_balance, usdc_locked, eth_balance, eth_locked)
       VALUES ($1, 0, 0, 0, 0)
       ON CONFLICT (agent_id) DO NOTHING`,
      [agent.id]
    );
    await client.query('COMMIT');
    return agent;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function getBalance(walletAddress: string): Promise<BalanceRow | null> {
  const pool = getPool();
  const result = await pool.query<BalanceRow>(
    `SELECT b.agent_id, b.usdc_balance, b.usdc_locked, b.eth_balance, b.eth_locked, b.updated_at
     FROM balances b
     JOIN agents a ON a.id = b.agent_id
     WHERE a.wallet_address = $1`,
    [walletAddress.toLowerCase()]
  );
  return result.rows[0] || null;
}

export async function creditBalance(
  walletAddress: string,
  amount: string,
  asset: 'usdc' | 'eth'
): Promise<void> {
  const pool = getPool();
  const agent = await getOrCreateAgent(walletAddress);
  const col = asset === 'usdc' ? 'usdc_balance' : 'eth_balance';
  await pool.query(
    `UPDATE balances SET ${col} = ${col} + $1, updated_at = NOW() WHERE agent_id = $2`,
    [amount, agent.id]
  );
  await invalidateBalanceCache(walletAddress);
}

export async function lockBalance(walletAddress: string, usdcAmount: string): Promise<void> {
  const pool = getPool();
  const agent = await getOrCreateAgent(walletAddress);
  const result = await pool.query(
    `UPDATE balances
     SET usdc_balance = usdc_balance - $1,
         usdc_locked  = usdc_locked  + $1,
         updated_at   = NOW()
     WHERE agent_id = $2 AND usdc_balance >= $1
     RETURNING agent_id`,
    [usdcAmount, agent.id]
  );
  if ((result.rowCount ?? 0) === 0) throw new Error('Insufficient USDC balance');
  await invalidateBalanceCache(walletAddress);
}

export async function unlockBalance(walletAddress: string, usdcAmount: string): Promise<void> {
  const pool = getPool();
  const agent = await getOrCreateAgent(walletAddress);
  await pool.query(
    `UPDATE balances
     SET usdc_locked  = usdc_locked  - $1,
         usdc_balance = usdc_balance + $1,
         updated_at   = NOW()
     WHERE agent_id = $2`,
    [usdcAmount, agent.id]
  );
  await invalidateBalanceCache(walletAddress);
}

export async function debitLocked(walletAddress: string, usdcAmount: string): Promise<void> {
  const pool = getPool();
  const agent = await getOrCreateAgent(walletAddress);
  await pool.query(
    `UPDATE balances
     SET usdc_locked = usdc_locked - $1,
         updated_at  = NOW()
     WHERE agent_id = $2`,
    [usdcAmount, agent.id]
  );
  await invalidateBalanceCache(walletAddress);
}

export async function unlockEthBalance(walletAddress: string, ethAmount: string): Promise<void> {
  const pool = getPool();
  const agent = await getOrCreateAgent(walletAddress);
  await pool.query(
    `UPDATE balances
     SET eth_locked  = eth_locked  - $1,
         eth_balance = eth_balance + $1,
         updated_at  = NOW()
     WHERE agent_id = $2`,
    [ethAmount, agent.id]
  );
  await invalidateBalanceCache(walletAddress);
}

export async function debitLockedEth(walletAddress: string, ethAmount: string): Promise<void> {
  const pool = getPool();
  const agent = await getOrCreateAgent(walletAddress);
  await pool.query(
    `UPDATE balances
     SET eth_locked = eth_locked - $1,
         updated_at = NOW()
     WHERE agent_id = $2`,
    [ethAmount, agent.id]
  );
  await invalidateBalanceCache(walletAddress);
}

/**
 * Settle a trade atomically in a single DB transaction.
 * All 4 balance mutations (buyer debit locked, buyer credit ETH,
 * seller debit locked ETH, seller credit USDC) succeed or fail together.
 */
export async function settleTradeTransaction(
  buyerWallet: string,
  sellerWallet: string,
  usdcTotal: string,
  ethAmount: string,
  fee: string,
  platformWallet: string | undefined,
): Promise<void> {
  const pool = getPool();
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');

    // Buyer: consume locked USDC, credit ETH received
    await client.query(
      `UPDATE balances b SET usdc_locked = usdc_locked - $1, updated_at = NOW()
       FROM agents a WHERE a.id = b.agent_id AND a.wallet_address = $2`,
      [usdcTotal, buyerWallet.toLowerCase()]
    );
    await client.query(
      `UPDATE balances b SET eth_balance = eth_balance + $1, updated_at = NOW()
       FROM agents a WHERE a.id = b.agent_id AND a.wallet_address = $2`,
      [ethAmount, buyerWallet.toLowerCase()]
    );

    // Seller: consume locked ETH, credit USDC net of fee
    await client.query(
      `UPDATE balances b SET eth_locked = eth_locked - $1, updated_at = NOW()
       FROM agents a WHERE a.id = b.agent_id AND a.wallet_address = $2`,
      [ethAmount, sellerWallet.toLowerCase()]
    );
    const netUsdc = (parseFloat(usdcTotal) - parseFloat(fee)).toFixed(6);
    await client.query(
      `UPDATE balances b SET usdc_balance = usdc_balance + $1, updated_at = NOW()
       FROM agents a WHERE a.id = b.agent_id AND a.wallet_address = $2`,
      [netUsdc, sellerWallet.toLowerCase()]
    );

    // Platform fee
    if (platformWallet && parseFloat(fee) > 0) {
      await client.query(
        `INSERT INTO agents (wallet_address, score, is_active, is_blacklisted)
         VALUES ($1, 100, true, false) ON CONFLICT (wallet_address) DO NOTHING`,
        [platformWallet.toLowerCase()]
      );
      await client.query(
        `INSERT INTO balances (agent_id, usdc_balance, usdc_locked, eth_balance, eth_locked)
         SELECT id, 0, 0, 0, 0 FROM agents WHERE wallet_address = $1
         ON CONFLICT (agent_id) DO NOTHING`,
        [platformWallet.toLowerCase()]
      );
      await client.query(
        `UPDATE balances b SET usdc_balance = usdc_balance + $1, updated_at = NOW()
         FROM agents a WHERE a.id = b.agent_id AND a.wallet_address = $2`,
        [fee, platformWallet.toLowerCase()]
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await Promise.all([
      invalidateBalanceCache(buyerWallet),
      invalidateBalanceCache(sellerWallet),
    ]);
  }
}
