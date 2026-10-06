import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createPripoClient } from '@pripo/sdk';
import { createPublicClient, defineChain, getAddress, http, isAddressEqual, webSocket, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { parseConfig } from './config.js';
import { Keeper, errorCode } from './keeper.js';
import { FileStore } from './store.js';
import type { Logger } from './types.js';
import { JournalError, KeeperError } from './errors.js';
import { verifyDeployment } from './deployment.js';

const log: Logger = (event, fields = {}) => console.log(JSON.stringify({ time: new Date().toISOString(), event, ...fields }));

async function main() {
  const { values } = parseArgs({ options: { config: { type: 'string', default: 'config/monad-testnet.json' },
    once: { type: 'boolean', default: false }, broadcast: { type: 'boolean', default: false } } });
  const rpcUrl = process.env.KEEPER_RPC_URL;
  if (!rpcUrl) throw new KeeperError('KEEPER_RPC_URL is required');
  let signer;
  if (values.broadcast) {
    const key = process.env.KEEPER_PRIVATE_KEY;
    if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new KeeperError('Broadcast mode requires KEEPER_PRIVATE_KEY');
    signer = privateKeyToAccount(key as Hex);
  }
  const address = process.env.KEEPER_ADDRESS ? getAddress(process.env.KEEPER_ADDRESS) : signer?.address;
  if (!address) throw new KeeperError('Observation mode requires KEEPER_ADDRESS for accurate caller simulation');
  if (signer && !isAddressEqual(signer.address, address)) throw new KeeperError('KEEPER_ADDRESS does not match signing key');
  const config = parseConfig(JSON.parse(await readFile(values.config!, 'utf8')), address);
  const chain = defineChain({ id: config.chainId, name: 'Pripo keeper network',
    nativeCurrency: { name: 'Native', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl, { timeout: 10_000, retryCount: 1 }), cacheTime: 0 });
  const sdk = createPripoClient({ publicClient, chain, vault: config.vault, factory: config.factory,
    pythAdapters: config.pythAdapters, account: config.account, gasBuffer: config.gasBuffer });
  log('deployment-verified', await verifyDeployment(sdk, config));
  const identity = [config.chainId, config.factory.toLowerCase(), config.vault.toLowerCase(), config.account.toLowerCase()].join(':');
  const store = await FileStore.open(resolve(process.env.KEEPER_STATE_PATH ?? '.state/keeper.json'), identity);
  const keeper = new Keeper(sdk, config, store, log, signer);
  const stop = new AbortController();
  process.once('SIGINT', () => stop.abort()); process.once('SIGTERM', () => stop.abort());
  let unwatch: (() => void) | undefined;
  let closeSocket: (() => Promise<void>) | undefined;
  let wake: (() => void) | undefined;
  try {
    log('started', { chainId: config.chainId, account: address, mode: signer ? 'broadcast' : 'observe' });
    if (process.env.KEEPER_WS_URL && !values.once) {
      try {
        const events = createPublicClient({ chain, transport: webSocket(process.env.KEEPER_WS_URL, { reconnect: true }) });
        const socket = await events.transport.getRpcClient();
        closeSocket = async () => { socket.close(); };
        // Execution-backed block notifications are hints. Every wake triggers authoritative HTTP snapshots.
        unwatch = events.watchBlockNumber({ emitOnBegin: true, onBlockNumber: () => wake?.(),
          onError: () => log('subscription-error', { fallback: 'periodic-snapshot' }) });
      } catch { log('subscription-error', { fallback: 'periodic-snapshot' }); }
    }
    do {
      try { await keeper.tick(); }
      catch (error) { log('scan-error', { error: errorCode(error) }); if (values.once || error instanceof JournalError) throw error; }
      if (values.once || stop.signal.aborted) break;
      await new Promise<void>((done) => {
        const finish = () => { clearTimeout(timer); stop.signal.removeEventListener('abort', finish); wake = undefined; done(); };
        const timer = setTimeout(finish, config.pollIntervalMs);
        wake = finish; stop.signal.addEventListener('abort', finish, { once: true });
        if (stop.signal.aborted) finish();
      });
    } while (!stop.signal.aborted);
  } finally { unwatch?.(); await closeSocket?.(); await store.close(); }
}

main().catch((error) => { log('fatal', { error: errorCode(error) }); process.exitCode = 1; });
