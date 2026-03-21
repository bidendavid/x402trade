# API Key Guide

API keys let your agent trade without exposing its private key on every request. The private key signs once to create the key, then stays in cold storage.

---

## Create an API Key

```typescript
import { ethers } from 'ethers';

const wallet = new ethers.Wallet(process.env.PRIVATE_KEY);
const label  = 'my grid bot';

const message   = `x402Trade: create API key\nwallet: ${wallet.address.toLowerCase()}\nlabel: ${label}`;
const signature = await wallet.signMessage(message);

const res = await fetch('https://api.getx402.trade/api-key/create', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    wallet:      wallet.address,
    signature,
    label,
    permissions: 'trade',      // 'trade' | 'readonly'
    expiresInDays: 90,         // optional, omit for no expiry
  }),
}).then(r => r.json());

console.log(res.apiKey);  // xk_abc123...  — save this, shown only ONCE
```

**Response:**
```json
{
  "success":     true,
  "keyId":       1,
  "apiKey":      "xk_a1b2c3...",
  "label":       "my grid bot",
  "permissions": "trade",
  "expiresAt":   "2026-06-20T00:00:00.000Z",
  "warning":     "Save this key now — it will NOT be shown again."
}
```

---

## Use the API Key

Add `X-API-Key` to every request header. No per-request signing needed.

```typescript
const API_KEY = process.env.X402_API_KEY;  // xk_...

// Place order
await fetch('https://api.getx402.trade/trade', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-API-Key': API_KEY,
  },
  body: JSON.stringify({
    pair: 'ETH-USDC', side: 'buy', type: 'limit',
    amount: '0.1', price: '2200',
  }),
});

// Get balance
await fetch('https://api.getx402.trade/balance', {
  headers: { 'X-API-Key': API_KEY },
});
```

---

## List Keys

```typescript
const message   = `x402Trade: list API keys\nwallet: ${wallet.address.toLowerCase()}`;
const signature = await wallet.signMessage(message);

const { keys } = await fetch(
  `https://api.getx402.trade/api-key/list?wallet=${wallet.address}&signature=${signature}`
).then(r => r.json());

keys.forEach(k => {
  console.log(`[${k.id}] ${k.label} — ${k.permissions} — ${k.revoked ? 'REVOKED' : 'active'}`);
});
```

---

## Revoke a Key

```typescript
const keyId   = 1;
const message = `x402Trade: revoke API key ${keyId}\nwallet: ${wallet.address.toLowerCase()}`;
const signature = await wallet.signMessage(message);

await fetch('https://api.getx402.trade/api-key/revoke', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ wallet: wallet.address, signature, keyId }),
});
```

Revocation takes effect immediately. The key cannot be un-revoked.

---

## Permissions

| Permission | What it can do |
|---|---|
| `trade` | Place orders, cancel orders, read market data, check balance |
| `readonly` | Read market data and balance only — cannot place or cancel orders |

---

## Security Best Practices

**Store the key in an environment variable, not in code:**
```bash
export X402_API_KEY=xk_abc123...
```

**Create one key per bot/strategy** — if one is compromised, revoke only that key without affecting others.

**Set an expiry** — use `expiresInDays` for keys running on shared or less-trusted infrastructure.

**What happens if a key is leaked:**
1. Call `POST /api-key/revoke` with your main wallet — takes effect immediately
2. Funds are safe — withdrawal requires a wallet signature, not just an API key
3. Create a new key

**What an attacker can do with a stolen API key:**
- Place and cancel orders
- Read your balances and order history

**What they cannot do:**
- Withdraw funds (requires wallet signature)
- Create or revoke other API keys (requires wallet signature)
- Access your private key

---

## Python Example

```python
import os, requests
from eth_account import Account
from eth_account.messages import encode_defunct

private_key = os.environ['PRIVATE_KEY']
account     = Account.from_key(private_key)
api_key     = os.environ['X402_API_KEY']

# Place order
r = requests.post(
    'https://api.getx402.trade/trade',
    headers={'X-API-Key': api_key, 'Content-Type': 'application/json'},
    json={'pair': 'ETH-USDC', 'side': 'buy', 'type': 'limit', 'amount': '0.1', 'price': '2200'},
)
print(r.json())
```
