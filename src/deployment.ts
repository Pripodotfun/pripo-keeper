import type { PripoClient } from '@pripo/sdk';
import { marketFactoryAbi, marginVaultAbi, feeSweeperAbi, insuranceBackstopAbi } from '@pripo/sdk/abis';
import { isAddressEqual } from 'viem';
import { KeeperError } from './errors.js';
import type { KeeperConfig } from './types.js';

/** Validate wiring even when the factory has no markets yet. */
export async function verifyDeployment(sdk: PripoClient, config: KeeperConfig) {
  await sdk.assertChain();
  const rpc = sdk.publicClient;
  const blockNumber = await rpc.getBlockNumber({ cacheTime: 0 });
  const [factoryVault, sweeperVault, backstopVault, controller, registered, reserve, count] = await Promise.all([
    rpc.readContract({ address: config.factory, abi: marketFactoryAbi, functionName: 'vault', blockNumber }),
    rpc.readContract({ address: config.feeSweeper, abi: feeSweeperAbi, functionName: 'vault', blockNumber }),
    rpc.readContract({ address: config.backstop, abi: insuranceBackstopAbi, functionName: 'vault', blockNumber }),
    rpc.readContract({ address: config.vault, abi: marginVaultAbi, functionName: 'backstopController', blockNumber }),
    rpc.readContract({ address: config.vault, abi: marginVaultAbi, functionName: 'registrars', args: [config.factory], blockNumber }),
    rpc.readContract({ address: config.vault, abi: marginVaultAbi, functionName: 'protocolReserve', blockNumber }),
    rpc.readContract({ address: config.factory, abi: marketFactoryAbi, functionName: 'marketCount', blockNumber }),
  ]);
  if (![factoryVault, sweeperVault, backstopVault].every((v) => isAddressEqual(v, config.vault))
    || !isAddressEqual(controller, config.backstop) || !registered) throw new KeeperError('Deployment wiring mismatch');
  return { block: blockNumber.toString(), markets: count.toString(), reserveWad: reserve.toString() };
}
