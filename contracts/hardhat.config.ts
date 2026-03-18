import { HardhatUserConfig } from 'hardhat/config';
import '@nomicfoundation/hardhat-toolbox';
import dotenv from 'dotenv';

dotenv.config({ path: '../.env' });

const PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY || '0x' + '0'.repeat(64);
const BASESCAN_API_KEY = process.env.BASESCAN_API_KEY || '';

const config: HardhatUserConfig = {
  solidity: {
    version: '0.8.20',
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
  networks: {
    hardhat: { chainId: 31337 },
    base: {
      url: process.env.BASE_RPC_URL || 'https://mainnet.base.org',
      accounts: [PRIVATE_KEY],
      chainId: 8453,
    },
    baseSepolia: {
      url: process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org',
      accounts: [PRIVATE_KEY],
      chainId: 84532,
    },
  },
  etherscan: {
    apiKey: { base: BASESCAN_API_KEY, baseSepolia: BASESCAN_API_KEY },
    customChains: [
      {
        network: 'base',
        chainId: 8453,
        urls: { apiURL: 'https://api.basescan.org/api', browserURL: 'https://basescan.org' },
      },
      {
        network: 'baseSepolia',
        chainId: 84532,
        urls: { apiURL: 'https://api-sepolia.basescan.org/api', browserURL: 'https://sepolia.basescan.org' },
      },
    ],
  },
  paths: { sources: './contracts', tests: './test', cache: './cache', artifacts: './artifacts' },
};

export default config;
