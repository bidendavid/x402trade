import { Router, Request, Response } from 'express';
import { getPool } from '../lib/db';
import { getRedis } from '../lib/redis';

const router = Router();

router.get('/balance', async (req: Request, res: Response) => {
  const agentWallet = req.agentWallet;
  if (!agentWallet) {
    res.status(401).json({ error: 'No agent wallet in request' });
    return;
  }

  const redis = getRedis();
  const pool = getPool();
  const cacheKey = `balance:wallet:${agentWallet.toLowerCase()}`;

  try {
    // Redis cache first (10s TTL)
    const cached = await redis.hgetall(cacheKey);
    if (cached && cached.usdc_balance) {
      res.json({
        wallet: agentWallet,
        usdc_balance: cached.usdc_balance,
        usdc_locked: cached.usdc_locked || '0',
        eth_balance: cached.eth_balance || '0',
        eth_locked: cached.eth_locked || '0',
        updated_at: cached.updated_at,
      });
      return;
    }

    const result = await pool.query(
      `SELECT b.usdc_balance, b.usdc_locked, b.eth_balance, b.eth_locked, b.updated_at
       FROM balances b
       JOIN agents a ON a.id = b.agent_id
       WHERE a.wallet_address = $1`,
      [agentWallet.toLowerCase()]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Agent not found. Deposit to register.' });
      return;
    }

    const row = result.rows[0];

    await redis.hset(cacheKey, {
      usdc_balance: row.usdc_balance,
      usdc_locked: row.usdc_locked,
      eth_balance: row.eth_balance,
      eth_locked: row.eth_locked,
      updated_at: row.updated_at?.toISOString() || '',
    });
    await redis.expire(cacheKey, 10);

    res.json({
      wallet: agentWallet,
      usdc_balance: row.usdc_balance,
      usdc_locked: row.usdc_locked,
      eth_balance: row.eth_balance,
      eth_locked: row.eth_locked,
      updated_at: row.updated_at,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to read balance', message: (err as Error).message });
  }
});

export default router;
