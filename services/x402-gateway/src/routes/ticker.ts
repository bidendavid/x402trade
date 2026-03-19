import { Router, Request, Response } from 'express';
import { getRedis } from '../lib/redis';
import { isValidPair } from '../lib/validate';

const router = Router();

router.get('/ticker', async (req: Request, res: Response) => {
  const pair = req.query.pair as string;
  if (!pair || !isValidPair(pair)) {
    res.status(400).json({ error: 'Invalid or missing pair', validPairs: ['ETH-USDC', 'BTC-USDC'] });
    return;
  }

  const redis = getRedis();
  const pk = pair.replace('/', '-');

  try {
    const [price, change24h, volume24h, high24h, low24h] = await Promise.all([
      redis.get(`price:${pk}`),
      redis.get(`change24h:${pk}`),
      redis.get(`volume24h:${pk}`),
      redis.get(`high24h:${pk}`),
      redis.get(`low24h:${pk}`),
    ]);

    res.json({
      pair,
      price: price || '0',
      change24h: change24h || '0',
      volume24h: volume24h || '0',
      high24h: high24h || '0',
      low24h: low24h || '0',
      timestamp: Date.now(),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to read ticker', message: (err as Error).message });
  }
});

router.get('/trades', async (req: Request, res: Response) => {
  const pair = req.query.pair as string;
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);

  if (!pair || !isValidPair(pair)) {
    res.status(400).json({ error: 'Invalid or missing pair', validPairs: ['ETH-USDC', 'BTC-USDC'] });
    return;
  }

  const redis = getRedis();
  const pk = pair.replace('/', '-');

  try {
    const raw = await redis.lrange(`trades:${pk}`, 0, limit - 1);
    const trades = raw.map((t) => JSON.parse(t));
    res.json({ pair, trades });
  } catch (err) {
    res.status(500).json({ error: 'Failed to read trades', message: (err as Error).message });
  }
});

export default router;
