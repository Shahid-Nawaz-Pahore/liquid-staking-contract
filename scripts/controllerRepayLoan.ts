/*
 * TESTNET CHECKLIST
 * Before running: CONTROLLER_ADDRESS set or passed; controller state is REST; controller borrowedAmount > 0; controller has enough TON to return the loan
 * After running:  call get_validator_controller_data, get_loan(controllerId, validator, false), get_loan(controllerId, validator, true), get_pool_full_data
 * Known issues:   none specific beyond the controller profit-share bug already warned in recover flows
 */

import { NetworkProvider } from '@ton/blueprint';
import { toNano } from '@ton/core';
import { ControllerState } from '../PoolConstants';
import { Controller } from '../wrappers/Controller';
import { Pool } from '../wrappers/Pool';
import {
    confirmPrompt,
    fail,
    formatTon,
    getArgValue,
    getControllerState,
    getNetworkEnv,
    getPoolState,
    readSenderOrFail,
    resolveControllerAddress,
    waitForTransaction,
} from './scriptHelpers';

function formatUnixUtc(timestamp: number): string {
    return new Date(timestamp * 1000).toISOString().replace('.000Z', 'Z');
}

async function getLoanView(provider: NetworkProvider, controllerAddress: import('@ton/core').Address) {
    const controllerState = await getControllerState(provider, controllerAddress);
    if (controllerState.controllerId === null) {
        fail('Unable to derive controller id from pool getter; pass a known controller linked to the pool');
    }
    const pool = provider.open(Pool.createFromAddress(controllerState.pool));
    const current = await pool.getLoan(controllerState.controllerId, controllerState.validator, false);
    const previous = await pool.getLoan(controllerState.controllerId, controllerState.validator, true);
    const active = current.borrowed > 0n || current.interestAmount > 0n ? current : previous;
    const roundLabel = active === current ? 'current' : 'previous';

    return {
        controllerState,
        pool,
        current,
        previous,
        active,
        roundLabel,
        totalOwed: active.borrowed + active.interestAmount,
    };
}

export async function run(provider: NetworkProvider) {
    const sender = await readSenderOrFail(provider);
    const controllerAddress = await resolveControllerAddress(provider);
    const beforeView = await getLoanView(provider, controllerAddress);

    if (beforeView.controllerState.state !== ControllerState.REST) {
        fail(`Controller must be REST before return_unused_loan, got ${beforeView.controllerState.stateName}`);
    }
    if (beforeView.controllerState.borrowedAmount <= 0n && beforeView.totalOwed <= 0n) {
        fail('Controller has no outstanding loan to repay');
    }

    const attachedValue = toNano(
        (getArgValue('--value')
        ?? getNetworkEnv(provider, 'CONTROLLER_REPAY_VALUE')
        ?? (await provider.ui().input('TON to attach for return_unused_loan (default 0.5):')).trim()) || '0.5',
    );
    const poolBefore = await getPoolState(provider, beforeView.controllerState.pool);
    const borrowingTime = beforeView.controllerState.borrowingTime;
    const requestWindow = beforeView.controllerState.requestWindow;
    const now = Math.floor(Date.now() / 1000);

    provider.ui().write(`🧪 Loan source round:       ${beforeView.roundLabel}`);
    provider.ui().write(`💸 Borrowed principal:      ${formatTon(beforeView.active.borrowed)} TON`);
    provider.ui().write(`📈 Interest amount:         ${formatTon(beforeView.active.interestAmount)} TON`);
    provider.ui().write(`🧾 Total owed:              ${formatTon(beforeView.totalOwed)} TON`);
    provider.ui().write(`🏊 Pool totalBalance before:${formatTon(poolBefore.totalBalance)} TON`);
    provider.ui().write(`🕒 Borrowed at:             ${formatUnixUtc(borrowingTime)} UTC`);
    if (requestWindow) {
        provider.ui().write(`🕒 Current request window:  ${formatUnixUtc(requestWindow.since)} -> ${formatUnixUtc(requestWindow.until)} UTC`);
        provider.ui().write(`🕒 Current time:            ${formatUnixUtc(now)} UTC`);
        if (borrowingTime >= requestWindow.since) {
            fail('Loan was opened in the current validator round. return_unused_loan becomes valid only after the next validator-set start.');
        }
    }

    if (!(await confirmPrompt(provider, 'Proceed with loan repayment?'))) {
        provider.ui().write('🛑 Aborted');
        return;
    }

    const controller = provider.open(Controller.createFromAddress(controllerAddress));
    const ltBefore = (await provider.provider(controllerAddress).getState()).last?.lt ?? 0n;
    await controller.sendReturnUnusedLoan(sender, attachedValue);
    await waitForTransaction(provider, controllerAddress, ltBefore);

    const afterView = await getLoanView(provider, controllerAddress);
    const poolAfter = await getPoolState(provider, beforeView.controllerState.pool);
    const loanClosed =
        afterView.controllerState.borrowedAmount === 0n
        && afterView.current.borrowed === 0n
        && afterView.current.interestAmount === 0n
        && afterView.previous.borrowed === 0n
        && afterView.previous.interestAmount === 0n;

    provider.ui().write(loanClosed ? '✅ Loan closed confirmation: yes' : '⚠️ Loan closed confirmation: not fully closed yet');
    provider.ui().write(`🏦 Pool totalBalance before: ${formatTon(poolBefore.totalBalance)} TON`);
    provider.ui().write(`🏦 Pool totalBalance after:  ${formatTon(poolAfter.totalBalance)} TON`);
    provider.ui().write(`🔁 Round id before/after:    ${poolBefore.currentRound.roundId} -> ${poolAfter.currentRound.roundId}`);
    provider.ui().write(`📊 Round returned before:    ${formatTon(poolBefore.currentRound.returned)} TON`);
    provider.ui().write(`📊 Round returned after:     ${formatTon(poolAfter.currentRound.returned)} TON`);
    provider.ui().write(`📊 Round profit after:       ${formatTon(poolAfter.currentRound.profit)} TON`);

    if (!loanClosed) {
        fail('Loan repayment transaction completed but the loan is still open');
    }
}
