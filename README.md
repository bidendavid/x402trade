# x402Trade

**The exchange built for AI agents.**

x402Trade is an autonomous trading exchange where AI agents pay per API call in USDC on Base L2 — no accounts, no KYC, no monthly fees.

> **Live:** `https://api.getx402.trade` · [Monitor](https://monitor.getx402.trade)

---

## How it works

```
Agent Wallet ──sign──▶ x402Trade ──▶ Order Book ──▶ Trade Executed
                                                           │
                                                    0.1% fee on fills
```

All API calls are free. The platform earns 0.1% only on filled trades. No OAuth. No billing portal. An agent with an Ethereum wallet can start trading in minutes.

---

## Quick Start

### Option A — API Key (recommended)

Create an API key once with your wallet. Your agent uses the key for all subsequent requests — the private key stays in cold storage.

```typescript
import { ethers } from 'ethers';

const wallet = new ethers.Wallet(process.env.PRIVATE_KEY);

// Step 1: Create API key (one-time, sign with main wallet)
const label = 'my grid bot';
const message = `x402Trade: create API key\nwallet: ${wallet.address.toLowerCase()}\nlabel: ${label}`;
const signature = await wallet.signMessage(message);

const { apiKey } = await fetch('https://api.getx402.trade/api-key/create', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ wallet: wallet.address, signature, label }),
}).then(r => r.json());

// Save apiKey securely — shown only once

// Step 2: Use API key for all requests (no private key needed)
const res = await fetch('https://api.getx402.trade/trade', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-API-Key': apiKey,
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

### Option B — Direct wallet signature (x402 protocol)

Sign each request with your wallet directly.

```typescript
const nonce     = Date.now().toString();
const amount    = '0.01';
const signature = await wallet.signMessage(`x402:${nonce}:${amount}`);
const paymentHeader = Buffer.from(JSON.stringify({
  wallet: wallet.address, signature, amount, nonce,
})).toString('base64');

await fetch('https://api.getx402.trade/trade', {
  method: 'POST',
  headers: { 'x402-payment': paymentHeader, 'Content-Type': 'application/json' },
  body: JSON.stringify({ pair: 'ETH-USDC', side: 'buy', type: 'limit', amount: '0.1', price: '2200' }),
});
```

### Option C — MCP Server (Claude / Cursor)

```bash
npm install -g x402trade-mcp
```

Add to `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "x402trade": {
      "command": "x402trade-mcp",
      "env": { "PRIVATE_KEY": "0x..." }
    }
  }
}
```

---

## Deposit & Withdraw

Funds are held in the **TradingVault smart contract** on Base L2 — the platform cannot move your funds.

```bash
# Deposit: call the contract directly (trustless)
# Contract: 0xe73cB4ebe8315ecadF73a5CE2620389440a992e4 (Base mainnet)
vault.depositUsdc(amount)   # ERC-20 approve first
vault.depositEth()          # payable

# Then notify the backend to sync your DB balance:
POST /deposit  { wallet, txHash }

# Withdraw: your wallet only, no admin approval
POST /withdraw  { wallet, amount, asset, signature }
# OR call the contract directly:
vault.withdrawUsdc(amount)
vault.withdrawEth(amount)
```

---

## API Reference

### Authentication

| Method | Header | Description |
|---|---|---|
| API Key | `X-API-Key: xk_...` | Recommended — create once, rotate anytime |
| x402 signature | `x402-payment: <base64>` | Sign per-request with wallet |

### Orders

| Method | Endpoint | Cost | Description |
|---|---|---|---|
| `POST` | `/trade` | FREE | Place limit or market order |
| `DELETE` | `/orders/:id` | FREE | Cancel open order |
| `GET` | `/orders` | FREE | List your open orders |

**POST /trade body:**
```json
{
  "pair":   "ETH-USDC",
  "side":   "buy",
  "type":   "limit",
  "amount": "0.1",
  "price":  "2200"
}
```

### Market Data

| Method | Endpoint | Cost | Description |
|---|---|---|---|
| `GET` | `/orderbook?pair=ETH-USDC&depth=20` | FREE | Live bids & asks |
| `GET` | `/trades?pair=ETH-USDC` | FREE | Recent trade history |
| `GET` | `/ticker?pair=ETH-USDC` | FREE | 24h price + volume |

### Wallet

| Method | Endpoint | Cost | Description |
|---|---|---|---|
| `GET` | `/balance` | FREE | Your USDC + ETH balance |
| `POST` | `/deposit` | FREE | Sync on-chain deposit to account |
| `POST` | `/withdraw` | FREE | Withdraw to your wallet |

### API Key Management

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api-key/create` | Create a new API key (wallet signature required) |
| `GET` | `/api-key/list` | List all your keys |
| `POST` | `/api-key/revoke` | Revoke a key by ID |

### WebSocket

```
wss://api.getx402.trade/ws   →  $0.005 / connection
```

```json
{ "type": "subscribe", "channel": "orderbook", "pair": "ETH-USDC" }
{ "type": "subscribe", "channel": "trades",    "pair": "ETH-USDC" }
{ "type": "subscribe", "channel": "fills" }
```

### Error Codes

All errors return JSON: `{ "error": "message", "reason": "detail" }`

| HTTP Status | When it happens | How to handle |
|---|---|---|
| `400 Bad Request` | Missing/invalid field (pair, side, amount, price) | Fix request body — check `error` field for details |
| `401 Unauthorized` | API key invalid, expired, or revoked | Rotate key via `POST /api-key/create` |
| `402 Payment Required` | Insufficient USDC balance | Deposit more funds via `POST /deposit` |
| `403 Forbidden` | Read-only API key used on trade endpoint | Create a new key without read-only restriction |
| `404 Not Found` | Wallet not registered / order not found | Deposit first to create account; check order ID |
| `409 Conflict` | Nonce already used (replay attack) | Generate a new nonce — each request must have a unique nonce |
| `429 Too Many Requests` | Rate limited (risk score too low) | Back off and retry; excessive cancellations lower your score |
| `500 Internal Server Error` | Unexpected server error | Retry with exponential backoff |
| `503 Service Unavailable` | Order engine or matching service down | Retry in a few seconds |

**Agent risk score** (0–100) affects rate limits:

| Score | Max requests/min |
|---|---|
| 80–100 | 120 |
| 50–79 | 60 |
| 30–49 | 20 |
| 0–29 | 5 (effectively blocked) |

Score increases +1 per filled trade, decreases −2 per cancelled order.

---

## Pricing

**All API calls are free.**

The platform earns a **0.1% fee on filled trades only**, deducted automatically at settlement via the TradingVault smart contract.

| Operation | Cost |
|---|---|
| Place / cancel order | FREE |
| Read orderbook / trades / ticker | FREE |
| Balance / deposit / withdraw | FREE |
| API key management | FREE |
| **Trade fill** | **0.1% of trade value** |
| Trading fee on fills | 0.1% of trade value |

No subscription. No minimum balance. Pay only for what you use.

---

## Security Model

### Fund custody — TradingVault contract

User funds are held in a smart contract, not a platform wallet.

- **Deposit**: USDC/ETH goes to `TradingVault` on Base L2
- **Withdraw**: Users call the contract directly — no platform approval required
- **Settlement**: Only the authorized exchange backend can call `settle()` to move funds between users
- **Platform cannot steal funds**: Owner can only rotate the backend address, never touch user balances

Contract: [`0xe73cB4ebe8315ecadF73a5CE2620389440a992e4`](https://basescan.org/address/0xe73cB4ebe8315ecadF73a5CE2620389440a992e4) on Base mainnet.

### API Key security

| Scenario | Impact |
|---|---|
| API key leaked | Revoke it instantly via `POST /api-key/revoke` — funds safe |
| Server breached | Attacker can trade but cannot withdraw (withdrawal requires wallet signature) |
| Main wallet lost | Funds still withdrawable directly from TradingVault contract |

### Protocol security

- **Replay protection**: nonces stored in Redis with 5-minute TTL, marked used before fund deduction
- **Atomic settlement**: all balance mutations in a single PostgreSQL transaction
- **Fund locking**: USDC/ETH locked atomically with order placement — no double-spend
- **Deposit idempotency**: `INSERT ... ON CONFLICT DO NOTHING` prevents double-credit on same tx hash
- **Concurrent withdrawal safety**: `SELECT FOR UPDATE` prevents race conditions

---

## Architecture

```
Agent
  │
  ▼
x402-gateway (8080)
  │  ├─ API Key or x402 payment verification
  │  ├─ Risk scoring (per-agent 0–100)
  │  └─ Routes to services via NATS
  │
  ├──▶ order-engine (8081)
  │       ├─ Redis sorted sets (live order book)
  │       └─ Price-time priority matching
  │
  ├──▶ wallet-service (8082)
  │       ├─ USDC + ETH balances
  │       ├─ Atomic trade settlement
  │       └─ TradingVault contract integration
  │
  └──▶ background-worker (8083)
          ├─ Price oracle (CoinGecko → Redis)
          ├─ Risk scoring
          └─ On-chain event indexer
```

**Infrastructure:** PostgreSQL 15 · Redis 7 · NATS JetStream · Base L2 · Docker · Prometheus + Grafana

**Smart Contracts (Base mainnet):**
- `TradingVault` — user fund custody, atomic settlement, trustless withdrawals
- `AgentWallet` — agent registration, staking, reputation scoring

---

## Run Locally

```bash
git clone https://github.com/bidendavid/x402trade.git
cd x402trade
cp .env.example .env
# Edit .env

docker compose up
```

Health check:
```bash
curl http://localhost:8080/health
# {"status":"ok","service":"x402-gateway"}
```

---

## Market Maker Agent

Ready-to-run market maker that provides liquidity by placing bid/ask orders around the current price.

```bash
cd services/market-maker-agent
cp .env.example .env
# Set PRIVATE_KEY in .env
npm start
```

Default config: 3 price levels per side, 0.05 ETH per order, 0.2% spread, 30s refresh.
Risk limits: auto-stop on 10% price drift, or if USDC < $50 or ETH < 0.05.

---

## MCP Server

Exposes x402Trade as tools for Claude, Cursor, and any MCP-compatible LLM.

```bash
npm install -g x402trade-mcp
```

Available tools: `place_order`, `get_orderbook`, `get_balance`, `get_trades`, `cancel_order`, `get_ticker`.

Published: [x402trade-mcp on npm](https://www.npmjs.com/package/x402trade-mcp)

---

## License

MIT
