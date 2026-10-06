import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { basename, join, resolve } from 'node:path';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { FileStore } from '../src/store.js';
import { Keeper } from '../src/keeper.js';
import { parseConfig } from '../src/config.js';
import { verifyDeployment } from '../src/deployment.js';
import { setTimeout as delay } from 'node:timers/promises';
import {
  createPublicClient, createWalletClient, encodeFunctionData, http, zeroHash,
  type Abi, type Address, type Hex,
} from 'viem';
import { foundry } from 'viem/chains';
import { mnemonicToAccount } from 'viem/accounts';
import { createPripoClient, PripoContractError, WAD } from '@pripo/sdk';
import { marginVaultAbi } from '@pripo/sdk/abis';

interface Artifact {
  abi: Abi;
  bytecode: { object: Hex; linkReferences: Record<string, Record<string, { start: number; length: number }[]>> };
}

test('keeper: liquidation, delayed ADL cursor recovery after restart, and fee sweep',
  { timeout: 180_000 }, async () => {
    assert.ok(process.env.PRIPO_CONTRACTS, 'Set PRIPO_CONTRACTS to a built checkout of the pinned contracts revision');
    const contracts = resolve(process.env.PRIPO_CONTRACTS);
    const manifest = JSON.parse(await readFile(new URL('../node_modules/@pripo/sdk/abi-manifest.json', import.meta.url), 'utf8'));
    const commit = execFileSync('git', ['-C', contracts, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    assert.equal(commit, manifest.commit, 'Integration artifacts must come from the ABI-pinned commit');
    execFileSync('git', ['-C', contracts, 'diff', '--exit-code', commit, '--', 'src'], { stdio: 'pipe' });

    const reservation = createServer();
    await new Promise<void>((done) => reservation.listen(0, '127.0.0.1', done));
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>((done, reject) => reservation.close((error) => error ? reject(error) : done()));
    const anvil = spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), '--silent', '--hardfork', 'cancun'],
      { stdio: ['ignore', 'ignore', 'pipe'] });
    let startupError: Error | undefined;
    let stderr = '';
    anvil.on('error', (error) => { startupError = error; });
    anvil.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
    const publicClient = createPublicClient({ chain: foundry, transport: http(`http://127.0.0.1:${port}`, { retryCount: 0 }),
      pollingInterval: 10, cacheTime: 0 });
    try {
      let ready = false;
      for (let attempt = 0; attempt < 50; attempt++) {
        if (startupError) throw startupError;
        if (anvil.exitCode !== null) throw new Error(`Anvil exited: ${stderr}`);
        try { await publicClient.getChainId(); ready = true; break; } catch { await delay(100); }
      }
      assert.ok(ready, 'Anvil did not start');
      const addresses = await createWalletClient({ chain: foundry,
        transport: http(`http://127.0.0.1:${port}`) }).getAddresses();
      const owner = addresses[0]!;
      // Anvil's public test mnemonic, used only with this test's freshly spawned local node.
      const operatorAccount = mnemonicToAccount('test test test test test test test test test test test junk',
        { addressIndex: 1 });
      const operator = operatorAccount.address;
      assert.equal(operator.toLowerCase(), addresses[1]!.toLowerCase());
      const walletClient = createWalletClient({ chain: foundry, account: owner,
        transport: http(`http://127.0.0.1:${port}`) });
      const receipt = async (hash: Hex) => {
        const result = await publicClient.waitForTransactionReceipt({ hash });
        assert.equal(result.status, 'success');
        return result;
      };
      const artifact = async (file: string, name: string): Promise<Artifact> =>
        JSON.parse(await readFile(name === 'RecoveryMarket' ? resolve('.test-artifacts/RecoveryMarket.sol/RecoveryMarket.json')
          : resolve(contracts, 'out', basename(file), `${name}.json`), 'utf8'));
      const libraries = new Map<string, Address>();
      const deploy = async (file: string, name: string, args: readonly unknown[] = []): Promise<Address> => {
        const build = await artifact(file, name);
        let code = build.bytecode.object.replace(/^0x/, '');
        for (const [source, names] of Object.entries(build.bytecode.linkReferences)) {
          for (const [library, refs] of Object.entries(names)) {
            const key = `${source}:${library}`;
            let address = libraries.get(key);
            if (!address) { address = await deploy(source, library); libraries.set(key, address); }
            for (const ref of refs) {
              assert.equal(ref.length, 20);
              code = code.slice(0, ref.start * 2) + address.slice(2) + code.slice((ref.start + ref.length) * 2);
            }
          }
        }
        const mined = await receipt(await walletClient.deployContract({ abi: build.abi, bytecode: `0x${code}`, args }));
        assert.ok(mined.contractAddress);
        return mined.contractAddress;
      };
      const usdc = await deploy('MockUSDC.sol', 'MockUSDC');
      const implementation = await deploy('MarginVault.sol', 'MarginVault');
      const vault = await deploy('ERC1967Proxy.sol', 'ERC1967Proxy', [implementation,
        encodeFunctionData({ abi: marginVaultAbi, functionName: 'initialize', args: [usdc, owner, owner, owner] })]);
      const nullAdapter = await deploy('NullAdapter.sol', 'NullAdapter');
      const marketImplementation = await deploy('RecoveryMarket.sol', 'RecoveryMarket');
      const factory = await deploy('MarketFactory.sol', 'MarketFactory', [vault, marketImplementation, nullAdapter, true]);
      const usdcAbi = (await artifact('MockUSDC.sol', 'MockUSDC')).abi;
      await receipt(await walletClient.writeContract({ address: usdc, abi: usdcAbi,
        functionName: 'mint', args: [owner, 20_000_000_000n] }));
      await receipt(await walletClient.writeContract({ address: usdc, abi: usdcAbi,
        functionName: 'approve', args: [vault, 10_000_000_000n] }));
      await receipt(await walletClient.writeContract({ address: vault, abi: marginVaultAbi,
        functionName: 'fundProtocolReserve', args: [10_000_000_000n] }));
      await receipt(await walletClient.writeContract({ address: vault, abi: marginVaultAbi,
        functionName: 'setRegistrar', args: [factory, true] }));

      const sweeper = await deploy('FeeSweeper.sol', 'FeeSweeper', [vault]);
      const backstop = await deploy('InsuranceBackstop.sol', 'InsuranceBackstop', [vault]);
      await receipt(await walletClient.writeContract({ address: vault, abi: marginVaultAbi,
        functionName: 'setBackstopController', args: [backstop] }));
      const sdk = createPripoClient({ publicClient, walletClient, chain: foundry, vault, factory });
      await receipt(await sdk.approveSeedBond(4_000_000_000n));
      for (let i = 0; i < 2; i++) await receipt(await sdk.createMarket({ symbol: `PRIPO:KEEPER-${i}`,
        priceSource: nullAdapter, feedId: zeroHash, initialPrice: 100n * WAD,
        depth: 2_000_000n * WAD, seedBond: 2_000_000_000n }));
      const list = await sdk.listMarkets();
      const first = sdk.market(list.markets[0]!);
      const second = sdk.market(list.markets[1]!);
      const trader = (account: Address) => createPripoClient({ publicClient, chain: foundry, vault, factory,
        walletClient: createWalletClient({ chain: foundry, account, transport: http(`http://127.0.0.1:${port}`) }) });
      const alice = owner, carol = addresses[1]!, bob = addresses[2]!;
      for (const account of [alice, carol, bob]) {
        await receipt(await walletClient.writeContract({ address: usdc, abi: usdcAbi, functionName: 'mint',
          args: [account, 10_000_000_000n] }));
        await receipt(await trader(account).vault.approveDeposit(10_000_000_000n));
        await receipt(await trader(account).vault.deposit(10_000_000_000n));
      }
      const harnessAbi = (await artifact('RecoveryMarket.sol', 'RecoveryMarket')).abi;
      const setCollateral = async (market: Address, user: Address, target: bigint) => receipt(
        await walletClient.writeContract({ address: market, abi: harnessAbi, functionName: 'testSetCollateral', args: [user, target] }));
      const open = async (market: Address, user: Address, size: bigint) => receipt(await trader(user).market(market)
        .open({ size, limitPrice: size > 0n ? 200n * WAD : 1n }));
      const mine = async (count: number) => publicClient.request({ method: 'anvil_mine' as never, params: [`0x${count.toString(16)}`] as never });
      await open(first.address, alice, 10n * WAD);
      await setCollateral(first.address, alice, 1n * WAD);
      assert.equal((await first.health(alice)).liquidatable, true);

      const keeperAccount = mnemonicToAccount('test test test test test test test test test test test junk', { addressIndex: 3 });
      const config = parseConfig({ chainId: foundry.id, factory, vault, feeSweeper: sweeper, backstop, pythAdapters: [],
        confirmations: 1, adlIterations: 1, idleBlocks: 600, minBalance: '0' }, keeperAccount.address);
      const keeperSdk = createPripoClient({ publicClient, chain: foundry, vault, factory, account: keeperAccount.address });
      assert.equal((await verifyDeployment(keeperSdk, config)).markets, '2');
      await assert.rejects(verifyDeployment(keeperSdk, { ...config, backstop: sweeper }), /wiring mismatch/);
      const dir = await mkdtemp(join(tmpdir(), 'pripo-keeper-e2e-'));
      let store = await FileStore.open(join(dir, 'journal.json'), 'local-test');
      const events: { event: string; fields: Record<string, unknown> }[] = [];
      const log = (event: string, fields: Record<string, unknown> = {}) => { events.push({ event, fields }); };
      let keeper = new Keeper(keeperSdk, config, store, log, keeperAccount);
      const tick = async () => {
        await keeper.tick();
        assert.deepEqual(events.filter((e) => e.event === 'job-error'), [], JSON.stringify(events));
      };
      try {
        // Observation performs simulation but does not sign or write any transaction.
        const beforeNonce = await publicClient.getTransactionCount({ address: keeperAccount.address });
        await new Keeper(keeperSdk, config, store, log).tick();
        assert.equal(await publicClient.getTransactionCount({ address: keeperAccount.address }), beforeNonce);
        assert.equal((await first.position(alice)).size, 10n * WAD);
        assert.ok(events.some((e) => e.event === 'would-submit'));
        await tick(); await tick();
        assert.equal((await first.position(alice)).size, 0n);
        assert.ok(events.some((e) => e.event === 'confirmed'));

        await open(second.address, alice, 10n * WAD);
        await open(second.address, carol, 10n * WAD);
        await open(second.address, bob, -20n * WAD);
        await open(second.address, carol, 1n * WAD);
        await receipt(await trader(carol).market(second.address).close({ sizeFraction: 2n * WAD / 11n, limitPrice: 1n }));
        await mine(300);
        const ledger = await publicClient.readContract({ address: vault, abi: marginVaultAbi, functionName: 'ledger', args: [second.address] });
        // Historical loss injection is test-only; liquidation and every ADL transition use production code.
        await setCollateral(second.address, alice, -ledger.insurance + WAD / 2n);
        await receipt(await second.liquidate({ user: alice, adlCandidates: [] }));
        const initial = await second.pendingAdl(alice);
        assert.equal(initial.active, true);
        await assert.rejects(second.prepareCompleteAdl(alice, 1n), (error: unknown) =>
          error instanceof PripoContractError && error.decoded.errorName === 'AdlFallbackNotReady');
        await mine(1000);
        await tick();
        const firstStep = await second.pendingAdl(alice);
        assert.equal(firstStep.active, true); assert.equal(firstStep.cursor, 1);
        assert.ok(store.state.pending.some((p) => p.job.kind === 'completeAdl'));
        // Restart after inclusion, before receipt reconciliation. The cursor is recovered from the chain.
        await store.close(); store = await FileStore.open(join(dir, 'journal.json'), 'local-test');
        keeper = new Keeper(keeperSdk, config, store, log, keeperAccount);
        for (let i = 0; i < 8 && (await second.pendingAdl(alice)).active; i++) await tick();
        await tick();
        assert.equal((await second.pendingAdl(alice)).active, false);
        assert.equal((await second.position(alice)).size, 0n);
        assert.equal(await publicClient.readContract({ address: vault, abi: marginVaultAbi,
          functionName: 'adlReservedTotal', args: [second.address] }), 0n);
        assert.ok(events.some((e) => e.event === 'submitted' && e.fields.kind === 'sweep'));
        console.log('Verified observation, liquidation, bounded ADL restart recovery, and fee sweeping against linked local contracts');
      } finally { await store.close(); await rm(dir, { recursive: true, force: true }); }
    } finally {
      anvil.kill('SIGTERM');
      if (anvil.pid && anvil.exitCode === null) await new Promise<void>((done) => anvil.once('exit', () => done()));
    }
  });
