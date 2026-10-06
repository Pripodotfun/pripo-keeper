import { PripoClient, PripoContractError, type PreparedTransaction } from '@pripo/sdk';
import type { LocalAccount } from 'viem';
import { JournalError, KeeperError } from './errors.js';
import { Scanner, plan, type Snapshot } from './scanner.js';
import { Transactions } from './transactions.js';
import { jobKey, type Job, type KeeperConfig, type Logger, type Store } from './types.js';

export class Keeper {
  private readonly scanner: Scanner;
  private readonly transactions: Transactions | undefined;
  private running = false;
  constructor(private readonly sdk: PripoClient, private readonly config: KeeperConfig,
    private readonly store: Store, private readonly log: Logger, signer?: LocalAccount) {
    this.scanner = new Scanner(sdk, config);
    this.transactions = signer ? new Transactions(sdk, config, store, signer, log) : undefined;
  }

  async tick(): Promise<Snapshot | undefined> {
    if (this.running) return undefined;
    this.running = true;
    try {
      await this.sdk.assertChain();
      const head = await this.sdk.publicClient.getBlockNumber({ cacheTime: 0 });
      await this.transactions?.recover(head);
      const snapshot = await this.scanner.scan();
      let eligible = 0, skipped = 0, failed = 0;
      for (const job of plan(snapshot, this.store.state, this.config)) {
        if (this.transactions && (!this.transactions.available || this.transactions.busy(job))) continue;
        try {
          const prepared = await this.prepare(job);
          eligible++;
          if (this.transactions) await this.transactions.submit(job, prepared, snapshot.blockNumber);
          else this.log('would-submit', { job: jobKey(job), gas: prepared.request.gas.toString() });
        } catch (error) {
          if (error instanceof JournalError) throw error;
          if (error instanceof PripoContractError && ['NotLiquidatable', 'NoPosition', 'NoPendingAdl',
            'AdlFallbackNotReady', 'AdlAlreadyPending', 'MarketNotActive'].includes(error.decoded.errorName)) skipped++;
          else { failed++; this.log('job-error', { job: jobKey(job), error: errorCode(error) }); }
        }
      }
      this.log('scan', { block: snapshot.blockNumber.toString(), markets: snapshot.markets.length,
        positions: snapshot.markets.reduce((n, m) => n + m.positions.length, 0), eligible, skipped, failed,
        pending: this.store.state.pending.length });
      return snapshot;
    } finally { this.running = false; }
  }

  private prepare(job: Job): Promise<PreparedTransaction> {
    switch (job.kind) {
      case 'liquidate': return this.sdk.market(job.market).prepareLiquidate({ user: job.user });
      case 'completeAdl': return this.sdk.market(job.market).prepareCompleteAdl(job.user, BigInt(job.iterations));
      case 'poke': return this.sdk.market(job.market).preparePoke();
      case 'sweep': return this.sdk.maintenance.prepareSweep(this.config.feeSweeper, job.markets);
      case 'topUp': return this.sdk.maintenance.prepareTopUp(this.config.backstop, job.market);
    }
  }
}

/** Do not log provider errors verbatim: many include authenticated RPC URLs or request payloads. */
export function errorCode(error: unknown): string {
  return error instanceof PripoContractError ? error.decoded.errorName : error instanceof KeeperError ? error.message
    : error instanceof Error ? error.name : 'UnknownError';
}
