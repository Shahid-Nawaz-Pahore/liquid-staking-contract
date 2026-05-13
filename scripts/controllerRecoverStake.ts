/*
 * TESTNET CHECKLIST
 * Before running: CONTROLLER_ADDRESS and ELECTOR_ADDRESS set or passed; controller state is FUNDS_STAKEN; elector reports returned stake > 0
 * After running:  call get_validator_controller_data, compute_returned_stake(controller), get_pool_full_data, get_loan(controllerId, validator)
 * Known issues:   warn if borrowed_amount == 0 while profit_share > 0 because repayment math can incorrectly charge profit share on pure validator profit
 */

import { NetworkProvider } from '@ton/blueprint';
import { toNano } from '@ton/core';
import { Conf, ControllerState } from '../PoolConstants';
import { Controller } from '../wrappers/Controller';
import { Elector } from '../wrappers/Elector';
import {
    confirmPrompt,
    fail,
    formatTon,
    getArgValue,
    getControllerState,
    getPoolState,
    getNetworkEnv,
    maxBigInt,
    readSenderOrFail,
    resolveControllerAddress,
    resolveElectorAddress,
    waitForTransaction,
    warnIfKnownBug,
} from './scriptHelpers';

async function waitForRecoverResponse(
    provider: NetworkProvider,
    controllerAddress: import('@ton/core').Address,
    timeoutMs = 90_000,
    pollMs = 3_000,
) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        const snapshot = await getControllerState(provider, controllerAddress);
        if (snapshot.state !== ControllerState.SENT_RECOVER_REQUEST) {
            return snapshot;
        }
        provider.ui().write('⏳ Waiting for elector recover response...');
        await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    return getControllerState(provider, controllerAddress);
}

export async function run(provider: NetworkProvider) {
    const sender = await readSenderOrFail(provider);
    const controllerAddress = await resolveControllerAddress(provider);
    const electorAddress = await resolveElectorAddress(provider);

    const before = await getControllerState(provider, controllerAddress);
    if (before.state !== ControllerState.FUNDS_STAKEN && before.state !== ControllerState.SENT_RECOVER_REQUEST) {
        fail(`Controller must be FUNDS_STAKEN or WAITING_FOR_ELECTOR_RESPONSE, got ${before.stateName}`);
    }

    warnIfKnownBug(
        provider,
        before.borrowedAmount === 0n && before.approverSetProfitShare > 0,
        '⚠️  KNOWN BUG: borrowed_amount is 0 but profit_share > 0. Pool will incorrectly take a share of pure validator profit on repayment.',
    );

    const elector = provider.open(Elector.createFromAddress(electorAddress));
    const recoverableBefore = await elector.getReturnedStake(controllerAddress).catch(() => 0n);
    if (before.state === ControllerState.FUNDS_STAKEN && recoverableBefore <= 0n) {
        fail('Elector reports zero returned stake for this controller. Wait until the stake unlocks before recovering.');
    }

    const poolBefore = await getPoolState(provider, before.pool);
    provider.ui().write(`🧪 Controller state before:  ${before.stateName}`);
    provider.ui().write(`💸 Borrowed amount before:   ${formatTon(before.borrowedAmount)} TON`);
    provider.ui().write(`🏛️ Recoverable from elector: ${formatTon(recoverableBefore)} TON`);

    if (before.state === ControllerState.SENT_RECOVER_REQUEST) {
        provider.ui().write('ℹ️ Recover request is already pending. No duplicate message will be sent.');
    } else {
        const attachedValue = toNano(
            (getArgValue('--value')
            ?? getNetworkEnv(provider, 'CONTROLLER_RECOVER_VALUE')
            ?? (await provider.ui().input(`TON to attach for recover_stake (default ${formatTon(Conf.electorOpValue)}):`)).trim()) || formatTon(Conf.electorOpValue),
        );

        if (!(await confirmPrompt(provider, 'Proceed with recover_stake?'))) {
            provider.ui().write('🛑 Aborted');
            return;
        }

        const controller = provider.open(Controller.createFromAddress(controllerAddress));
        const ltBefore = (await provider.provider(controllerAddress).getState()).last?.lt ?? 0n;
        await controller.sendRecoverStake(sender, attachedValue);
        await waitForTransaction(provider, controllerAddress, ltBefore);
    }

    const after = await waitForRecoverResponse(provider, controllerAddress);
    const poolAfter = await getPoolState(provider, before.pool);

    const repaidToPool = maxBigInt(before.borrowedAmount - after.borrowedAmount, 0n);
    const validatorKept = maxBigInt(after.contractBalance - Conf.minStorageController - after.borrowedAmount, 0n);
    const recoveredAmount = recoverableBefore > 0n ? recoverableBefore : repaidToPool + validatorKept;

    provider.ui().write('✅ Recover flow processed');
    provider.ui().write(`💰 Recovered amount:        ${formatTon(recoveredAmount)} TON`);
    provider.ui().write(`🏦 Repaid to pool:          ${formatTon(repaidToPool)} TON`);
    provider.ui().write(`👤 Validator kept:         ${formatTon(validatorKept)} TON`);
    provider.ui().write(`📌 Controller state after:  ${after.stateName}`);
    provider.ui().write(`🏊 Pool totalBalance after: ${formatTon(poolAfter.totalBalance)} TON`);
    provider.ui().write(`📝 Pool totalBalance delta: ${formatTon(poolAfter.totalBalance - poolBefore.totalBalance)} TON`);
}
