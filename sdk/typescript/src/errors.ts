export class X402TradeError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly reason?: string,
  ) {
    super(message);
    this.name = 'X402TradeError';
  }
}

export class InsufficientBalanceError extends X402TradeError {
  constructor(public readonly available: string) {
    super(`Insufficient balance: ${available} available`);
    this.name = 'InsufficientBalanceError';
  }
}
