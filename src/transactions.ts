import {
  isAddressEqual, keccak256, parseTransaction, recoverTransactionAddress,
  TransactionReceiptNotFoundError, type LocalAccount, type TransactionSerialized,
} from 'viem';
import type { PripoClient, PreparedTransaction } from '@pripo/sdk';
import { JournalError, KeeperError } from './errors.js';
import { jobMarkets, type Job, type KeeperConfig, type Logger, type PendingTransaction, type Store } from './types.js';

/** Dedicated signer, at most eight in-flight nonces, and one pending action per market. */
export class Transactions {
  private uncertain = false;
  constructor(private readonly sdk: PripoClient, private readonly config: KeeperConfig,
    private readonly store: Store, private readonly account: LocalAccount, private readonly log: Logger) {
    if (!isAddressEqual(account.address, config.account)) throw new KeeperError('Signer/address mismatch');
  }

  busy(job: Job): boolean {
    return this.store.state.pending.some((pending) => jobMarkets(pending.job).some((address) =>
      jobMarkets(job).some((other) => isAddressEqual(address, other))));
  }
  get available(): boolean { return !this.uncertain && this.store.state.pending.length < this.config.maxPending; }

  async recover(head: bigint): Promise<void> {
    const rpc = this.sdk.publicClient;
    this.uncertain = false;
    for (const pending of [...this.store.state.pending]) {
      // Corrupted/misbound journal data must never be retransmitted.
      if (!pending.raw.startsWith('0x02')) throw new KeeperError('Unsupported journal transaction type');
      const transaction = parseTransaction(pending.raw);
      if (keccak256(pending.raw) !== pending.hash || transaction.nonce !== pending.nonce
        || transaction.chainId !== this.config.chainId
        || !isAddressEqual(await recoverTransactionAddress({ serializedTransaction: pending.raw as TransactionSerialized }), this.account.address)) {
        throw new KeeperError('Invalid signed transaction in journal');
      }
      let receipt;
      try { receipt = await rpc.getTransactionReceipt({ hash: pending.hash }); }
      catch (error) { if (!(error instanceof TransactionReceiptNotFoundError)) throw error; }
      if (receipt) {
        const block = await rpc.getBlock({ blockNumber: receipt.blockNumber });
        if (block.hash !== receipt.blockHash) { this.uncertain = true; continue; }
        if (head < receipt.blockNumber + BigInt(this.config.confirmations - 1)) continue;
        if (receipt.status === 'success') {
          for (const market of jobMarkets(pending.job)) this.store.state.completedAt[
            `${pending.job.kind}:${market.toLowerCase()}`] = block.timestamp.toString();
        }
        this.store.state.pending = this.store.state.pending.filter((p) => p.hash !== pending.hash);
        await this.store.save();
        this.log(receipt.status === 'success' ? 'confirmed' : 'reverted', { hash: pending.hash, nonce: pending.nonce });
        continue;
      }
      const minedNonce = await rpc.getTransactionCount({ address: this.account.address, blockTag: 'latest' });
      if (minedNonce > pending.nonce) {
        // Async execution/receipt lag or an outside transaction: do not silently forget the nonce.
        this.uncertain = true; this.log('nonce-awaiting-receipt', { nonce: pending.nonce, hash: pending.hash }); continue;
      }
      if (head >= BigInt(pending.lastBroadcastBlock) + BigInt(this.config.rebroadcastBlocks)) await this.broadcast(pending, head);
    }
  }

  async submit(job: Job, prepared: PreparedTransaction, head: bigint): Promise<boolean> {
    if (!this.available || this.busy(job)) return false;
    await this.sdk.assertChain();
    if (prepared.request.chainId !== this.config.chainId || !isAddressEqual(prepared.request.account, this.account.address)) {
      throw new KeeperError('Prepared sender/chain mismatch');
    }
    if (prepared.request.gas > this.config.maxGas) throw new KeeperError('Gas cap exceeded');
    const rpc = this.sdk.publicClient;
    const [mined, remotePending, fees, balance] = await Promise.all([
      rpc.getTransactionCount({ address: this.account.address, blockTag: 'latest' }),
      rpc.getTransactionCount({ address: this.account.address, blockTag: 'pending' }),
      rpc.estimateFeesPerGas(), rpc.getBalance({ address: this.account.address, blockTag: 'latest' }),
    ]);
    const localNext = this.store.state.pending.reduce((next, p) => Math.max(next, p.nonce + 1), mined);
    if (remotePending > localNext) throw new KeeperError('Signer has untracked pending transactions; use a dedicated keeper account');
    if (fees.maxFeePerGas > this.config.maxFeePerGas) throw new KeeperError('Gas price cap exceeded');
    const cost = prepared.request.gas * fees.maxFeePerGas + prepared.request.value;
    const reserved = this.store.state.pending.reduce((sum, p) => sum + BigInt(p.cost), 0n);
    if (balance < cost + reserved + this.config.minBalance) throw new KeeperError('Insufficient native balance headroom');
    const raw = await this.account.signTransaction({ to: prepared.request.to, data: prepared.request.data,
      value: prepared.request.value, gas: prepared.request.gas, chainId: this.config.chainId,
      type: 'eip1559', nonce: localNext, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas });
    const record: PendingTransaction = { job, hash: keccak256(raw), raw, nonce: localNext, cost: cost.toString(),
      createdBlock: head.toString(), lastBroadcastBlock: head.toString() };
    this.store.state.pending.push(record);
    try { await this.store.save(); }
    catch { this.uncertain = true; throw new JournalError('Journal persistence failed before submission'); }
    await this.broadcast(record, head);
    return true;
  }

  private async broadcast(record: PendingTransaction, head: bigint) {
    record.lastBroadcastBlock = head.toString();
    await this.store.save(); // Includes rebroadcasts: persistence failures must stop before RPC submission.
    try {
      const hash = await this.sdk.publicClient.sendRawTransaction({ serializedTransaction: record.raw });
      if (hash !== record.hash) throw new KeeperError('RPC returned an unexpected transaction hash');
      this.log('submitted', { hash, nonce: record.nonce, kind: record.job.kind });
    } catch {
      // The RPC may have accepted the transaction before losing its response. Retain bytes and nonce.
      this.log('submission-uncertain', { hash: record.hash, nonce: record.nonce });
    }
  }
}
