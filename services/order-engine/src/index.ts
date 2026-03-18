import dotenv from 'dotenv';
import { connect, NatsConnection, StringCodec } from 'nats';
import { matchOrder } from './orderbook/matcher';
import { Order } from './types';

dotenv.config();

const sc = StringCodec();

async function main(): Promise<void> {
  let nc: NatsConnection;

  try {
    nc = await connect({ servers: process.env.NATS_URL || 'nats://localhost:4222' });
    console.log('order-engine connected to NATS');

    const sub = nc.subscribe('orders.new');
    console.log('order-engine subscribed to orders.new');

    for await (const msg of sub) {
      // Process each order concurrently but handle errors per-message
      (async () => {
        try {
          const payload = JSON.parse(sc.decode(msg.data)) as {
            orderId: string;
            agentWallet: string;
            pair: string;
            side: 'buy' | 'sell';
            type: 'limit' | 'market';
            amount: string;
            price: string;
            timestamp: number;
          };

          const order: Order = {
            orderId: payload.orderId,
            agentWallet: payload.agentWallet,
            pair: payload.pair,
            side: payload.side,
            type: payload.type,
            amount: payload.amount,
            price: payload.price,
            filledAmount: '0',
            status: 'pending',
            timestamp: payload.timestamp || Date.now(),
          };

          const result = await matchOrder(order);

          if (msg.reply) {
            msg.respond(sc.encode(JSON.stringify(result)));
          }
        } catch (err) {
          console.error('Error processing order:', err);
          if (msg.reply) {
            msg.respond(sc.encode(JSON.stringify({ error: (err as Error).message })));
          }
        }
      })();
    }
  } catch (err) {
    console.error('order-engine fatal error:', err);
    process.exit(1);
  }
}

main();
