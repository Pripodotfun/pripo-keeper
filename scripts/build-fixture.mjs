import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

if (!process.env.PRIPO_CONTRACTS) throw new Error('Set PRIPO_CONTRACTS to the pinned contracts checkout');
const contracts = resolve(process.env.PRIPO_CONTRACTS);
if (!existsSync(resolve(contracts, 'lib/openzeppelin-contracts/contracts'))) throw new Error('Install the contracts Foundry dependencies first');
execFileSync('forge', ['build', '--root', '.', '--contracts', 'test/contracts', '--out', '.test-artifacts',
  '--cache-path', '.test-artifacts/cache', '--use', '0.8.30', '--via-ir', '--optimize', '--optimizer-runs', '200',
  '--evm-version', 'cancun', '--remappings', `pripo/=${contracts}/src/`,
  '--remappings', `@openzeppelin/contracts/=${contracts}/lib/openzeppelin-contracts/contracts/`], { stdio: 'inherit' });
