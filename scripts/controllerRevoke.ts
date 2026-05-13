/*
 * TESTNET CHECKLIST
 * Before running: sender == pool.approver; controller deployed; controller.approved == true
 * After running:  call get_validator_controller_data and get_pool_full_data
 * Known issues:   none specific
 */

import { NetworkProvider } from '@ton/blueprint';
import { toNano } from '@ton/core';
import { Controller } from '../wrappers/Controller';
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
    if (!before.approved) {
        fail('Controller is already revoked');
    }

    const poolState = await getPoolState(provider, before.pool);
    if (!sender.address!.equals(poolState.approver)) {
        fail(`Sender ${sender.address!.toString()} is not pool approver ${poolState.approver.toString()}`);
    }

    provider.ui().write(`🧪 Controller approved before: ${before.approved}`);
    if (!(await confirmPrompt(provider, 'Proceed with controller revoke/disapprove?'))) {
        provider.ui().write('🛑 Aborted');
        return;
    }

    const controller = provider.open(Controller.createFromAddress(controllerAddress));
    const ltBefore = (await provider.provider(controllerAddress).getState()).last?.lt ?? 0n;
    await controller.sendApprove(sender, false, toNano(getArgValue('--value') ?? '0.1'));
    await waitForTransaction(provider, controllerAddress, ltBefore);

    const after = await getControllerState(provider, controllerAddress);
    provider.ui().write('✅ Controller revoke confirmed');
    provider.ui().write(`📌 approved before: ${before.approved}`);
    provider.ui().write(`📌 approved after:  ${after.approved}`);
}
