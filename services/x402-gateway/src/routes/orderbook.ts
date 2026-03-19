import { Router, Request, Response } from 'express';
import { getRedis } from '../lib/redis';
import { isValidPair } from '../lib/validate';

const router = Router();

router.get('/orderbook', async (req: Request, res: Response) => {
  const pair = req.query.pair as string;
  const depth = Math.min(parseInt(req.query.depth as string) || 20, 100);

  if (!pair || !isValidPair(pair)) {
    res.status(400).json({ error: 'Invalid or missing pair', validPairs: ['ETH-USDC', 'BTC-USDC'] });
    return;
  }

  const redis = getRedis();
  const pk = pair.replace('/', '-');

  try {
    // bids: ZREVRANGE → highest price first; asks: ZRANGE → lowest price first
    // Members stored as "price:amount:orderId"
    const [bidMembers, askMembers] = await Promise.all([
      redis.zrevrange(`bids:${pk}`, 0, depth - 1),
      redis.zrange(`asks:${pk}`, 0, depth - 1),
    ]);

    // For each member, look up the order hash to get actual remaining amount
    const resolve = async (members: string[]): Promise<[string, string][]> => {
      const entries = await Promise.all(
        members.map(async (m) => {
          const parts = m.split(':');
          const price = parts[0];
          const origAmount = parts[1];
          const orderId = parts.slice(2).join(':');
          const order = await redis.hgetall(`order:${orderId}`);
          const remaining = order?.filledAmount
            ? (parseFloat(origAmount) - parseFloat(order.filledAmount)).toFixed(6)
            : origAmount;
          return [price, remaining] as [string, string];
        })
      );
      return entries.filter(([, rem]) => parseFloat(rem) > 0);
    };

    const [bids, asks] = await Promise.all([resolve(bidMembers), resolve(askMembers)]);

    res.json({ pair, bids, asks, timestamp: Date.now() });
  } catch (err) {
    res.status(500).json({ error: 'Failed to read order book', message: (err as Error).message });
  }
});

export default router;
