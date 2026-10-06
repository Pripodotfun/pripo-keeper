import type { Address, Hex } from 'viem';

export type Job =
  | { kind: 'liquidate'; market: Address; user: Address }
  | { kind: 'completeAdl'; market: Address; user: Address; iterations: number }
  | { kind: 'poke'; market: Address }
  | { kind: 'sweep'; markets: Address[] }
  | { kind: 'topUp'; market: Address };

export function jobMarkets(job: Job): Address[] { return job.kind === 'sweep' ? job.markets : [job.market]; }
export function jobKey(job: Job): string {
  const users = 'user' in job ? `:${job.user.toLowerCase()}` : '';
  return `${job.kind}:${jobMarkets(job).map((a) => a.toLowerCase()).join(',')}${users}`;
}
export interface PendingTransaction {
  job: Job;
  hash: Hex;
  raw: Hex;
  nonce: number;
  cost: string;
  createdBlock: string;
  lastBroadcastBlock: string;
}
export interface Journal {
  version: 1;
  identity: string;
  pending: PendingTransaction[];
  completedAt: Record<string, string>;
}
export interface Store {
  readonly state: Journal;
  save(): Promise<void>;
}
export interface KeeperConfig {
  chainId: number;
  factory: Address;
  vault: Address;
  feeSweeper: Address;
  backstop: Address;
  pythAdapters: Address[];
  account: Address;
  pollIntervalMs: number;
  confirmations: number;
  maxPending: number;
  maxMarkets: number;
  readConcurrency: number;
  idleBlocks: number;
  logChunkSize: number;
  sweepSeconds: number;
  topUpSeconds: number;
  adlIterations: number;
  rebroadcastBlocks: number;
  gasBuffer: bigint;
  maxGas: bigint;
  maxFeePerGas: bigint;
  minBalance: bigint;
}
export type Logger = (event: string, fields?: Record<string, unknown>) => void;

export async function mapLimit<T, R>(items: readonly T[], concurrency: number, action: (item: T) => Promise<R>) {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) { const i = next++; results[i] = await action(items[i]!); }
  }));
  return results;
}
