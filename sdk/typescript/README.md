# x402trade-sdk

TypeScript SDK for [x402Trade](https://getx402.trade) — the AI-native trading exchange on Base L2.

All API calls are free. The platform earns 0.1% on fills only, settled via smart contract on Base.

## Install

```bash
npm install x402trade-sdk
```

## Quick start — API key

```typescript
import { X402TradeClient } from 'x402trade-sdk';

const client = new X402TradeClient({
  apiKey: 'xtr_your_api_key_here',
});

const ticker = await client.getTicker('ETH-USDC');
console.log(`ETH price: $${ticker.price}`);
```

## Quick start — private key (wallet auth)

```typescript
import { X402TradeClient } from 'x402trade-sdk';

const client = new X402TradeClient({
  privateKey: process.env.AGENT_PRIVATE_KEY,
});

console.log('Agent wallet:', client.walletAddress);

const balance = await client.getBalance();
console.log(`USDC balance: ${balance.usdc_balance}`);
```

## Place an order

```typescript
import { X402TradeClient } from 'x402trade-sdk';
import type { Order } from 'x402trade-sdk';

const client = new X402TradeClient({ apiKey: process.env.X402_API_KEY });

// Limit buy 0.1 ETH at $3,200
const order: Order = {
  pair: 'ETH-USDC',
  side: 'buy',
  type: 'limit',
  amount: '0.1',
  price: '3200',
};

const result = await client.placeOrder(order);
console.log(`Order placed: ${result.orderId} — status: ${result.status}`);
console.log(`Filled: ${result.filledAmount} @ avg $${result.avgPrice}`);

// Market sell
const marketSell = await client.placeOrder({
  pair: 'ETH-USDC',
  side: 'sell',
  type: 'market',
  amount: '0.05',
});
console.log(`Market sell filled: ${marketSell.filledAmount}`);
```

## Market maker example

```typescript
import { X402TradeClient, X402TradeError } from 'x402trade-sdk';

const client = new X402TradeClient({ privateKey: process.env.AGENT_PRIVATE_KEY });

async function makeMarket(pair: string, spreadBps: number) {
  const ticker = await client.getTicker(pair);
  const mid = parseFloat(ticker.price);
  const halfSpread = mid * (spreadBps / 10000 / 2);

  const bidPrice = (mid - halfSpread).toFixed(2);
  const askPrice = (mid + halfSpread).toFixed(2);

  console.log(`Quoting ${pair}: bid $${bidPrice} / ask $${askPrice}`);

  const [bid, ask] = await Promise.all([
    client.placeOrder({ pair, side: 'buy',  type: 'limit', amount: '0.01', price: bidPrice }),
    client.placeOrder({ pair, side: 'sell', type: 'limit', amount: '0.01', price: askPrice }),
  ]);

  console.log(`Bid order: ${bid.orderId}`);
  console.log(`Ask order: ${ask.orderId}`);

  return { bid, ask };
}

// Run market making loop
async function run() {
  while (true) {
    try {
      // Cancel open orders
      const openOrders = await client.getOrders('ETH-USDC');
      await Promise.all(openOrders.map(o => client.cancelOrder(o.order_id)));

      await makeMarket('ETH-USDC', 10); // 10 bps spread
    } catch (err) {
      if (err instanceof X402TradeError) {
        console.error(`Exchange error [${err.statusCode}]: ${err.message}`);
      } else {
        throw err;
      }
    }
    await new Promise(r => setTimeout(r, 5000)); // refresh every 5s
  }
}

run().catch(console.error);
```

## Deposit

Send USDC or ETH on Base to your agent wallet address, then confirm the deposit:

```typescript
const client = new X402TradeClient({ privateKey: process.env.AGENT_PRIVATE_KEY });

// Your agent's on-chain deposit address is the wallet address itself
console.log('Deposit address (Base):', client.walletAddress);

// After sending the on-chain tx, confirm it with the platform
await client.confirmDeposit('0xabc123...your_tx_hash', 'USDC');
console.log('Deposit confirmed');
```

> Send only to Base (chain ID 8453). USDC contract on Base: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`

## Withdraw

```typescript
const client = new X402TradeClient({ privateKey: process.env.AGENT_PRIVATE_KEY });

const result = await client.requestWithdraw('100', 'USDC');
console.log(`Withdrawal initiated: ${result.withdrawId}`);
console.log(`Status: ${result.status}`);
console.log(`Confirm at: ${result.confirmUrl}`);
```

## API reference

| Method | Description |
|---|---|
| `placeOrder(order)` | Place a limit or market order |
| `cancelOrder(orderId)` | Cancel an open order |
| `getOrders(pair?, limit?)` | List your open/recent orders |
| `getOrderBook(pair, depth?)` | Fetch live order book |
| `getTicker(pair)` | 24h price and volume stats |
| `getTrades(pair, limit?)` | Recent trades for a pair |
| `getBalance()` | Agent wallet balances |
| `confirmDeposit(txHash, asset?)` | Notify platform of on-chain deposit |
| `requestWithdraw(amount, asset?)` | Initiate a withdrawal |
| `confirmWithdraw(withdrawId, txHash)` | Confirm on-chain withdrawal tx |
| `createApiKey(label)` | Create a new API key (wallet auth required) |

## Error handling

```typescript
import { X402TradeClient, X402TradeError, InsufficientBalanceError } from 'x402trade-sdk';

try {
  await client.placeOrder({ pair: 'ETH-USDC', side: 'buy', type: 'market', amount: '100' });
} catch (err) {
  if (err instanceof InsufficientBalanceError) {
    console.error(`Not enough funds. Available: ${err.available} USDC`);
  } else if (err instanceof X402TradeError) {
    console.error(`Exchange error [${err.statusCode}]: ${err.message}`);
    if (err.reason) console.error('Reason:', err.reason);
  } else {
    throw err;
  }
}
```

## License

MIT
