import { ethers } from 'hardhat';
import * as fs from 'fs';
import * as path from 'path';

const USDC_BASE_MAINNET  = '0x833589fCD6eDb6E08f4c7C32D4f71b54bA02913C';
const USDC_BASE_SEPOLIA  = process.env.USDC_BASE_SEPOLIA || USDC_BASE_MAINNET;

const TOKENS = {
  USDC: USDC_BASE_MAINNET,
  WETH: '0x4200000000000000000000000000000000000006',
  WBTC: '0x68f180fcCe6836688e9084f035309E29Bf0A2095',
  USDT: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2',
  LINK: '0x514910771AF9Ca656af840dff83E8264EcF986CA',
  OP:   '0x4200000000000000000000000000000000000042',
} as const;

async function main() {
  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();

  console.log(`Network:  ${network.name} (chainId: ${network.chainId})`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Balance:  ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH\n`);

  const usdcAddress = network.chainId === 8453n ? USDC_BASE_MAINNET : USDC_BASE_SEPOLIA;

  // Deploy AgentWallet
  console.log('Deploying AgentWallet...');
  const AgentWallet = await ethers.getContractFactory('AgentWallet');
  const agentWallet = await AgentWallet.deploy(usdcAddress);
  await agentWallet.waitForDeployment();
  const agentWalletAddr = await agentWallet.getAddress();
  console.log(`  AgentWallet → ${agentWalletAddr}`);

  // Deploy AgentExchangeCore
  console.log('Deploying AgentExchangeCore...');
  const AgentExchangeCore = await ethers.getContractFactory('AgentExchangeCore');
  const exchangeCore = await AgentExchangeCore.deploy(usdcAddress);
  await exchangeCore.waitForDeployment();
  const exchangeCoreAddr = await exchangeCore.getAddress();
  console.log(`  AgentExchangeCore → ${exchangeCoreAddr}`);

  // Create default trading pairs on mainnet
  if (network.chainId === 8453n) {
    console.log('\nCreating trading pairs...');
    for (const [name, t1] of [
      ['USDC/WETH', TOKENS.WETH],
      ['USDC/WBTC', TOKENS.WBTC],
      ['USDC/USDT', TOKENS.USDT],
      ['USDC/LINK', TOKENS.LINK],
      ['USDC/OP',   TOKENS.OP],
    ] as [string, string][]) {
      const tx = await exchangeCore.createPair(TOKENS.USDC, t1);
      await tx.wait();
      console.log(`  ✓ ${name}`);
    }
  }

  // Persist deployment record
  const record = {
    network: network.name,
    chainId: network.chainId.toString(),
    deployer: deployer.address,
    contracts: {
      AgentWallet: agentWalletAddr,
      AgentExchangeCore: exchangeCoreAddr,
    },
    usdc: usdcAddress,
    deployedAt: new Date().toISOString(),
  };

  const outPath = path.join(__dirname, '..', 'deployments.json');
  fs.writeFileSync(outPath, JSON.stringify(record, null, 2));
  console.log(`\nDeployment saved → ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
