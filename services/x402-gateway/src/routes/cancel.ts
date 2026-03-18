import { Router, Request, Response } from 'express';
import { connect, NatsConnection, StringCodec } from 'nats';
import { getPool } from '../lib/db';
import { getRedis } from '../lib/redis';

const router = Router();
const sc = StringCodec();
let nc: NatsConnection | null = null;

async function getNats(): Promise<NatsConnection> {
  if (!nc || nc.isClosed()) {
    nc = await connect({ servers: process.env.NATS_URL || 'nats://localhost:4222' });
  }
  return nc;
}

router.delete('/orders/:orderId', async (req: Request, res: Response) => {
  const { orderId } = req.params;
  const agentWallet = req.agentWallet;

  const pool = getPool();
  const redis = getRedis();

  try {
    // Verify order belongs to agent and is cancellable
    const result = await pool.query(
      `SELECT o.order_id, o.pair, o.side, o.order_type, o.amount, o.price, o.filled_amount, o.status,
              a.wallet_address
       FROM orders o
       JOIN agents a ON a.id = o.agent_id
       WHERE o.order_id = $1`,
      [orderId]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }

    const order = result.rows[0] as {
      order_id: string; pair: string; side: string; order_type: string;
      amount: string; price: string; filled_amount: string; status: string;
      wallet_address: string;
    };

    if (agentWallet && order.wallet_address !== agentWallet.toLowerCase()) {
      res.status(403).json({ error: 'Not your order' });
      return;
    }

    if (!['pending', 'partial'].includes(order.status)) {
      res.status(400).json({ error: `Cannot cancel order with status: ${order.status}` });
      return;
    }

    // Mark cancelled in DB
    await pool.query(
      `UPDATE orders SET status = 'cancelled', updated_at = NOW() WHERE order_id = $1`,
      [orderId]
    );

    // Remove from Redis order book
    const pk = order.pair.replace('/', '-');
    const remaining = (parseFloat(order.amount) - parseFloat(order.filled_amount || '0')).toFixed(6);
    const member = `${order.price}:${order.amount}:${order.order_id}`;

    if (order.side === 'buy') {
      await redis.zrem(`bids:${pk}`, member);
    } else {
      await redis.zrem(`asks:${pk}`, member);
    }
    await redis.del(`order:${orderId}`);
    await redis.srem(`agent:pending:${order.wallet_address}`, orderId);

    // Unlock balance via NATS
    try {
      const natsConn = await getNats();
      natsConn.publish('orders.cancelled', sc.encode(JSON.stringify({
        orderId,
        agentWallet: order.wallet_address,
        side: order.side,
        remainingAmount: remaining,
        price: order.price,
      })));
    } catch { /* non-fatal */ }

    res.json({ success: true, orderId, status: 'cancelled', remainingAmount: remaining });
  } catch (err) {
    res.status(500).json({ error: 'Cancel failed', message: (err as Error).message });
  }
});

export default router;
