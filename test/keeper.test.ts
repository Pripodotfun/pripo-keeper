import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keccak256, parseTransaction, TransactionReceiptNotFoundError, zeroAddress, type Address, type Hex } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import type { PripoClient, PreparedTransaction } from '@pripo/sdk';
import { parseConfig } from '../src/config.js';
import { FileStore } from '../src/store.js';
import { Transactions } from '../src/transactions.js';
import { Scanner, plan, type MarketSnapshot, type Snapshot } from '../src/scanner.js';
import { JournalError } from '../src/errors.js';
import type { Journal, Store } from '../src/types.js';

const signer = mnemonicToAccount('test test test test test test test test test test test junk');
const address = (n: number): Address => `0x${n.toString(16).padStart(40, '0')}`;
const config = () => parseConfig({ chainId: 31337, factory: address(1), vault: address(2), feeSweeper: address(3),
  backstop: address(4), pythAdapters: [] }, signer.address);
const journal = (): Journal => ({ version: 1, identity: 'test', pending: [], completedAt: {} });
const market = (): MarketSnapshot => ({ address: address(10), external: false, degraded: false, terminal: false,
  binding: zeroAddress, positions: [], lastTouch: 1000n, fees: 0n, excessInsurance: 0n });
const snapshot = (markets: MarketSnapshot[]): Snapshot => ({ blockNumber: 1000n, blockHash: `0x${'11'.repeat(32)}`, timestamp: 100000n, markets });

test('planner simulates fresh external prices and respects ADL deadlines and terminal markets', () => {
  const m = market();
  m.positions = [{ user: address(20), liquidatable: false, healthWad: 2n, liquidationPrice: 1n,
    liquidationReason: 0, pending: false, readyBlock: 0n }];
  assert.deepEqual(plan(snapshot([m]), journal(), config()), []);
  m.external = true;
  assert.equal(plan(snapshot([m]), journal(), config())[0]?.kind, 'liquidate');
  m.degraded = true;
  assert.equal(plan(snapshot([m]), journal(), config()).length, 0);
  m.positions[0]!.liquidatable = true;
  assert.equal(plan(snapshot([m]), journal(), config())[0]?.kind, 'liquidate');
  m.positions[0]!.pending = true; m.positions[0]!.readyBlock = 1001n;
  assert.equal(plan(snapshot([m]), journal(), config()).length, 0);
  m.positions[0]!.readyBlock = 1000n;
  assert.equal(plan(snapshot([m]), journal(), config())[0]?.kind, 'completeAdl');
  m.terminal = true;
  assert.equal(plan(snapshot([m]), journal(), config()).length, 0);
});

test('maintenance uses actual touches, completion timestamps and at most 32 sweep markets', () => {
  const markets = Array.from({ length: 33 }, (_, i) => ({ ...market(), address: address(i + 10), fees: 1n }));
  markets[0]!.lastTouch = 399n; markets[0]!.excessInsurance = 1n;
  const state = journal();
  let jobs = plan(snapshot(markets), state, config());
  assert.equal(jobs.filter((j) => j.kind === 'poke').length, 1);
  assert.equal(jobs.filter((j) => j.kind === 'topUp').length, 1);
  assert.deepEqual(jobs.filter((j) => j.kind === 'sweep').map((j) => j.markets.length), [32, 1]);
  state.completedAt[`topUp:${markets[0]!.address}`] = '99999';
  state.completedAt[`sweep:${markets[0]!.address}`] = '99999';
  jobs = plan(snapshot(markets), state, config());
  assert.equal(jobs.filter((j) => j.kind === 'topUp').length, 0);
  assert.deepEqual(jobs.filter((j) => j.kind === 'sweep').map((j) => j.markets.length), [32]);
});

function transactionFixture() {
  const state = journal();
  const order: string[] = []; const sent: Hex[] = [];
  const store: Store = { state, async save() { order.push('save'); } };
  let mined = 0, pendingNonce = 0, failSend = false;
  let receipt: { blockNumber: bigint; blockHash: Hex; status: 'success' | 'reverted' } | undefined;
  const hash = `0x${'11'.repeat(32)}` as Hex;
  const sdk = { assertChain: async () => {}, publicClient: {
    getTransactionCount: async ({ blockTag }: { blockTag: string }) => blockTag === 'latest' ? mined : pendingNonce,
    estimateFeesPerGas: async () => ({ maxFeePerGas: 10n, maxPriorityFeePerGas: 1n }),
    getBalance: async () => 10n ** 20n,
    sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
      order.push('send'); sent.push(serializedTransaction);
      if (failSend) throw new Error('timeout'); return keccak256(serializedTransaction);
    },
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      if (!receipt) throw new TransactionReceiptNotFoundError({ hash }); return receipt;
    },
    getBlock: async () => ({ hash, timestamp: 999n }),
  } } as unknown as PripoClient;
  const tx = new Transactions(sdk, config(), store, signer, () => {});
  const prepared: PreparedTransaction = { functionName: 'poke', blockNumber: 1n,
    request: { account: signer.address, chainId: 31337, to: address(10), data: '0x', value: 0n, gas: 21000n } };
  return { tx, state, order, sent, store, prepared, sdk,
    failSend: () => { failSend = true; }, mined: (n: number) => { mined = n; },
    remotePending: (n: number) => { pendingNonce = n; },
    confirm: (status: 'success' | 'reverted' = 'success') => { receipt = { blockNumber: 10n, blockHash: hash, status }; } };
}

test('durable signed bytes survive RPC timeout and restart; confirmation releases market lock', async () => {
  const f = transactionFixture(); f.failSend();
  await f.tx.submit({ kind: 'poke', market: address(10) }, f.prepared, 1n);
  assert.deepEqual(f.order, ['save', 'save', 'send']);
  assert.equal(f.tx.busy({ kind: 'liquidate', market: address(10), user: address(20) }), true);
  const recovered = new Transactions(f.sdk, config(), f.store, signer, () => {});
  await recovered.recover(21n);
  assert.equal(f.sent.length, 2); assert.equal(f.sent[1], f.sent[0]);
  assert.equal(parseTransaction(f.sent[0]!).nonce, 0);
  f.confirm(); await recovered.recover(11n);
  assert.equal(f.state.pending.length, 1, 'wait for three confirmations');
  await recovered.recover(12n);
  assert.equal(f.state.pending.length, 0);
  assert.equal(f.state.completedAt[`poke:${address(10)}`], '999');
});

test('bounded sequential nonces, unknown consumed nonce, and unrelated pending transactions', async () => {
  const f = transactionFixture();
  for (let i = 0; i < 8; i++) assert.equal(await f.tx.submit({ kind: 'poke', market: address(i + 10) }, f.prepared, 1n), true);
  assert.deepEqual(f.state.pending.map((p) => p.nonce), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(await f.tx.submit({ kind: 'poke', market: address(30) }, f.prepared, 1n), false);
  const g = transactionFixture(); g.remotePending(1);
  await assert.rejects(g.tx.submit({ kind: 'poke', market: address(10) }, g.prepared, 1n), /untracked pending/);
  g.remotePending(0); await g.tx.submit({ kind: 'poke', market: address(10) }, g.prepared, 1n);
  g.mined(1); await g.tx.recover(21n);
  assert.equal(g.tx.available, false); assert.equal(g.sent.length, 1);
});

test('persistence failures and tampered signed bytes never broadcast', async () => {
  const f = transactionFixture(); f.store.save = async () => { throw new Error('disk full'); };
  await assert.rejects(f.tx.submit({ kind: 'poke', market: address(10) }, f.prepared, 1n), JournalError);
  assert.equal(f.sent.length, 0); assert.equal(f.tx.available, false);
  const g = transactionFixture(); await g.tx.submit({ kind: 'poke', market: address(10) }, g.prepared, 1n);
  g.state.pending[0]!.nonce++;
  await assert.rejects(g.tx.recover(21n), /Invalid signed transaction/);
  assert.equal(g.sent.length, 1);
});

test('reverts release the nonce without recording a successful maintenance schedule', async () => {
  const f = transactionFixture(); await f.tx.submit({ kind: 'poke', market: address(10) }, f.prepared, 1n);
  f.confirm('reverted'); await f.tx.recover(12n);
  assert.equal(f.state.pending.length, 0); assert.deepEqual(f.state.completedAt, {});
});

test('file journal excludes concurrent processes, persists state, and rejects foreign or corrupt state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pripo-journal-')); const file = join(dir, 'journal.json');
  try {
    const first = await FileStore.open(file, 'test');
    try {
      await assert.rejects(FileStore.open(file, 'test'), /already being held/);
      first.state.completedAt['sweep:test'] = '123'; await first.save();
      assert.equal(JSON.parse(await readFile(file, 'utf8')).completedAt['sweep:test'], '123');
    } finally { await first.close(); }
    const second = await FileStore.open(file, 'test'); await second.close();
    await assert.rejects(FileStore.open(file, 'different'), /identity or schema/);
    await writeFile(file, JSON.stringify({ ...journal(), pending: [{}] }));
    await assert.rejects(FileStore.open(file, 'test'), /identity or schema/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('configuration rejects unsafe limits and ambiguous money units', () => {
  const c = config();
  assert.throws(() => parseConfig({ ...c, maxPending: 9, gasBuffer: '10000' }, signer.address), /maxPending/);
  assert.throws(() => parseConfig({ ...c, maxFeePerGas: 200 }, signer.address), /decimal integer string/);
});

test('scanner pins reads, rebuilds funding touches after reorg, and handles a regressed head', async () => {
  let head = 1000n, fork = '11', touch: bigint | undefined = 990n;
  const hash = () => `0x${fork.repeat(32)}` as Hex;
  const checkRead = ({ blockNumber }: { blockNumber?: bigint }) => assert.equal(blockNumber, head);
  const sdk = { assertChain: async () => {}, listMarkets: async (o: { blockNumber: bigint }) => {
    checkRead(o); return { total: 1n, markets: [address(10)] };
  }, market: () => ({
    liquidationContext: async (o: { blockNumber: bigint }) => { checkRead(o);
      return { config: { status: 0, statusSince: 1n }, isExternal: false, degraded: false }; },
    book: async (o: { blockNumber: bigint }) => { checkRead(o); return { positions: [] }; },
    fundingBinding: async (o: { blockNumber: bigint }) => { checkRead(o); return zeroAddress; },
  }), publicClient: {
    getBlock: async ({ blockNumber }: { blockNumber?: bigint }) => {
      assert.ok(blockNumber === undefined || blockNumber <= head, 'do not request checkpoint beyond regressed head');
      return { number: blockNumber ?? head, hash: hash(), timestamp: 100000n };
    },
    readContract: async (o: { functionName: string; blockNumber: bigint }) => { checkRead(o);
      return o.functionName === 'ledger' ? { protocolOwed: 0n, insurance: 0n } : [0n, 0n, 0n]; },
    getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) =>
      touch !== undefined && touch >= fromBlock && touch <= toBlock ? [{ removed: false, blockNumber: touch }] : [],
  } } as unknown as PripoClient;
  const scanner = new Scanner(sdk, config());
  assert.equal((await scanner.scan()).markets[0]!.lastTouch, 990n);
  head = 1001n; fork = '22'; touch = undefined;
  assert.equal((await scanner.scan()).markets[0]!.lastTouch, 1n);
  head = 500n; fork = '33'; touch = 499n;
  assert.equal((await scanner.scan()).markets[0]!.lastTouch, 499n);
});
