import { Router, Request, Response } from 'express';
import { connect, NatsConnection, StringCodec } from 'nats';
import { randomUUID } from 'crypto';
import { ordersTotal, orderMatchDuration } from '../lib/metrics';
import { isValidPair } from '../lib/validate';

const router = Router();
const sc = StringCodec();
let nc: NatsConnection | null = null;

async function getNats(): Promise<NatsConnection> {
  if (!nc || nc.isClosed()) {
    nc = await connect({ servers: process.env.NATS_URL || 'nats://localhost:4222' });
  }
  return nc;
}

const MAX_ORDER_AMOUNT = 1000;   // max base token per order
const MAX_ORDER_PRICE  = 1_000_000; // max USDC per base token

router.post('/trade', async (req: Request, res: Response) => {
  const { pair, side, type, amount, price } = req.body as {
    pair: string;
    side: 'buy' | 'sell';
    type: 'limit' | 'market';
    amount: string;
    price?: string;
  };

  if (!pair || !side || !type || !amount) {
    res.status(400).json({ error: 'Missing required fields: pair, side, type, amount' });
    return;
  }
  if (!isValidPair(pair)) {
    res.status(400).json({ error: 'Invalid trading pair', validPairs: ['ETH-USDC', 'BTC-USDC'] });
    return;
  }
  if (!['buy', 'sell'].includes(side)) {
    res.status(400).json({ error: 'side must be "buy" or "sell"' });
    return;
  }
  if (!['limit', 'market'].includes(type)) {
    res.status(400).json({ error: 'type must be "limit" or "market"' });
    return;
  }
  const amountNum = parseFloat(amount);
  if (isNaN(amountNum) || amountNum <= 0 || amountNum > MAX_ORDER_AMOUNT) {
    res.status(400).json({ error: `amount must be a positive number ≤ ${MAX_ORDER_AMOUNT}` });
    return;
  }
  if (type === 'limit') {
    if (!price) {
      res.status(400).json({ error: 'price is required for limit orders' });
      return;
    }
    const priceNum = parseFloat(price);
    if (isNaN(priceNum) || priceNum <= 0 || priceNum > MAX_ORDER_PRICE) {
      res.status(400).json({ error: `price must be a positive number ≤ ${MAX_ORDER_PRICE}` });
      return;
    }
  }

  const payload = {
    orderId: randomUUID(),
    agentWallet: req.agentWallet || 'unknown',
    pair,
    side,
    type,
    amount,
    price: type === 'market' ? '0' : price,
    timestamp: Date.now(),
  };

  try {
    const natsConn = await getNats();
    const endMatch = orderMatchDuration.startTimer();
    const reply = await natsConn.request('orders.new', sc.encode(JSON.stringify(payload)), { timeout: 5000 });
    const result = JSON.parse(sc.decode(reply.data)) as { status: string };
    endMatch();
    ordersTotal.inc({ side: payload.side, type: payload.type, status: result.status ?? 'unknown' });
    res.json(result);
  } catch (err) {
    ordersTotal.inc({ side: payload.side, type: payload.type, status: 'error' });
    res.status(503).json({ error: 'Order engine unavailable', message: (err as Error).message });
  }
});

export default router;
