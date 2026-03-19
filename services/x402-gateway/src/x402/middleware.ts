import http from 'http';
import { Request, Response, NextFunction } from 'express';
import { x402Config, EndpointConfig } from './config';
import { verifyX402Payment, markNonceUsed, X402Payment } from './verify';
import { deductApiPayment } from '../lib/db';
import { x402PaymentsTotal, x402PaymentDuration, riskCheckDuration, riskRateLimited } from '../lib/metrics';

function checkRisk(wallet: string): Promise<{ allowed: boolean; reason?: string }> {
  return new Promise((resolve) => {
    const RISK_URL = process.env.RISK_CONTROL_URL || 'http://localhost:8084';
    const body = JSON.stringify({ wallet });
    const url = new URL('/check', RISK_URL);
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch { resolve({ allowed: false, reason: 'Risk service response invalid' }); }
        });
      }
    );
    req.on('error', () => resolve({ allowed: false, reason: 'Risk service unavailable' }));
    req.write(body);
    req.end();
  });
}

declare global {
  namespace Express {
    interface Request {
      x402Payment?: X402Payment;
      agentWallet?: string;
    }
  }
}

function findEndpointConfig(method: string, path: string): EndpointConfig | undefined {
  // Exact match first
  const exact = x402Config[`${method} ${path}`];
  if (exact) return exact;
  // Prefix match for dynamic routes (e.g. DELETE /orders/uuid → DELETE /orders)
  const basePath = '/' + path.split('/')[1];
  return x402Config[`${method} ${basePath}`];
}

export function x402Middleware(req: Request, res: Response, next: NextFunction): void {
  const config = findEndpointConfig(req.method, req.path);

  if (!config) {
    next();
    return;
  }

  const paymentHeader = req.headers['x402-payment'] as string | undefined;

  if (!paymentHeader) {
    x402PaymentsTotal.inc({ result: 'missing' });
    res.status(402).json({
      error: 'Payment Required',
      x402: {
        endpoint: `${req.method} ${req.path}`,
        price: config.price,
        accepts: config.accepts,
        description: config.description,
        payTo: 'internal-balance',
        network: 'base',
        token: 'USDC',
        howTo: 'Deposit USDC via POST /deposit, then sign message `x402:<nonce>:<amount>` with your wallet',
      },
    });
    return;
  }

  const endPayment = x402PaymentDuration.startTimer();
  verifyX402Payment(paymentHeader, config.price)
    .then(async (result) => {
      endPayment();

      if (!result.valid) {
        x402PaymentsTotal.inc({ result: 'invalid' });
        res.status(402).json({ error: 'Invalid Payment', reason: result.reason });
        return;
      }

      const payment = result.payment!;

      // Risk check BEFORE touching funds — fail closed on service error
      const endRisk = riskCheckDuration.startTimer();
      const risk = await checkRisk(payment.wallet);
      endRisk();
      if (!risk.allowed) {
        riskRateLimited.inc();
        res.status(429).json({ error: 'Rate limited', reason: risk.reason });
        return;
      }

      // Mark nonce BEFORE deduction — prevents replay window on crash between deduct and mark
      await markNonceUsed(payment.wallet, payment.nonce);

      // Deduct from internal USDC balance — atomic, returns false if insufficient
      const deducted = await deductApiPayment(payment.wallet, config.price);
      if (!deducted) {
        // Nonce is burned intentionally — prevents replay even if balance was insufficient
        x402PaymentsTotal.inc({ result: 'insufficient' });
        res.status(402).json({
          error: 'Insufficient Balance',
          reason: `Requires ${config.price} USDC. Fund your account via POST /deposit.`,
          wallet: payment.wallet,
        });
        return;
      }

      x402PaymentsTotal.inc({ result: 'valid' });
      req.x402Payment = payment;
      req.agentWallet = payment.wallet;

      next();
    })
    .catch((err) => {
      endPayment();
      res.status(500).json({ error: 'Payment verification failed', message: (err as Error).message });
    });
}
