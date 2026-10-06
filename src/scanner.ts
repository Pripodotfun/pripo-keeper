import { KeeperError } from './errors.js';
import { PripoClient } from '@pripo/sdk';
import { marketAbi, marginVaultAbi } from '@pripo/sdk/abis';
import { getAbiItem, type Address, type Hex } from 'viem';
import { mapLimit, type Job, type Journal, type KeeperConfig } from './types.js';

export interface PositionSnapshot {
  user: Address;
  liquidatable: boolean;
  healthWad: bigint;
  liquidationPrice: bigint;
  liquidationReason: number;
  pending: boolean;
  readyBlock: bigint;
}
export interface MarketSnapshot {
  address: Address;
  external: boolean;
  degraded: boolean;
  terminal: boolean;
  binding: Address;
  positions: PositionSnapshot[];
  lastTouch: bigint;
  fees: bigint;
  excessInsurance: bigint;
}
export interface Snapshot {
  blockNumber: bigint;
  blockHash: Hex;
  timestamp: bigint;
  markets: MarketSnapshot[];
}

export class Scanner {
  private checkpoint: { number: bigint; hash: Hex } | undefined;
  private touches = new Map<string, bigint>();
  constructor(private readonly sdk: PripoClient, private readonly config: KeeperConfig) {}

  async scan(): Promise<Snapshot> {
    const rpc = this.sdk.publicClient;
    await this.sdk.assertChain();
    const head = await rpc.getBlock({ blockTag: 'latest' });
    if (head.number === null || !head.hash) throw new KeeperError('Executed head unavailable');
    if (this.checkpoint) {
      const previous = head.number < this.checkpoint.number ? undefined
        : await rpc.getBlock({ blockNumber: this.checkpoint.number });
      if (previous?.hash !== this.checkpoint.hash) {
        this.touches.clear(); this.checkpoint = undefined;
      }
    }
    const blockNumber = head.number;
    const markets: Address[] = [];
    for (let offset = 0n; ; offset += 100n) {
      const page = await this.sdk.listMarkets({ offset, limit: 100, blockNumber });
      if (page.total > BigInt(this.config.maxMarkets)) throw new KeeperError('Configured market limit exceeded');
      markets.push(...page.markets);
      if (offset + 100n >= page.total) break;
    }
    const snapshots = await mapLimit(markets, this.config.readConcurrency, async (address): Promise<MarketSnapshot> => {
      const market = this.sdk.market(address);
      const context = await market.liquidationContext({ blockNumber });
      const terminal = context.config.status >= 3; // Settling/Settled in the pinned runtime.
      const book = terminal ? { positions: [] } : await market.book({ blockNumber });
      const positions = await mapLimit(book.positions, this.config.readConcurrency, async (position): Promise<PositionSnapshot> => {
        const [health, price, pending] = await Promise.all([
          market.health(position.user, { blockNumber }), market.liquidationPrice(position.user, { blockNumber }),
          position.adlPending ? market.pendingAdl(position.user, { blockNumber }) : Promise.resolve(undefined),
        ]);
        return { user: position.user, healthWad: health.healthWad, liquidatable: health.liquidatable,
          liquidationPrice: price.price, liquidationReason: price.reason, pending: pending?.active ?? false,
          readyBlock: pending ? pending.since + BigInt(context.config.adlPendingWindow) : 0n };
      });
      const [binding, ledger, oi] = await Promise.all([
        market.fundingBinding({ blockNumber }),
        rpc.readContract({ address: this.config.vault, abi: marginVaultAbi, functionName: 'ledger', args: [address], blockNumber }),
        rpc.readContract({ address, abi: marketAbi, functionName: 'openInterest', blockNumber }),
      ]);
      // fundingState().lastBlock is a preview of the current block, not the persisted last touch.
      const lookback = BigInt(this.config.idleBlocks + 1);
      const floor = blockNumber > lookback ? blockNumber - lookback : 0n;
      const checkpoint = this.checkpoint?.number;
      let from = checkpoint === undefined ? floor : checkpoint > 8n ? checkpoint - 8n : 0n;
      if (from < floor) from = floor;
      let lastTouch = this.touches.get(address) ?? context.config.statusSince;
      for (; from <= blockNumber; from += BigInt(this.config.logChunkSize)) {
        const end = from + BigInt(this.config.logChunkSize) - 1n;
        const logs = await rpc.getLogs({ address, event: getAbiItem({ abi: marketAbi, name: 'FundingAccrued' }),
          fromBlock: from, toBlock: end < blockNumber ? end : blockNumber, strict: true });
        for (const log of logs) if (!log.removed && log.blockNumber !== null && log.blockNumber > lastTouch) lastTouch = log.blockNumber;
      }
      this.touches.set(address, lastTouch);
      const divisor = context.isExternal ? 20n : 10n;
      const retained = (oi[2] * 2n + divisor - 1n) / divisor;
      return { address, external: context.isExternal, degraded: context.degraded, terminal, binding, positions, lastTouch,
        fees: ledger.protocolOwed, excessInsurance: ledger.insurance > retained ? ledger.insurance - retained : 0n };
    });
    if ((await rpc.getBlock({ blockNumber })).hash !== head.hash) {
      this.touches.clear(); this.checkpoint = undefined;
      throw new KeeperError('Scan block was reorganized; rebuilding next scan');
    }
    this.checkpoint = { number: blockNumber, hash: head.hash };
    return { blockNumber, blockHash: head.hash, timestamp: head.timestamp, markets: snapshots };
  }
}

export function plan(snapshot: Snapshot, state: Journal, config: KeeperConfig): Job[] {
  const risk: Job[] = [], maintenance: Job[] = [], sweeps: Address[] = [];
  const due = (kind: string, address: Address, seconds: number) => snapshot.timestamp
    >= BigInt(state.completedAt[`${kind}:${address.toLowerCase()}`] ?? '0') + BigInt(seconds);
  for (const market of snapshot.markets) {
    if (!market.terminal) {
      for (const position of market.positions) {
        if (position.pending) {
          if (snapshot.blockNumber >= position.readyBlock) risk.push({ kind: 'completeAdl', market: market.address,
            user: position.user, iterations: config.adlIterations });
        } else if (position.liquidatable || (market.external && !market.degraded)) {
          // Active external markets must be simulated with a fresh pull update, even with healthy cached state.
          risk.push({ kind: 'liquidate', market: market.address, user: position.user });
        }
      }
      if (snapshot.blockNumber - market.lastTouch > BigInt(config.idleBlocks)) maintenance.push({ kind: 'poke', market: market.address });
    }
    if (market.excessInsurance > 0n && due('topUp', market.address, config.topUpSeconds)) {
      maintenance.push({ kind: 'topUp', market: market.address });
    }
    if (market.fees > 0n && due('sweep', market.address, config.sweepSeconds)) sweeps.push(market.address);
  }
  for (let i = 0; i < sweeps.length; i += 32) maintenance.push({ kind: 'sweep', markets: sweeps.slice(i, i + 32) });
  return [...risk, ...maintenance];
}
