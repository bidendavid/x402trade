from typing import Any, Optional
from typing_extensions import TypedDict


class OrderBook(TypedDict):
    pair: str
    bids: list[list[str]]   # [[price, amount], ...]
    asks: list[list[str]]   # [[price, amount], ...]


class Ticker(TypedDict):
    pair: str
    price: str
    change24h: str
    volume24h: str


class Balance(TypedDict):
    usdc_balance: str
    eth_balance: str
    usdc_locked: str
    eth_locked: str


class OrderResult(TypedDict):
    orderId: str
    status: str
    filledAmount: str
    avgPrice: str


class AgentOrder(TypedDict):
    order_id: str
    pair: str
    side: str
    type: str
    amount: str
    price: Optional[str]
    filled_amount: str
    status: str


class WithdrawResult(TypedDict):
    success: bool
    withdrawId: str
    onchain: dict[str, Any]


class ApiKey(TypedDict):
    apiKey: str
    id: str
    label: str
