# x402Trade

**The exchange built for AI agents.**

x402Trade is an autonomous trading exchange that accepts [x402](https://x402.org) micro-payments — AI agents pay per API call in USDC on Base L2, with no accounts, no KYC, and no monthly fees.

```
POST /trade  →  $0.01 / call
GET  /orderbook  →  $0.001 / call
WS   /ws         →  $0.005 / connection
```

---

## Architecture

Six microservices communicate over NATS JetStream:

| Service | Port | Role |
|---|---|---|
| `x402-gateway` | 8080 | x402 payment verification + request routing |
| `order-engine` | 8081 | Order book (Redis sorted sets) + matching engine |
| `wallet-service` | 8082 | Agent balances, USDC lock/unlock, trade settlement |
| `background-worker` | 8083 | Price oracle, risk control, on-chain indexer |

**Infrastructure:** PostgreSQL 15 · Redis 7 · NATS JetStream · Base L2 (USDC)

---

## Quick Start

### Prerequisites

- Docker + Docker Compose
- Node.js 20+

### Run locally

```bash
git clone https://github.com/bidendavid/x402trade.git
cd x402trade

cp .env.example .env
# Edit .env — set X402_PAYMENT_ADDRESS, DEPOSIT_ADDRESS, PLATFORM_FEE_WALLET

docker compose up
```

All services start with health checks. The gateway is available at `http://localhost:8080`.

### Verify

```bash
curl http://localhost:8080/health
# {"status":"ok","service":"x402-gateway"}

curl http://localhost:8083/health
# {"status":"ok","service":"background-worker"}
```

---

## Agent Integration

Any agent that can sign an Ethereum message and make HTTP requests can trade.

```typescript
import { ethers } from 'ethers';

const wallet = new ethers.Wallet(process.env.PRIVATE_KEY);

// Build x402 payment header — sign `x402:<nonce>:<amount>`
const nonce  = Date.now().toString();
const amount = '0.01';
const signature = await wallet.signMessage(`x402:${nonce}:${amount}`);
const paymentHeader = Buffer.from(JSON.stringify({
  wallet: wallet.address,
  signature,
  amount,
  nonce,
})).toString('base64');

// Place a limit order
const res = await fetch('https://api.getx402.trade/trade', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x402-payment': paymentHeader,
  },
  body: JSON.stringify({
    pair: 'ETH-USDC',
    side: 'buy',
    type: 'limit',
    amount: '0.1',
    price: '2200',
  }),
});
```

---

## API Reference

All endpoints require the `x402-payment` header: base64-encoded JSON `{ wallet, signature, amount, nonce }` where signature covers `x402:<nonce>:<amount>`. Agent must have sufficient USDC balance (deposited via `POST /deposit`).

### Orders

| Method | Endpoint | Cost | Description |
|---|---|---|---|
| `POST` | `/trade` | $0.01 | Place limit or market order |
| `DELETE` | `/orders/:id` | FREE | Cancel open order |

**POST /trade body:**
```json
{
  "pair": "ETH-USDC",
  "side": "buy",
  "type": "limit",
  "amount": "0.1",
  "price": "2200"
}
```

### Market Data

| Method | Endpoint | Cost | Description |
|---|---|---|---|
| `GET` | `/orderbook?pair=ETH-USDC&depth=20` | $0.001 | Live bids & asks |
| `GET` | `/trades?pair=ETH-USDC` | $0.001 | Recent trade history |
| `GET` | `/ticker?pair=ETH-USDC` | $0.001 | 24h price + volume |

### Wallet

| Method | Endpoint | Cost | Description |
|---|---|---|---|
| `GET` | `/balance` | FREE | Agent USDC + ETH balance |
| `POST` | `/deposit` | FREE | Record a deposit |
| `POST` | `/withdraw` | FREE | Initiate withdrawal |

### WebSocket

```
WS wss://api.getx402.trade/ws   →  $0.005 / connection
```

Subscribe after connecting:
```json
{ "type": "subscribe", "channel": "orderbook", "pair": "ETH-USDC" }
{ "type": "subscribe", "channel": "trades",    "pair": "ETH-USDC" }
{ "type": "subscribe", "channel": "fills" }
```

---

## Deposit & Withdraw

1. **Deposit** — Send USDC to the `DEPOSIT_ADDRESS` on Base L2. The indexer picks up the on-chain event and credits your wallet balance.
2. **Withdraw** — Call `POST /withdraw` with `{ "amount": "100", "toAddress": "0x..." }`. Processed to your wallet on Base L2.

---

## Smart Contracts

Solidity ^0.8.20, deployed on Base L2.

```bash
cd contracts
npm install

# Deploy to Base Sepolia (testnet)
npx hardhat run scripts/deploy.ts --network baseSepolia

# Run tests
npx hardhat test
```

Contracts:
- `AgentExchangeCore` — trading pairs, liquidity, on-chain trade history
- `AgentWallet` — per-agent wallets, staking, permissions

---

## Configuration

Copy `.env.example` to `.env` and fill in:

| Variable | Description |
|---|---|
| `X402_PAYMENT_ADDRESS` | Wallet that receives x402 API payments |
| `DEPOSIT_ADDRESS` | On-chain deposit address agents send USDC to |
| `PLATFORM_FEE_WALLET` | Wallet that receives 0.3% trading fees |
| `BASE_RPC_URL` | Base L2 RPC endpoint |
| `DEPLOYER_PRIVATE_KEY` | For contract deployment only |

---

## Monitoring

Prometheus + Grafana are included in the Docker Compose stack.

- Grafana: `http://localhost:3000` (admin / admin)
- Prometheus: `http://localhost:9090`

---

## Pricing

| Operation | Cost |
|---|---|
| Place / modify order | $0.01 USDC |
| Read orderbook / trades / ticker | $0.001 USDC |
| WebSocket connection | $0.005 USDC |
| Balance / deposit / withdraw | FREE |
| Trading fee | 0.3% of trade value |

No subscription. No monthly fee. Pay only for what you use.

---

## License

MIT
