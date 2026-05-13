/*
 * TESTNET CHECKLIST
 * Before running: sender == pool.approver; controller deployed; controller.approved == false
 * After running:  call get_validator_controller_data and get_pool_full_data
 * Known issues:   none specific
 */

import { NetworkProvider } from '@ton/blueprint';
import { toNano } from '@ton/core';
import { Controller } from '../wrappers/Controller';
import { Pool } from '../wrappers/Pool';
import {
    confirmPrompt,
    fail,
    getArgValue,
    getControllerState,
    getPoolState,
    readSenderOrFail,
    resolveControllerAddress,
    waitForTransaction,
} from './scriptHelpers';

export async function run(provider: NetworkProvider) {
    const sender = await readSenderOrFail(provider);
    const controllerAddress = await resolveControllerAddress(provider);
    const before = await getControllerState(provider, controllerAddress);
    if (before.approved) {
        fail('Controller is already approved');
    }

    const poolState = await getPoolState(provider, before.pool);
    if (!sender.address!.equals(poolState.approver)) {
        fail(`Sender ${sender.address!.toString()} is not pool approver ${poolState.approver.toString()}`);
    }

    const profitShare = Number((getArgValue('--profit-share') ?? (await provider.ui().input('Profit share (0-16777215, default 0):')).trim()) || '0');
    const allocationTon = (getArgValue('--allocation') ?? (await provider.ui().input('Allocation in TON (default 0 = unlimited):')).trim()) || '0';
    const startPrior = Number((getArgValue('--start-prior') ?? (await provider.ui().input('allowed_borrow_start_prior_elections_end (default 65536):')).trim()) || '65536');
    const value = toNano((getArgValue('--value') ?? (await provider.ui().input('TON to attach (default 0.2):')).trim()) || '0.2');

    provider.ui().write(`🧪 Controller approved before: ${before.approved}`);
    provider.ui().write(`👮 Approver wallet: ${poolState.approver.toString()}`);
    provider.ui().write(`🤝 Profit share to set: ${profitShare}`);

    if (!(await confirmPrompt(provider, 'Proceed with controller approval?'))) {
        provider.ui().write('🛑 Aborted');
        return;
    }

    const controller = provider.open(Controller.createFromAddress(controllerAddress));
    const ltBefore = (await provider.provider(controllerAddress).getState()).last?.lt ?? 0n;
    await controller.sendApproveExtended(sender, {
        startPriorElectionsEnd: startPrior,
        allocation: toNano(allocationTon),
        profitShare,
    }, value);
    await waitForTransaction(provider, controllerAddress, ltBefore);

    const after = await getControllerState(provider, controllerAddress);
    provider.ui().write('✅ Controller approval confirmed');
    provider.ui().write(`📌 approved before: ${before.approved}`);
    provider.ui().write(`📌 approved after:  ${after.approved}`);
    provider.ui().write(`🤝 profit share:    ${after.approverSetProfitShare}`);
}
