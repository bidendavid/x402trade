import http from 'http';
import { Request, Response, NextFunction } from 'express';
import { x402Config, EndpointConfig } from './config';
import { verifyX402Payment, X402Payment } from './verify';
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
          try { resolve(JSON.parse(data)); } catch { resolve({ allowed: true }); }
        });
      }
    );
    req.on('error', () => resolve({ allowed: true })); // fail open
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

export function x402Middleware(req: Request, res: Response, next: NextFunction): void {
  const endpointKey = `${req.method} ${req.path}`;
  const config: EndpointConfig | undefined = x402Config[endpointKey];

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
        endpoint: endpointKey,
        price: config.price,
        accepts: config.accepts,
        description: config.description,
        paymentAddress: process.env.X402_PAYMENT_ADDRESS || '',
        network: 'base',
        token: 'USDC',
      },
    });
    return;
  }

  const endPayment = x402PaymentDuration.startTimer();
  verifyX402Payment(paymentHeader)
    .then(async (result) => {
      endPayment();
      if (!result.valid) {
        x402PaymentsTotal.inc({ result: 'invalid' });
        res.status(402).json({ error: 'Invalid Payment', reason: result.reason });
        return;
      }
      x402PaymentsTotal.inc({ result: 'valid' });
      req.x402Payment = result.payment;
      req.agentWallet = result.payment?.wallet;

      // Risk check (non-blocking on failure)
      if (req.agentWallet) {
        const endRisk = riskCheckDuration.startTimer();
        const risk = await checkRisk(req.agentWallet);
        endRisk();
        if (!risk.allowed) {
          riskRateLimited.inc();
          res.status(429).json({ error: 'Rate limited', reason: risk.reason });
          return;
        }
      }

      next();
    })
    .catch((err) => {
      endPayment();
      res.status(500).json({ error: 'Payment verification failed', message: (err as Error).message });
    });
}
