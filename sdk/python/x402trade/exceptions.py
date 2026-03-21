class X402TradeError(Exception):
    def __init__(self, message: str, status_code: int = None, reason: str = None):
        super().__init__(message)
        self.status_code = status_code
        self.reason = reason


class InsufficientBalanceError(X402TradeError):
    def __init__(self, available: str):
        super().__init__(f"Insufficient balance: {available} available")
        self.available = available
