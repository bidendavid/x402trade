import dotenv from 'dotenv';
import express, { Request, Response } from 'express';
import { Registry, collectDefaultMetrics, Counter, Histogram } from 'prom-client';
import { connect, NatsConnection, StringCodec } from 'nats';
import balanceRouter from './routes/balance';
import depositRouter from './routes/deposit';
import withdrawRouter from './routes/withdraw';
import { settleTradeTransaction, unlockBalance, unlockEthBalance } from './lib/ledger';

dotenv.config();

const registry = new Registry();
collectDefaultMetrics({ register: registry });
export const depositsTotal = new Counter({ name: 'wallet_deposits_total', help: 'Total deposits processed', registers: [registry] });
export const withdrawalsTotal = new Counter({ name: 'wallet_withdrawals_total', help: 'Total withdrawals processed', registers: [registry] });
export const settlementDuration = new Histogram({ name: 'wallet_settlement_duration_seconds', help: 'Trade settlement duration', registers: [registry] });

const app = express();
app.use(express.json());

app.use(balanceRouter);
app.use(depositRouter);
app.use(withdrawRouter);

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'wallet-service' });
});

app.get('/metrics', async (_req: Request, res: Response) => {
  res.set('Content-Type', registry.contentType);
  res.end(await registry.metrics());
});

const PORT = process.env.WALLET_PORT || 8082;
app.listen(PORT, () => {
  console.log(`wallet-service listening on port ${PORT}`);
});

// Subscribe to trade fills and update balances
async function startNatsSubscriber(): Promise<void> {
  const sc = StringCodec();
  let nc: NatsConnection;

  try {
    nc = await connect({ servers: process.env.NATS_URL || 'nats://localhost:4222' });
    console.log('wallet-service NATS connected');

    const sub = nc.subscribe('trades.filled');
    const cancelSub = nc.subscribe('orders.cancelled');

    // Process trade fills
    (async () => {
      for await (const msg of sub) {
        try {
          const trade = JSON.parse(sc.decode(msg.data)) as {
            buyerWallet: string;
            sellerWallet: string;
            amount: string;
            usdcTotal: string;
            fee: string;
          };

          // Validate amounts before touching balances
          const usdcTotal = parseFloat(trade.usdcTotal);
          const ethAmount = parseFloat(trade.amount);
          const fee = parseFloat(trade.fee);
          if (!trade.buyerWallet || !trade.sellerWallet || usdcTotal <= 0 || ethAmount <= 0 || fee < 0 || fee > usdcTotal) {
            console.error('[wallet] Invalid trade settlement data, skipping:', trade);
            continue;
          }

          // Settle atomically — all 4 balance mutations in one DB transaction
          await settleTradeTransaction(
            trade.buyerWallet,
            trade.sellerWallet,
            trade.usdcTotal,
            trade.amount,
            trade.fee,
            process.env.PLATFORM_FEE_WALLET,
          );
        } catch (err) {
          console.error('Error processing trades.filled:', err);
        }
      }
    })();

    // Process order cancellations — unlock reserved balance
    (async () => {
      for await (const msg of cancelSub) {
        try {
          const evt = JSON.parse(sc.decode(msg.data)) as {
            orderId: string;
            agentWallet: string;
            side: string;
            remainingAmount: string;
            price: string;
          };

          if (evt.side === 'buy') {
            // Unlock USDC: remaining ETH qty * price
            const usdcAmount = (parseFloat(evt.remainingAmount) * parseFloat(evt.price)).toFixed(6);
            if (parseFloat(usdcAmount) > 0) await unlockBalance(evt.agentWallet, usdcAmount);
          } else if (evt.side === 'sell') {
            // Unlock ETH: remaining unfilled ETH quantity
            if (parseFloat(evt.remainingAmount) > 0) {
              await unlockEthBalance(evt.agentWallet, evt.remainingAmount);
            }
          }
        } catch (err) {
          console.error('Error processing orders.cancelled:', err);
        }
      }
    })();
  } catch (err) {
    console.error('wallet-service NATS unavailable, balance updates disabled:', err);
  }
}

startNatsSubscriber().catch(console.error);
