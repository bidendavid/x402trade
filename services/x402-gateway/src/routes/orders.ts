import { Router, Request, Response } from 'express';
import { getPool } from '../lib/db';
import { isValidPair } from '../lib/validate';

const router = Router();

router.get('/orders', async (req: Request, res: Response) => {
  const pair = req.query.pair as string | undefined;
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
  const offset = parseInt(req.query.offset as string) || 0;
  const agentWallet = req.agentWallet;

  const pool = getPool();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (agentWallet) {
    params.push(agentWallet.toLowerCase());
    conditions.push(`a.wallet_address = $${params.length}`);
  }
  if (pair) {
    if (!isValidPair(pair)) {
      res.status(400).json({ error: 'Invalid pair' });
      return;
    }
    params.push(pair);
    conditions.push(`o.pair = $${params.length}`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(limit, offset);

  try {
    const result = await pool.query(
      `SELECT o.order_id, o.pair, o.side, o.order_type, o.amount, o.price,
              o.filled_amount, o.status, o.fee_usdc, o.created_at, o.filled_at
       FROM orders o
       JOIN agents a ON a.id = o.agent_id
       ${where}
       ORDER BY o.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json({ orders: result.rows, total: result.rowCount });
  } catch (err) {
    console.error('[orders] fetch error:', (err as Error).message);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

export default router;
