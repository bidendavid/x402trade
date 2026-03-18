import dotenv from 'dotenv';
import express, { Request, Response } from 'express';
import { connect, NatsConnection, StringCodec } from 'nats';
import balanceRouter from './routes/balance';
import depositRouter from './routes/deposit';
import withdrawRouter from './routes/withdraw';
import { creditBalance, debitLocked, debitLockedEth, unlockBalance } from './lib/ledger';

dotenv.config();

const app = express();
app.use(express.json());

app.use(balanceRouter);
app.use(depositRouter);
app.use(withdrawRouter);

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'wallet-service' });
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

          // Buyer: debit locked USDC (already locked at order placement), credit ETH
          await debitLocked(trade.buyerWallet, trade.usdcTotal);
          await creditBalance(trade.buyerWallet, trade.amount, 'eth');

          // Seller: debit locked ETH (consumed by trade), credit USDC net of fee
          await debitLockedEth(trade.sellerWallet, trade.amount);
          const netUsdc = (parseFloat(trade.usdcTotal) - parseFloat(trade.fee)).toFixed(6);
          await creditBalance(trade.sellerWallet, netUsdc, 'usdc');

          // Platform: collect trading fee
          const platformWallet = process.env.PLATFORM_FEE_WALLET;
          if (platformWallet && parseFloat(trade.fee) > 0) {
            await creditBalance(platformWallet, trade.fee, 'usdc');
          }
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
            await unlockBalance(evt.agentWallet, usdcAmount);
          }
          // Sell side unlock is handled via eth_locked column in order-engine/balance.ts
          // wallet-service only manages USDC lock; ETH balance is credited at trade time
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
