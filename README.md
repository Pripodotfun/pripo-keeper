# @pripo/keeper

Standalone TypeScript keeper for Pripo's implemented market runtime. Runs independently of the contracts and SDK repositories. Version 0.1.0 supports liquidation, delayed ADL completion, idle funding pokes, hourly fee sweeping and daily excess-insurance sweeping. It defaults to observation mode.

## Run

Requires Node 22+ and an HTTP RPC with historical `eth_call`, logs, gas estimation and receipt access.

```sh
npm ci
npm run check
cp .env.example .env
# Set KEEPER_RPC_URL and KEEPER_ADDRESS in .env.
node --env-file=.env dist/cli.js --once
node --env-file=.env dist/cli.js
```

`config/monad-testnet.json` targets the active October 6, 2026 **mUSDC demo**, chain 10143: factory `0x133A614CBE2CBA1789E67E0898C0F5c56Eb7BBf0` and vault `0x1980B3a41393f610a8BE552C71BAE3F42AAB6735`. Its collateral is freely minted Pripo Mock USDC, not Circle-issued USDC. The original native-USDC deployment remains available in `config/monad-testnet-native.json`.

Supply another configuration with `--config path.json` and give each deployment its own `KEEPER_STATE_PATH`; an existing journal is bound to its factory, vault, chain and signer. Startup verifies the factory, sweeper and backstop all use the configured vault, the factory is registered, and the vault has the configured backstop controller. A configured Pyth adapter must match the market's adapter exactly.

Observation mode reads state and simulates eligible calls from `KEEPER_ADDRESS`. It never signs or submits, even if a private key happens to be present. Use a separate state path if observing alongside an active keeper, because every process exclusively locks its journal.

To submit transactions, set `KEEPER_PRIVATE_KEY` to a **dedicated keeper account** funded with native gas tokens and run:

```sh
node --env-file=.env dist/cli.js --broadcast
```

If `KEEPER_ADDRESS` is also provided, it must match that key. Keeper actions are permissionless; no trading operator policy or token approval is needed. The keeper never uses a deployer key by default. `.env`, build outputs and `.state` are ignored by Git.

## Behavior

- Each scan rebuilds market membership and complete 128-slot position books at one executed block, including holes. It records health, tagged liquidation price, funding binding and pending ADL state. A changed checkpoint hash or regressed head clears cached funding touches; a changed scan block aborts that scan.
- Oracle-less and degraded markets use the runtime health result. Active external markets simulate every open position with a fresh Hermes update and exact adapter fee: cached health or a scalar liquidation threshold cannot rule out a liquidation after a price update. All actions are simulated and estimated immediately before signing.
- Normal liquidation lets the runtime rank its full book. Pending ADL uses `completeAdl` after its on-chain deadline, with at most 64 slot visits per call. Every subsequent scan reads the chain's cursor again, including after restart. The on-chain fallback also handles an insufficient eligible book. Immediate explicit-candidate `continueAdl` is available in the SDK but is not scheduled by this keeper.
- Idle detection uses `FundingAccrued` event blocks. `fundingState().lastBlock` is a preview and cannot measure idleness. The default poke threshold is more than 600 blocks.
- Fee sweeps include only markets with protocol fees, up to 32 per call. Successful sweeps start a one-hour interval per market. Excess insurance is swept daily through `InsuranceBackstop.topUp`; that call moves market insurance to the shared backstop and does not fund a market from the keeper wallet. Schedules use chain timestamps.
- `KEEPER_WS_URL` optionally supplies standard `newHeads` wakeups. HTTP snapshots remain authoritative, and periodic scans continue after subscription failures. The first version does not consume the node-local Monad Execution Events SDK. See [Monad's data sources](https://docs.monad.xyz/monad-arch/realtime-data/data-sources).

## Transactions and restart

The signer has a bounded pool of at most eight pending nonces, with one pending action per market. Risk actions precede maintenance. Gas limits, fee caps, native balance headroom, read concurrency and market count are bounded by configuration. Gas amounts are decimal strings in wei or gas units; interval units are explicit in configuration keys.

Before broadcasting, the keeper signs an EIP-1559 transaction and atomically writes its bytes and hash to disk, including file and directory fsync. RPC timeouts leave that entry pending. Restart verifies the signature, chain, nonce and hash, reconciles canonical receipts, then retransmits the identical bytes when due. It never signs a replacement merely because the original RPC response was lost. Successful scheduling waits for the configured confirmation count (default three). See [Monad JSON-RPC behavior](https://docs.monad.xyz/reference/json-rpc/overview) for asynchronous execution considerations; this keeper does not assume pending-transaction lookup is available.

Keep one persistent journal per signer/deployment. Do not share that signer with another process or wallet, and do not delete the journal to unblock a nonce. An untracked pending nonce or consumed nonce without a receipt suspends new work until reconciliation succeeds. A low-priced stuck transaction may require operator intervention: automatic fee replacement is not implemented. An expired Pyth payload may revert on eventual inclusion; after the receipt clears, the next attempt prepares a fresh update.

Storage failures stop the process. A heartbeat lock rejects simultaneous owners; after a killed process its lock becomes reclaimable after 30 seconds. Use a supervisor restart delay of at least 35 seconds and persistent local storage. The [proper-lockfile implementation](https://github.com/moxystudio/node-proper-lockfile) also terminates a process whose lock is compromised. SIGINT/SIGTERM finish the current tick, close subscriptions and release the lock. Already submitted transactions remain in the journal for the next start.

JSON logs include `scan`, `would-submit`, `submitted`, `submission-uncertain`, `confirmed`, `reverted`, `job-error` and `nonce-awaiting-receipt`. Provider errors are reduced to their error type to avoid printing authenticated URLs or payloads. Monitor missing scans, repeated submission uncertainty, reverted receipts and balance/gas-cap errors. No remote alert delivery is configured.

## SDK release boundary

The dependency is the checked-in `vendor/pripo-sdk-0.1.0.tgz`, installed with integrity recorded in `package-lock.json`. No sibling checkout, workspace link or Solidity build is needed to run the keeper. The SDK is private and has not been published to npm. Its canonical ABI manifest pins the contracts revision; `vendor/provenance.json` records the SDK source commit and archive digest.

To upgrade, build and test the SDK in its own repository, bump its version, pack a new archive, then update this repository's exact dependency and lockfile. Review ABI and runtime changes before changing the contracts pin. Once releases are published, an exact npm version can replace the archive dependency.

## Validation

```sh
npm run check
# The separate contracts checkout must be built and match the SDK ABI manifest.
PRIPO_CONTRACTS=/path/to/pripo-contract npm run test:integration
```

Unit tests cover scheduling, fresh-price eligibility, ADL deadlines, bounded nonces, timeout/restart handling, persistence failure, corrupted transactions, lock exclusivity, confirmation/revert handling and scan reorg recovery.

Integration starts an isolated Anvil, deploys the linked production factory/vault and market runtime, and verifies observation, liquidation, bounded ADL cursor progress across restart, reservation cleanup and fee sweeping. The market implementation adds one explicitly test-only historical-loss injection method to make recovery scenarios reproducible. No external RPC or real key is used. The Solidity fixture is compiled with Foundry and the pinned contracts dependencies; it is never a deployable keeper artifact.

This is a first operational slice. Target-chain signed Pyth liquidation, charged gas measurements, sustained RPC load and native execution-stream latency remain to be validated. The snapshot scanner favors complete state reconstruction and has not been benchmarked for the configured maximum market count. Resolver `finalize` and stale wind-down jobs require implemented, deployed contract entry points and are not enabled here.

On October 6, 2026 at 14:16 UTC, an observation-only run verified the original native-USDC deployment at block **68,706,558** and completed a scan at **68,706,562**. That factory had **zero markets** and its vault protocol reserve was **zero**.

At 14:51 UTC, the active mUSDC demo passed wiring verification at block **68,713,547**, with **10,000 mUSDC** in protocol reserve. Its scan at **68,713,551** reported **zero markets**, zero pending transactions and no errors. These are historical snapshots. Neither run loaded a signing key or submitted a transaction, and neither establishes live liquidation, Pyth or fee behavior.
