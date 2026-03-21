import base64
import json
import time
from typing import Optional

import httpx
from eth_account import Account
from eth_account.messages import encode_defunct

from .types import AgentOrder, ApiKey, Balance, OrderBook, OrderResult, Ticker, WithdrawResult
from .exceptions import X402TradeError, InsufficientBalanceError

DEFAULT_GATEWAY = "https://api.getx402.trade"


class X402TradeClient:
    """
    Client for the x402Trade exchange API.

    Authenticate with either a private_key (wallet signature) or an api_key header.
    All API calls are free — the platform earns 0.1% on fills only.
    """

    def __init__(
        self,
        private_key: Optional[str] = None,
        api_key: Optional[str] = None,
        gateway_url: str = DEFAULT_GATEWAY,
        timeout: float = 30.0,
    ):
        if not private_key and not api_key:
            raise ValueError("Either private_key or api_key is required")
        self._gateway = gateway_url.rstrip("/")
        self._timeout = timeout
        self._account = Account.from_key(private_key) if private_key else None
        self._api_key = api_key

    @property
    def wallet_address(self) -> Optional[str]:
        """Return the wallet address derived from the private key, or None for API-key auth."""
        return self._account.address if self._account else None

    def _auth_headers(self) -> dict:
        if self._api_key:
            return {"X-API-Key": self._api_key}
        # Wallet-signature auth — all endpoints are free (amount='0')
        nonce = str(int(time.time() * 1000))
        msg = encode_defunct(text=f"x402:{nonce}:0")
        signed = self._account.sign_message(msg)
        payload = base64.b64encode(
            json.dumps(
                {
                    "wallet": self._account.address,
                    "signature": signed.signature.hex(),
                    "amount": "0",
                    "nonce": nonce,
                }
            ).encode()
        ).decode()
        return {"x402-payment": payload}

    def _request(self, method: str, path: str, body: Optional[dict] = None) -> dict:
        headers = {"Content-Type": "application/json", **self._auth_headers()}
        with httpx.Client(timeout=self._timeout) as client:
            res = client.request(
                method,
                f"{self._gateway}{path}",
                headers=headers,
                json=body,
            )
        data = res.json()
        if not res.is_success:
            if res.status_code == 402 and data.get("error") == "Insufficient Balance":
                raise InsufficientBalanceError(str(data.get("available", "0")))
            raise X402TradeError(
                data.get("error", res.reason_phrase),
                status_code=res.status_code,
                reason=data.get("reason"),
            )
        return data

    # ── Trading ────────────────────────────────────────────────────────────

    def place_order(
        self,
        pair: str,
        side: str,
        type: str,
        amount: str,
        price: Optional[str] = None,
    ) -> OrderResult:
        """
        Place a limit or market order.

        Args:
            pair:   Trading pair, e.g. ``"ETH/USDC"``.
            side:   ``"buy"`` or ``"sell"``.
            type:   ``"limit"`` or ``"market"``.
            amount: Order size as a string, e.g. ``"0.5"``.
            price:  Limit price (required for limit orders).

        Returns:
            :class:`~x402trade.types.OrderResult`
        """
        body: dict = {"pair": pair, "side": side, "type": type, "amount": amount}
        if price:
            body["price"] = price
        return self._request("POST", "/trade", body)

    def cancel_order(self, order_id: str) -> None:
        """Cancel an open order by its ID."""
        self._request("DELETE", f"/orders/{order_id}")

    def get_orders(
        self, pair: Optional[str] = None, limit: int = 50
    ) -> list[AgentOrder]:
        """
        Return open/recent orders for the authenticated agent.

        Args:
            pair:  Optional filter by trading pair.
            limit: Maximum number of orders to return (default 50).
        """
        params = f"?limit={limit}"
        if pair:
            params += f"&pair={pair}"
        return self._request("GET", f"/orders{params}").get("orders", [])

    # ── Market data ────────────────────────────────────────────────────────

    def get_order_book(self, pair: str, depth: int = 20) -> OrderBook:
        """
        Fetch the live order book for a pair.

        Args:
            pair:  Trading pair, e.g. ``"ETH/USDC"``.
            depth: Number of price levels per side (default 20).
        """
        return self._request("GET", f"/orderbook?pair={pair}&depth={depth}")

    def get_ticker(self, pair: str) -> Ticker:
        """Fetch 24-hour price and volume statistics for a pair."""
        return self._request("GET", f"/ticker?pair={pair}")

    def get_trades(self, pair: str, limit: int = 50) -> list[dict]:
        """Return recent public trades for a pair."""
        return self._request("GET", f"/trades?pair={pair}&limit={limit}").get("trades", [])

    # ── Wallet ─────────────────────────────────────────────────────────────

    def get_balance(self) -> Balance:
        """Return the USDC and ETH balances for the authenticated agent wallet."""
        return self._request("GET", "/balance")

    def confirm_deposit(self, tx_hash: str, asset: str = "USDC") -> None:
        """
        Notify the exchange of an on-chain deposit transaction.

        Args:
            tx_hash: The transaction hash of the on-chain deposit.
            asset:   Asset being deposited, default ``"USDC"``.
        """
        if not self._account:
            raise ValueError("private_key required for deposit confirmation")
        self._request(
            "POST",
            "/deposit",
            {
                "wallet": self._account.address,
                "txHash": tx_hash,
                "asset": asset,
            },
        )

    def request_withdraw(self, amount: str, asset: str = "USDC") -> WithdrawResult:
        """
        Initiate a withdrawal from the exchange wallet.

        The request is signed with the agent's private key to authorise the transfer.

        Args:
            amount: Amount to withdraw as a string, e.g. ``"100"``.
            asset:  Asset to withdraw, default ``"USDC"``.
        """
        if not self._account:
            raise ValueError("private_key required for withdrawal")
        message = f"Withdraw {amount} {asset} from x402Trade"
        msg = encode_defunct(text=message)
        signed = self._account.sign_message(msg)
        return self._request(
            "POST",
            "/withdraw",
            {
                "wallet": self._account.address,
                "amount": amount,
                "asset": asset,
                "signature": signed.signature.hex(),
            },
        )

    def confirm_withdraw(self, withdraw_id: str, tx_hash: str) -> None:
        """
        Confirm that a withdrawal has been finalised on-chain.

        Args:
            withdraw_id: The withdraw ID returned by :meth:`request_withdraw`.
            tx_hash:     The on-chain transaction hash.
        """
        self._request(
            "POST",
            "/withdraw/confirm",
            {
                "withdrawId": withdraw_id,
                "txHash": tx_hash,
            },
        )

    # ── API Keys ───────────────────────────────────────────────────────────

    def create_api_key(self, label: str) -> ApiKey:
        """
        Create a new API key for the authenticated wallet.

        The creation request is signed so the exchange can verify ownership.

        Args:
            label: Human-readable label for the key, e.g. ``"my-bot-v1"``.
        """
        if not self._account:
            raise ValueError("private_key required to create API key")
        message = (
            f"x402Trade: create API key\n"
            f"wallet: {self._account.address.lower()}\n"
            f"label: {label}"
        )
        msg = encode_defunct(text=message)
        signed = self._account.sign_message(msg)
        return self._request(
            "POST",
            "/api-key/create",
            {
                "wallet": self._account.address,
                "signature": signed.signature.hex(),
                "label": label,
            },
        )
