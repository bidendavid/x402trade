# x402Trade Python SDK

Python SDK for [x402Trade](https://getx402.trade) — the AI-native trading exchange built on Base L2. All API calls are free; the platform earns 0.1% on fills only.

## Installation

```bash
pip install x402trade-sdk
```

## Authentication

The SDK supports two authentication modes:

- **API key** — fastest; pass `api_key=` to the client.
- **Private key** — full self-custody; the SDK signs every request with your wallet key. Required for withdrawals and API-key creation.

---

## Quick start — API key

```python
from x402trade import X402TradeClient

client = X402TradeClient(api_key="xk_your_api_key_here")
ticker = client.get_ticker("ETH/USDC")
print(ticker["price"])
```

## Quick start — private key

```python
from x402trade import X402TradeClient

client = X402TradeClient(private_key="0xYOUR_PRIVATE_KEY")
print("Agent wallet:", client.wallet_address)

balance = client.get_balance()
print("USDC balance:", balance["usdc_balance"])
```

---

## Place a limit order

```python
from x402trade import X402TradeClient

client = X402TradeClient(api_key="xk_your_api_key_here")

order = client.place_order(
    pair="ETH/USDC",
    side="buy",
    type="limit",
    amount="0.5",
    price="3200.00",
)
print("Order ID:", order["orderId"])
print("Status:  ", order["status"])
```

## Place a market order

```python
order = client.place_order(
    pair="BTC/USDC",
    side="sell",
    type="market",
    amount="0.01",
)
print("Filled:", order["filledAmount"], "@ avg", order["avgPrice"])
```

---

## Market maker snippet

Continuously quote a tight spread on ETH/USDC:

```python
import time
from x402trade import X402TradeClient, X402TradeError

client = X402TradeClient(api_key="xk_your_api_key_here")

PAIR = "ETH/USDC"
SPREAD = 0.002   # 0.2 %
SIZE = "0.1"     # ETH per side
INTERVAL = 5     # seconds between requotes

active_orders: list[str] = []

while True:
    # Cancel previous quotes
    for oid in active_orders:
        try:
            client.cancel_order(oid)
        except X402TradeError:
            pass
    active_orders.clear()

    try:
        mid = float(client.get_ticker(PAIR)["price"])
        bid_price = f"{mid * (1 - SPREAD / 2):.2f}"
        ask_price = f"{mid * (1 + SPREAD / 2):.2f}"

        bid = client.place_order(PAIR, "buy",  "limit", SIZE, bid_price)
        ask = client.place_order(PAIR, "sell", "limit", SIZE, ask_price)
        active_orders = [bid["orderId"], ask["orderId"]]

        print(f"Quoting  bid={bid_price}  ask={ask_price}  mid={mid:.2f}")
    except X402TradeError as exc:
        print("Exchange error:", exc)

    time.sleep(INTERVAL)
```

---

## LangChain tool integration

Wrap the SDK as a LangChain structured tool so an LLM agent can trade autonomously:

```python
from langchain.tools import StructuredTool
from pydantic import BaseModel, Field
from x402trade import X402TradeClient, X402TradeError

client = X402TradeClient(api_key="xk_your_api_key_here")


class PlaceOrderInput(BaseModel):
    pair: str = Field(description="Trading pair, e.g. ETH/USDC")
    side: str = Field(description="'buy' or 'sell'")
    order_type: str = Field(description="'limit' or 'market'")
    amount: str = Field(description="Order size as a decimal string, e.g. '0.5'")
    price: str | None = Field(default=None, description="Limit price (omit for market orders)")


def place_order_fn(pair: str, side: str, order_type: str, amount: str, price: str | None = None) -> str:
    try:
        result = client.place_order(pair, side, order_type, amount, price)
        return f"Order placed: id={result['orderId']} status={result['status']} filled={result['filledAmount']}"
    except X402TradeError as exc:
        return f"Order failed: {exc}"


place_order_tool = StructuredTool.from_function(
    func=place_order_fn,
    name="place_order",
    description="Place a buy or sell order on the x402Trade exchange.",
    args_schema=PlaceOrderInput,
)


class GetTickerInput(BaseModel):
    pair: str = Field(description="Trading pair to query, e.g. ETH/USDC")


def get_ticker_fn(pair: str) -> str:
    try:
        t = client.get_ticker(pair)
        return f"{pair} price={t['price']} change24h={t['change24h']} volume24h={t['volume24h']}"
    except X402TradeError as exc:
        return f"Ticker error: {exc}"


get_ticker_tool = StructuredTool.from_function(
    func=get_ticker_fn,
    name="get_ticker",
    description="Get the current price and 24-hour stats for a trading pair.",
    args_schema=GetTickerInput,
)

# Pass tools to your LangChain agent:
# agent = initialize_agent([place_order_tool, get_ticker_tool], llm, ...)
```

---

## Depositing funds

Send USDC to the **TradingVault** contract on Base L2, then notify the exchange:

```
TradingVault contract: 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48
Network: Base L2 (chain ID 8453)
```

```python
# After your on-chain transfer is confirmed:
client.confirm_deposit(tx_hash="0xabc123...", asset="USDC")
```

## Withdrawing funds

```python
result = client.request_withdraw(amount="500", asset="USDC")
print("Withdraw ID:", result["withdrawId"])

# Once you see the on-chain tx:
client.confirm_withdraw(withdraw_id=result["withdrawId"], tx_hash="0xdef456...")
```

---

## API reference

| Method | Description |
|---|---|
| `place_order(pair, side, type, amount, price)` | Place a limit or market order |
| `cancel_order(order_id)` | Cancel an open order |
| `get_orders(pair, limit)` | List open/recent orders |
| `get_order_book(pair, depth)` | Fetch live order book |
| `get_ticker(pair)` | 24-hour price & volume stats |
| `get_trades(pair, limit)` | Recent public trades |
| `get_balance()` | Agent wallet balances |
| `confirm_deposit(tx_hash, asset)` | Notify exchange of on-chain deposit |
| `request_withdraw(amount, asset)` | Initiate a withdrawal |
| `confirm_withdraw(withdraw_id, tx_hash)` | Confirm on-chain withdrawal |
| `create_api_key(label)` | Create a new API key |

## License

MIT
