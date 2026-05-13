import { NetworkProvider } from '@ton/blueprint';
import { SendMode, toNano } from '@ton/core';
import { Conf } from '../PoolConstants';
import { Controller } from '../wrappers/Controller';
import {
    confirmPrompt,
    fail,
    formatTon,
    getArgValue,
    getControllerState,
    readSenderOrFail,
    resolveControllerAddress,
    waitForTransaction,
} from './scriptHelpers';

export async function run(provider: NetworkProvider) {
    const sender = await readSenderOrFail(provider);
    const controllerAddress = await resolveControllerAddress(provider);
    const before = await getControllerState(provider, controllerAddress);

    if (!sender.address!.equals(before.validator)) {
        fail(`Sender ${sender.address!.toString()} is not controller validator ${before.validator.toString()}`);
    }
    if (before.stateName !== 'REST') {
        fail(`Controller must be REST before validator withdrawal, got ${before.stateName}`);
    }
    if (before.borrowedAmount > 0n) {
        fail(`Controller still has borrowed amount ${formatTon(before.borrowedAmount)} TON`);
    }

    const safeMax = before.contractBalance > Conf.minStorageController
        ? before.contractBalance - Conf.minStorageController
        : 0n;
    if (safeMax <= 0n) {
        fail('Controller has no safely withdrawable balance above minimum storage reserve');
    }

    const amount = toNano(
        (getArgValue('--amount')
        ?? (await provider.ui().input(`Validator withdrawal amount in TON (max safe ${formatTon(safeMax)}):`)).trim())
        || formatTon(safeMax),
    );
    if (amount <= 0n) {
        fail('Withdrawal amount must be positive');
    }
    if (amount > safeMax) {
        fail(`Withdrawal amount ${formatTon(amount)} TON exceeds safe maximum ${formatTon(safeMax)} TON`);
    }

    const attachedValue = toNano(
        (getArgValue('--value')
        ?? (await provider.ui().input('TON to attach for withdraw_validator (default 0.2):')).trim())
        || '0.2',
    );

    provider.ui().write(`🧭 Controller:             ${controllerAddress.toString()}`);
    provider.ui().write(`👤 Validator sender:       ${sender.address!.toString()}`);
    provider.ui().write(`🏦 Controller balance:     ${formatTon(before.contractBalance)} TON`);
    provider.ui().write(`💸 Borrowed amount:        ${formatTon(before.borrowedAmount)} TON`);
    provider.ui().write(`🧾 Safe max withdrawal:    ${formatTon(safeMax)} TON`);
    provider.ui().write(`💰 Requested withdrawal:   ${formatTon(amount)} TON`);
    provider.ui().write(`⛽ Attached TON:           ${formatTon(attachedValue)} TON`);

    if (!(await confirmPrompt(provider, 'Proceed with validator withdrawal?'))) {
        provider.ui().write('🛑 Aborted');
        return;
    }

    const ltBefore = (await provider.provider(controllerAddress).getState()).last?.lt ?? 0n;
    await provider.provider(controllerAddress).internal(sender, {
        value: attachedValue,
        sendMode: SendMode.PAY_GAS_SEPARATELY,
        body: Controller.validatorWithdrawMessage(amount, 0),
    });
    await waitForTransaction(provider, controllerAddress, ltBefore);

    const after = await getControllerState(provider, controllerAddress);
    provider.ui().write('✅ Validator withdrawal confirmed');
    provider.ui().write(`🏦 Controller balance before: ${formatTon(before.contractBalance)} TON`);
    provider.ui().write(`🏦 Controller balance after:  ${formatTon(after.contractBalance)} TON`);
    provider.ui().write(`💸 Borrowed amount after:     ${formatTon(after.borrowedAmount)} TON`);
}
