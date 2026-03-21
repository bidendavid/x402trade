# Market Maker Agent

A ready-to-run market maker that provides liquidity on x402Trade by continuously placing bid/ask orders around the current market price.

---

## Setup

```bash
cd services/market-maker-agent
npm install
cp .env.example .env
```

Edit `.env`:
```bash
# Required
PRIVATE_KEY=0x_your_private_key_here

# Optional (defaults shown)
GATEWAY_URL=https://api.getx402.trade
PAIR=ETH-USDC
ORDER_SIZE=0.05        # ETH per order
LEVELS=3               # price levels per side
SPREAD=0.002           # 0.2% per level
REFRESH_SECS=30        # how often to refresh orders

# Risk limits — agent auto-stops if breached
MAX_PRICE_DRIFT_PCT=10
MIN_USDC_BALANCE=50
MIN_ETH_BALANCE=0.05
```

```bash
npm start
```

---

## How it works

With `LEVELS=3`, `SPREAD=0.2%`, `ORDER_SIZE=0.05 ETH`, and a mid price of $2000:

```
Asks (sell):  $2004   $2008   $2012   ← 0.05 ETH each
              ──────── mid $2000 ────────
Bids (buy):   $1996   $1992   $1988   ← 0.05 ETH each
```

Every `REFRESH_SECS` seconds:
1. Fetch current price from `/ticker`
2. Run risk checks
3. Cancel all existing orders
4. Place 6 fresh orders (3 bids + 3 asks)

---

## Risk limits

The agent stops automatically and cancels all open orders if:

| Condition | Default |
|---|---|
| Price drift from start | > 10% |
| USDC balance | < $50 |
| ETH balance | < 0.05 ETH |

Adjust these in `.env` based on your risk tolerance.

---

## What you need

The market maker wallet needs both USDC and ETH in its x402Trade balance:

- **USDC** — to fund buy orders. With 3 levels × 0.05 ETH × ~$2000 = ~$300 minimum recommended
- **ETH** — to fund sell orders. 3 levels × 0.05 ETH = 0.15 ETH minimum recommended
- **USDC for API fees** — each refresh cycle costs ~$0.01 × 2 sides × 3 levels = ~$0.06 in API fees

Deposit via the TradingVault contract on Base L2, then call `POST /deposit` to sync.

---

## Output example

```
╔════════════════════════════════════════╗
║   x402Trade Market Maker Agent         ║
╚════════════════════════════════════════╝
Wallet  : 0xABCD...
Pair    : ETH-USDC
Levels  : 3 per side
Size    : 0.05 per order
Spread  : 0.20% per level
Refresh : every 30s

[2026-03-21T10:00:00.000Z] ETH-USDC = $2000
  Reference price set: $2000
  Cancelling 0 existing orders...
  BUY  0.05 @ $1996.00  → a1b2c3d4…
  BUY  0.05 @ $1992.00  → e5f6g7h8…
  BUY  0.05 @ $1988.00  → i9j0k1l2…
  SELL 0.05 @ $2004.00  → m3n4o5p6…
  SELL 0.05 @ $2008.00  → q7r8s9t0…
  SELL 0.05 @ $2012.00  → u1v2w3x4…
  Placed 6 orders around $2000
  Balance: $1450.23 USDC | 0.8500 ETH
```

---

## Stop gracefully

Press `Ctrl+C` — the agent cancels all open orders before exiting.

---

## Advanced: Multiple pairs

Run separate instances for different trading pairs:

```bash
# Terminal 1
PAIR=ETH-USDC PRIVATE_KEY=0x... npm start

# Terminal 2
PAIR=BTC-USDC PRIVATE_KEY=0x... npm start
```
