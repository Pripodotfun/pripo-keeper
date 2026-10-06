import { KeeperError } from './errors.js';
import { getAddress, zeroAddress, type Address } from 'viem';
import type { KeeperConfig } from './types.js';

export function parseConfig(value: unknown, account: Address): KeeperConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new KeeperError('Config must be an object');
  const input = value as Record<string, unknown>;
  const integer = (key: string, fallback: number, min: number, max: number) => {
    const v = input[key] ?? fallback;
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max) throw new KeeperError(`Invalid ${key}`);
    return v;
  };
  const amount = (key: string, fallback: string) => {
    const v = input[key] ?? fallback;
    if (typeof v !== 'string' || !/^\d+$/.test(v)) throw new KeeperError(`${key} must be a decimal integer string`);
    return BigInt(v);
  };
  const address = (key: string): Address => {
    if (typeof input[key] !== 'string') throw new KeeperError(`Missing ${key}`);
    const result = getAddress(input[key]);
    if (result === zeroAddress) throw new KeeperError(`${key} cannot be zero`);
    return result;
  };
  if (!Array.isArray(input.pythAdapters) || input.pythAdapters.some((v) => typeof v !== 'string')) {
    throw new KeeperError('pythAdapters must be an address array');
  }
  const config: KeeperConfig = {
    chainId: integer('chainId', 0, 1, Number.MAX_SAFE_INTEGER), factory: address('factory'), vault: address('vault'),
    feeSweeper: address('feeSweeper'), backstop: address('backstop'), pythAdapters: input.pythAdapters.map((v) => getAddress(v)),
    account: getAddress(account), pollIntervalMs: integer('pollIntervalMs', 2000, 100, 60_000),
    confirmations: integer('confirmations', 3, 1, 100), maxPending: integer('maxPending', 8, 1, 8),
    maxMarkets: integer('maxMarkets', 100, 1, 10_000), readConcurrency: integer('readConcurrency', 4, 1, 16),
    idleBlocks: integer('idleBlocks', 600, 1, 100_000), logChunkSize: integer('logChunkSize', 100, 1, 1000),
    sweepSeconds: integer('sweepSeconds', 3600, 1, 86400), topUpSeconds: integer('topUpSeconds', 86400, 1, 604800),
    adlIterations: integer('adlIterations', 64, 1, 64), rebroadcastBlocks: integer('rebroadcastBlocks', 20, 1, 10_000),
    gasBuffer: amount('gasBuffer', '10000'), maxGas: amount('maxGas', '30000000'),
    maxFeePerGas: amount('maxFeePerGas', '200000000000'), minBalance: amount('minBalance', '100000000000000000'),
  };
  if (!config.maxGas || !config.maxFeePerGas || config.account === zeroAddress) throw new KeeperError('Invalid gas cap or account');
  return config;
}
