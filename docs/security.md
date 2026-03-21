# Security Model

---

## Fund Custody — TradingVault Contract

User funds are held in the `TradingVault` smart contract on Base L2, not in a platform-controlled wallet.

**Contract address (Base mainnet):** `0xe73cB4ebe8315ecadF73a5CE2620389440a992e4`

### How it works

```
User                         TradingVault Contract           x402Trade Backend
 │                                   │                               │
 │── depositUsdc(amount) ──────────▶ │                               │
 │                                   │◀── POST /deposit (sync DB) ───│
 │                                   │                               │
 │   (place orders, trade...)        │◀─── settle(buyer,seller) ─────│  ← only backend can call
 │                                   │                               │
 │── withdrawUsdc(amount) ─────────▶ │                               │
 │   (no backend needed)             │                               │
```

### What the platform can do
- Call `settle()` to move funds between users after a matched trade
- Rotate the authorized backend address (`setExchangeBackend`) — does not touch user balances
- Set the fee rate (max 1%)

### What the platform CANNOT do
- Move user funds to any external address
- Block or delay withdrawals
- Access user private keys

### What users can always do
- Call `withdrawUsdc(amount)` or `withdrawEth(amount)` directly on the contract
- Withdraw goes straight to their wallet — no approval, no delay

---

## API Key Security

API keys separate trading access from fund custody:

| Action | Requires |
|---|---|
| Place / cancel orders | API key |
| Read market data | API key |
| **Withdraw funds** | **Wallet signature** |
| Create / revoke API keys | **Wallet signature** |

If an API key is compromised:
1. Revoke it with `POST /api-key/revoke` (wallet signature required)
2. Funds remain safe — attacker cannot withdraw without the private key
3. Create a new key

API keys are stored as SHA-256 hashes — the raw key is shown once at creation and never stored.

---

## Protocol Security

### Replay protection
Every x402 payment includes a `nonce` (millisecond timestamp). The nonce is:
1. Checked for freshness (must be within ±5 minutes of server time)
2. Marked as used in Redis **before** funds are deducted
3. Expires automatically after 10 minutes

This means a captured payment header cannot be replayed, even during a server crash between deduction and nonce marking.

### Atomic fund locking
When an order is placed:
```
BEGIN TRANSACTION
  Lock USDC/ETH balance (SELECT FOR UPDATE)
  Check balance ≥ order value
  Deduct and move to "locked" column
  Insert order record
COMMIT
```
Concurrent orders from the same wallet cannot both pass the balance check.

### Atomic trade settlement
When a trade matches, all four balance mutations happen in a single transaction:
- Buyer: locked USDC decreases, ETH balance increases
- Seller: locked ETH decreases, USDC balance increases
- Platform: fee credited

Partial settlement (buyer credited but seller not debited) is impossible.

### Deposit idempotency
```sql
INSERT INTO payments (payment_hash, ...)
ON CONFLICT (payment_hash) DO NOTHING
```
Re-submitting the same `txHash` to `POST /deposit` will always return `409 Conflict` — the balance is never double-credited.

### Concurrent withdrawal safety
```sql
SELECT usdc_balance FROM balances WHERE agent_id = $1 FOR UPDATE
```
Two concurrent withdrawal requests for the same wallet are serialized. The second request sees the already-deducted balance.

### Input validation
All user inputs are validated before reaching business logic:
- Wallet addresses: must match `0x[0-9a-fA-F]{40}`
- Trading pairs: validated against a whitelist (`ETH-USDC`, `BTC-USDC`)
- Amounts and prices: validated as positive finite numbers
- Order type/side: validated against allowed values

### SQL injection prevention
All database queries use parameterized statements (`$1`, `$2`, ...). No string interpolation is used in SQL queries.

---

## Risk Scoring System

Every agent wallet has a score from 0 to 100 (starts at 100):

| Score | Rate Limit | Behavior |
|---|---|---|
| 80–100 | 120 calls/min | Trusted |
| 50–79 | 60 calls/min | Normal |
| 30–49 | 20 calls/min | Flagged |
| 0–29 | 5 calls/min | Suspicious |

Scores decrease for excessive order cancellations and other suspicious patterns. Blacklisted wallets are rejected at the payment verification layer before any funds are touched.

The risk service **fails closed** — if unavailable, new orders are rejected. This prevents blacklisted agents from trading during downtime.

---

## Infrastructure Security

- All services communicate internally via NATS JetStream (not exposed publicly)
- Only the x402-gateway (port 8080) is exposed through a reverse proxy with TLS
- Redis and PostgreSQL are on a separate server, not internet-facing
- All secrets are in environment variables, never in code or version control
- `EXCHANGE_BACKEND_KEY` (the private key for on-chain settlement) lives only on the app server

---

## Responsible Disclosure

Found a security issue? Please report it by opening a GitHub issue marked `[SECURITY]` or contacting the team directly before public disclosure.
