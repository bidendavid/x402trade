import { Router, Request, Response } from 'express';
import { connect, NatsConnection, StringCodec } from 'nats';
import { randomUUID } from 'crypto';
import { ordersTotal, orderMatchDuration } from '../lib/metrics';

const router = Router();
const sc = StringCodec();
let nc: NatsConnection | null = null;

async function getNats(): Promise<NatsConnection> {
  if (!nc || nc.isClosed()) {
    nc = await connect({ servers: process.env.NATS_URL || 'nats://localhost:4222' });
  }
  return nc;
}

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
  if (type === 'limit' && !price) {
    res.status(400).json({ error: 'price is required for limit orders' });
    return;
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
