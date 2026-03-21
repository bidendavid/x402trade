/**
 * TradingVault contract client
 *
 * Wraps the on-chain TradingVault contract for:
 *   - Verifying deposits (Deposited event)
 *   - Executing withdrawals on behalf of users
 *   - Settling matched trades
 *
 * The DB is the fast ledger; the contract is the source of truth for custody.
 */
import { ethers } from 'ethers';

// ── ABI (only the functions/events we use) ─────────────────────────────────

const VAULT_ABI = [
  // Events
  'event Deposited(address indexed user, address indexed token, uint256 amount)',
  'event Withdrawn(address indexed user, address indexed token, uint256 amount)',
  'event Settled(address indexed buyer, address indexed seller, uint256 usdcAmount, uint256 ethAmount, uint256 fee)',

  // Read
  'function usdcBalance(address user) view returns (uint256)',
  'function ethBalance(address user) view returns (uint256)',
  'function balanceOf(address user) view returns (uint256 usdc, uint256 eth)',
  'function feeBps() view returns (uint256)',

  // Write (called by exchange backend signer)
  'function settle(address buyer, address seller, uint256 usdcAmount, uint256 ethAmount)',
];

const USDC_DECIMALS = 6;
const ETH_DECIMALS  = 18;

// ── Singleton provider / signer / contract ────────────────────────────────

let _provider: ethers.JsonRpcProvider | null = null;
let _signer:   ethers.Wallet | null = null;
let _vault:    ethers.Contract | null = null;

function getProvider(): ethers.JsonRpcProvider {
  if (!_provider) {
    const url = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
    _provider = new ethers.JsonRpcProvider(url);
  }
  return _provider;
}

function getSigner(): ethers.Wallet {
  if (!_signer) {
    const pk = process.env.EXCHANGE_BACKEND_KEY;
    if (!pk) throw new Error('EXCHANGE_BACKEND_KEY not set');
    _signer = new ethers.Wallet(pk, getProvider());
  }
  return _signer;
}

function getVault(): ethers.Contract {
  if (!_vault) {
    const addr = process.env.TRADING_VAULT_ADDRESS;
    if (!addr) throw new Error('TRADING_VAULT_ADDRESS not set');
    _vault = new ethers.Contract(addr, VAULT_ABI, getSigner());
  }
  return _vault;
}

// ── Public helpers ────────────────────────────────────────────────────────

/**
 * Verify that txHash contains a Deposited event from TradingVault for
 * the given user wallet. Returns the deposited amount (as a decimal string).
 *
 * Replaces the old USDC Transfer scan in deposit.ts.
 */
export async function verifyVaultDeposit(
  userWallet: string,
  txHash: string,
): Promise<{ amount: string; asset: 'USDC' | 'ETH' }> {
  const vaultAddr = process.env.TRADING_VAULT_ADDRESS;
  if (!vaultAddr) throw new Error('TRADING_VAULT_ADDRESS not set');

  const usdcAddr = (process.env.USDC_CONTRACT || '0x833589fCD6eDb6E08f4c7C32D4f71b54bA02913C').toLowerCase();
  const provider = getProvider();
  const receipt  = await provider.getTransactionReceipt(txHash);

  if (!receipt || receipt.status !== 1) {
    throw new Error('Transaction failed or not found');
  }

  const iface = new ethers.Interface(VAULT_ABI);

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== vaultAddr.toLowerCase()) continue;
    try {
      const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
      if (!parsed || parsed.name !== 'Deposited') continue;
      if (parsed.args.user.toLowerCase() !== userWallet.toLowerCase()) continue;

      const tokenAddr = (parsed.args.token as string).toLowerCase();
      const rawAmount = parsed.args.amount as bigint;

      if (tokenAddr === usdcAddr) {
        return {
          amount: ethers.formatUnits(rawAmount, USDC_DECIMALS),
          asset: 'USDC',
        };
      } else if (tokenAddr === ethers.ZeroAddress) {
        return {
          amount: ethers.formatUnits(rawAmount, ETH_DECIMALS),
          asset: 'ETH',
        };
      }
    } catch { /* not a matching log */ }
  }

  throw new Error('No matching Deposited event found in transaction');
}

/**
 * Call vault.settle() on-chain to finalize a matched trade.
 * The caller must be the authorized EXCHANGE_BACKEND_KEY.
 *
 * @param buyerWallet  Buyer's address
 * @param sellerWallet Seller's address
 * @param usdcAmount   USDC amount (decimal string, e.g. "100.000000")
 * @param ethAmount    ETH amount  (decimal string, e.g. "0.05")
 * @returns On-chain tx hash
 */
export async function settleOnChain(
  buyerWallet: string,
  sellerWallet: string,
  usdcAmount: string,
  ethAmount: string,
): Promise<string> {
  const vault = getVault();
  const usdcRaw = ethers.parseUnits(usdcAmount, USDC_DECIMALS);
  const ethRaw  = ethers.parseUnits(ethAmount,  ETH_DECIMALS);

  const tx: ethers.ContractTransactionResponse = await vault.settle(
    buyerWallet,
    sellerWallet,
    usdcRaw,
    ethRaw,
  );
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) throw new Error('settle() tx reverted');
  return tx.hash;
}

/**
 * Read on-chain balances for a user (for reconciliation / health checks).
 */
export async function getOnChainBalance(
  userWallet: string,
): Promise<{ usdc: string; eth: string }> {
  const vault = getVault();
  const [usdcRaw, ethRaw]: [bigint, bigint] = await vault.balanceOf(userWallet);
  return {
    usdc: ethers.formatUnits(usdcRaw, USDC_DECIMALS),
    eth:  ethers.formatUnits(ethRaw,  ETH_DECIMALS),
  };
}

export { getVault, getSigner, getProvider };
