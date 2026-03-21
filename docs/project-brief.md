# x402Trade — Project Brief

**The first trading exchange built exclusively for AI agents.**

> Live: [api.getx402.trade](https://api.getx402.trade) · [getx402.trade](https://getx402.trade)

---

## The Problem

AI agents are becoming economic actors. They manage portfolios, execute strategies, and move capital — autonomously, 24/7, without human intervention.

But today's exchanges were built for humans:

- **KYC required** — an AI agent has no passport
- **Monthly subscriptions** — an agent running 10 trades a day doesn't want to pay $500/mo for an institutional API
- **API keys tied to accounts** — rotating credentials across thousands of agent instances is a DevOps nightmare
- **Rate limits designed for dashboards** — not for high-frequency, programmatic access

The result: agents either use clunky workarounds (human-managed accounts), or skip trading entirely.

---

## The Solution

**x402Trade** is a fully autonomous exchange where the unit of access is a single API call, paid for in USDC on Base L2.

No accounts. No KYC. No monthly fees. No API keys.

An agent places a trade in three steps:

1. Sign the message `x402:<nonce>:<amount>` with its Ethereum wallet
2. Attach the signature as an HTTP header: `x402-payment`
3. Call `POST /trade`

The exchange verifies the cryptographic proof, deducts the fee from the agent's internal USDC balance, and routes the order. The entire flow is stateless, composable, and works with any HTTP client.

```
Agent Wallet → Sign → HTTP Request → x402Trade → Trade Executed
                                          ↓
                                    $0.01 deducted
```

---

## What is x402?

[x402](https://x402.org) is an emerging open standard for machine-to-machine micropayments over HTTP. It revives HTTP status code `402 Payment Required` — a code that has existed since 1991 but was never implemented.

With x402:
- Any API endpoint can declare its price in the response
- Any agent with an Ethereum wallet can pay instantly
- No OAuth, no API keys, no billing portal

x402Trade is one of the first production systems built on this standard.

---

## How It Works

### For an AI Agent

```typescript
import { ethers } from 'ethers';

const wallet = new ethers.Wallet(process.env.PRIVATE_KEY);

const nonce     = Date.now().toString();
const amount    = '0.01';  // $0.01 USDC
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

Any agent that can sign an Ethereum message and make an HTTP request can trade. That includes LangChain agents, AutoGPT, custom Python scripts, and any LLM with tool use.

### Deposit & Withdraw

- **Deposit**: Agent sends USDC to the exchange's deposit address on Base L2. The on-chain indexer detects the transfer and credits the internal balance automatically.
- **Withdraw**: Agent signs a withdrawal intent and calls `POST /withdraw`. USDC is sent back on-chain.

No human approval required at any step.

---

## Pricing

| Operation | Cost |
|---|---|
| Place / modify order | $0.01 USDC |
| Read orderbook / trades / ticker | $0.001 USDC |
| WebSocket real-time feed | $0.005 / connection |
| Balance / deposit / withdraw | FREE |
| Trading fee on filled trades | 0.3% of trade value |

**No subscription. No minimum balance. Pay only for what you use.**

An agent running 100 trades/day spends $1/day in API fees + 0.3% on fills. Comparable infrastructure at a traditional exchange would cost hundreds of dollars per month — if they'd even onboard an AI agent.

---

## Architecture

Four microservices, all communicating over NATS JetStream:

```
Agent
  │
  ▼
x402-gateway (8080)
  │  ├─ Verifies x402 payment signature
  │  ├─ Deducts API fee from internal USDC balance
  │  └─ Routes to services via NATS
  │
  ├──▶ order-engine (8081)
  │       ├─ Redis sorted sets for live order book
  │       ├─ Price-time priority matching
  │       └─ Atomic fund locking (PostgreSQL)
  │
  ├──▶ wallet-service (8082)
  │       ├─ Agent USDC + ETH balances
  │       ├─ Trade settlement (atomic DB transaction)
  │       └─ Deposit / withdraw processing
  │
  └──▶ background-worker (8083)
          ├─ Price oracle (CoinGecko → Redis)
          ├─ Risk scoring (0–100 per agent)
          └─ Base L2 on-chain event indexer
```

**Infrastructure:** PostgreSQL 15 · Redis 7 · NATS · Base L2 (USDC) · Docker · Prometheus + Grafana

**Smart Contracts (Solidity ^0.8.20, Base L2):**
- `AgentExchangeCore` — trading pairs, AMM liquidity, on-chain trade history
- `AgentWallet` — per-agent wallets, staking, permissions, blacklisting

---

## Risk & Trust System

Every agent has a **risk score from 0–100**, updated in real time:

| Score | Rate Limit |
|---|---|
| 80–100 (trusted) | 120 calls / minute |
| 50–79 (normal) | 60 calls / minute |
| 30–49 (flagged) | 20 calls / minute |
| 0–29 (suspicious) | 5 calls / minute |

Agents start at 100. Successful trades increase score. Cancelled orders decrease it. Blacklisted wallets are rejected at the payment verification layer before any funds are touched.

The risk service **fails closed** — if it's unavailable, no new orders are accepted. This prevents blacklisted agents from trading during downtime.

---

## Security Model

The exchange was built with financial-grade safety as a core constraint:

- **Atomic fund locking** — USDC and ETH are locked in the same database transaction as order placement. Orders are rejected if funds are insufficient — no silent failures.
- **Atomic trade settlement** — all four balance mutations (buyer debit, buyer credit, seller debit, seller credit) happen in a single PostgreSQL transaction. Partial settlement is impossible.
- **Replay protection** — nonces are stored in Redis with a 5-minute TTL. The nonce is marked used *before* funds are deducted, closing the crash-recovery replay window.
- **Concurrent withdrawal safety** — balance is checked with `SELECT FOR UPDATE` inside the transaction. Concurrent withdrawals cannot both pass the balance check.
- **Deposit idempotency** — `INSERT ... ON CONFLICT DO NOTHING` makes double-credit on the same on-chain transaction impossible, even under concurrent requests.

---

## Business Model

Three revenue streams:

### 1. API Micropayments (per-call)
Every authenticated request generates revenue. Even failed orders (market order with no match) still charge $0.01 for the API call. This creates a baseline revenue floor independent of trading volume.

### 2. Trading Fees (0.3% per fill)
Industry-standard maker/taker fee, collected in USDC at the time of settlement. The platform fee wallet receives 0.3% of every filled trade's USDC value.

### 3. Infrastructure Licensing
The entire stack is open-source (MIT). Operators who want to run a private instance of x402Trade — for a specific trading consortium, hedge fund, or AI platform — can license enterprise support and customization.

---

## Market Opportunity

### The AI Agent Economy

AI agents managing real money is no longer theoretical:
- Autonomous trading bots using LLMs for strategy generation are already in production
- DeFi protocols are beginning to accept programmatic access without human approval flows
- The total value locked in agent-managed strategies is growing rapidly

### Why Now

Three things converged in 2024–2025:

1. **LLMs with reliable tool use** — GPT-4o, Claude 3.5+, Gemini 2.0 can reliably call APIs with structured outputs
2. **Base L2 maturity** — Coinbase's L2 has sub-second finality and near-zero gas costs, making $0.001 micropayments economically viable
3. **x402 standardization** — Coinbase and the broader ecosystem are actively promoting x402 as the payment layer for the "agentic web"

x402Trade is positioned at the intersection of all three.

### Comparable Markets
- Traditional algorithmic trading API fees: $500–$5,000/month per seat
- DeFi DEX trading volume: $2–5B/day
- AI agent market size (2025 estimate): $5B, growing >40% YoY

---

## Current Status

| Item | Status |
|---|---|
| Core exchange engine | ✅ Production |
| x402 payment verification | ✅ Production |
| Order book (limit + market orders) | ✅ Production |
| Trade settlement (atomic) | ✅ Production |
| On-chain deposit/withdraw | ✅ Production |
| Risk scoring system | ✅ Production |
| Real-time WebSocket feeds | ✅ Production |
| Prometheus + Grafana monitoring | ✅ Production |
| Smart contracts (Base L2) | ✅ Testnet ready |
| Live API endpoint | ✅ api.getx402.trade |
| Security audit (30 findings) | ✅ All fixed |

---

## Roadmap

### Near-term
- [ ] Deploy smart contracts to Base mainnet
- [ ] Add BTC-USDC, additional trading pairs
- [ ] Agent SDK (TypeScript + Python) for one-line integration
- [ ] Order types: stop-loss, take-profit, time-in-force

### Medium-term
- [ ] AMM liquidity pools (agent-provided liquidity, earn fees)
- [ ] Cross-agent settlement (agent-to-agent USDC transfers via signed intent)
- [ ] Strategy marketplace (agents publish and subscribe to trading signals)

### Long-term
- [ ] Multi-chain support (Arbitrum, Optimism)
- [ ] Institutional tier (dedicated nodes, SLA, custom rate limits)
- [ ] On-chain governance for fee parameters

---

## Why x402Trade vs. Alternatives

| | x402Trade | Centralized Exchange API | DEX (Uniswap, etc.) |
|---|---|---|---|
| KYC required | ❌ No | ✅ Yes | ❌ No |
| Per-call pricing | ✅ Yes | ❌ Subscription | ❌ Gas only |
| Order book (limit orders) | ✅ Yes | ✅ Yes | ❌ AMM only |
| Agent-native auth | ✅ Wallet sig | ❌ API key + secret | ✅ Wallet sig |
| Sub-$0.01 API fee | ✅ Yes | ❌ N/A | ❌ Gas > $0.01 |
| Real-time order book feed | ✅ WebSocket | ✅ WebSocket | ❌ Polling |
| Open source | ✅ MIT | ❌ Closed | ✅ Contracts only |

---

## Open Source

Full source code at **github.com/bidendavid/x402trade** (MIT License).

The project is designed to be forkable. Operators can:
- Deploy their own instance with a custom fee structure
- Add trading pairs specific to their use case
- Integrate with their own agent frameworks

---

## Contact

- **API**: https://api.getx402.trade
- **Docs**: https://getx402.trade
- **GitHub**: https://github.com/bidendavid/x402trade
- **Monitoring**: https://monitor.getx402.trade

---

*Built on Base L2 · Powered by x402 · MIT License*
