# x402Trade Market Maker Agent

An example market maker for [x402Trade](https://getx402.trade) — an AI-native trading exchange on Base L2.

Fork this, add your private key, and start providing liquidity to earn the bid-ask spread.

## How it works

The bot continuously places limit orders on both sides of the current ETH-USDC price:

```
asks: $2165  $2170  $2174   (sell 0.05 ETH each)
      ──────── mid $2157 ────────
bids: $2149  $2144  $2140   (buy 0.05 ETH each)
```

Every 30 seconds it cancels stale orders and refreshes the grid around the new mid price.

## Prerequisites

- Node.js 20+
- A Base wallet with ETH for gas
- USDC and/or ETH deposited on x402Trade

## Setup

**1. Clone and install**
```bash
git clone https://github.com/your-org/x402trade-market-maker
cd x402trade-market-maker
npm install
```

**2. Configure**
```bash
cp .env.example .env
# Edit .env — set PRIVATE_KEY at minimum
```

**3. Deposit funds on x402Trade**

Send USDC or ETH to the TradingVault contract on Base:
- Contract: `0xe73cB4ebe8315ecadF73a5CE2620389440a992e4`
- Then call `POST https://api.getx402.trade/deposit` with your txHash to credit your account

```bash
curl -X POST https://api.getx402.trade/deposit \
  -H "Content-Type: application/json" \
  -d '{"wallet":"0xYOUR_WALLET","txHash":"0xYOUR_TX_HASH","asset":"ETH"}'
```

**4. Run**
```bash
# Development
npm start

# Production (pm2)
npm run build
pm2 start dist/index.js --name market-maker-eth-usdc
```

## Configuration

| Variable | Default | Description |
|---|---|---|
| `PRIVATE_KEY` | required | Your wallet private key |
| `GATEWAY_URL` | `https://api.getx402.trade` | API endpoint |
| `PAIR` | `ETH-USDC` | Trading pair |
| `ORDER_SIZE` | `0.05` | ETH per order |
| `LEVELS` | `3` | Order levels per side |
| `SPREAD` | `0.002` | 0.2% spacing between levels |
| `REFRESH_SECS` | `30` | Cycle interval |
| `MAX_PRICE_DRIFT_PCT` | `10` | Stop if price moves >10% |
| `MIN_USDC_BALANCE` | `50` | Stop if USDC drops below $50 |
| `MIN_ETH_BALANCE` | `0.05` | Stop if ETH drops below 0.05 |

## Fees

**All API calls are free.** The platform earns a 0.1% fee on filled trades only, deducted automatically at settlement.

This means market makers have zero running costs when there are no fills — you only pay when you earn.

## Risk controls

The bot stops automatically if:
- Price drifts more than `MAX_PRICE_DRIFT_PCT` from start
- USDC balance drops below `MIN_USDC_BALANCE`
- ETH balance drops below `MIN_ETH_BALANCE`

## Withdrawing funds

```bash
# 1. Request withdrawal — platform returns calldata
curl -X POST https://api.getx402.trade/withdraw \
  -H "Content-Type: application/json" \
  -d '{"wallet":"0xYOUR_WALLET","amount":"1.0","asset":"ETH","signature":"0xYOUR_SIG"}'

# 2. Submit the returned calldata on-chain with your wallet
# 3. Confirm: POST /withdraw/confirm { withdrawId, txHash }
```

## License

MIT
