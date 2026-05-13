/*
 * TESTNET CHECKLIST
 * Before running: CONTROLLER_ADDRESS and ELECTOR_ADDRESS set or passed; controller approved; loan already credited; validator public/secret keys available
 * After running:  call get_validator_controller_data, get_max_stake_value, request_window_time, active_election_id, participates_in(validatorPubKey)
 * Known issues:   warn if get_max_stake_value returns -1 because the getter is known to be inverted in one valid staking case
 */

import { NetworkProvider } from '@ton/blueprint';
import { toNano } from '@ton/core';
import { Conf, ControllerState } from '../PoolConstants';
import { Controller } from '../wrappers/Controller';
import { Elector } from '../wrappers/Elector';
import {
    bufferFromHex,
    confirmPrompt,
    fail,
    formatTon,
    getArgValue,
    getControllerState,
    getNetworkEnv,
    readSenderOrFail,
    resolveControllerAddress,
    resolveElectorAddress,
    toBuffer32FromHex,
    waitForTransaction,
    warnIfKnownBug,
} from './scriptHelpers';

function parseUint(raw: string, field: string): number {
    const value = raw.trim();
    if (!/^\d+$/.test(value)) {
        fail(`${field} must be a non-negative integer`);
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) {
        fail(`${field} is too large`);
    }
    return parsed;
}

async function waitForStateSettle(
    provider: NetworkProvider,
    controllerAddress: import('@ton/core').Address,
    timeoutMs = 90_000,
    pollMs = 3_000,
) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        const snapshot = await getControllerState(provider, controllerAddress);
        if (snapshot.state !== ControllerState.SENT_BORROWING_REQUEST && snapshot.state !== ControllerState.SENT_STAKE_REQUEST) {
            return snapshot;
        }
        provider.ui().write(`⏳ Waiting for controller to settle from ${snapshot.stateName}...`);
        await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    fail('Timed out waiting for controller state to settle');
}

export async function run(provider: NetworkProvider) {
    const sender = await readSenderOrFail(provider);
    const controllerAddress = await resolveControllerAddress(provider);
    const electorAddress = await resolveElectorAddress(provider);

    let before = await getControllerState(provider, controllerAddress);
    if (before.state !== ControllerState.REST && before.state !== ControllerState.SENT_BORROWING_REQUEST) {
        fail(`Controller must be REST or SENT_BORROWING_REQUEST before staking, got ${before.stateName}`);
    }

    warnIfKnownBug(
        provider,
        before.maxStakeValue === -1n,
        '⚠️  KNOWN BUG: get_max_stake_value returned -1, this may be a getter inversion bug. Proceeding anyway — verify borrowing_time and utime_since manually before continuing.',
    );

    if (before.state === ControllerState.SENT_BORROWING_REQUEST) {
        provider.ui().write('ℹ️ Borrowing request is still settling. Waiting for controller to return to REST before staking...');
        before = await waitForStateSettle(provider, controllerAddress);
    }

    if (before.state !== ControllerState.REST) {
        fail(`Controller must be REST before sending new_stake, got ${before.stateName}`);
    }
    if (before.borrowedAmount <= 0n) {
        fail('Controller has no borrowed amount to stake');
    }

    const elector = provider.open(Elector.createFromAddress(electorAddress));
    const activeElectionId = await elector.getActiveElectionId();
    if (activeElectionId <= 0) {
        fail('Elector reports no active election id');
    }

    const publicKeyHex =
        getArgValue('--public-key')
        ?? getNetworkEnv(provider, 'VALIDATOR_PUBLIC_KEY_HEX')
        ?? (await provider.ui().input('Validator public key hex:')).trim();
    const secretKeyHex =
        getArgValue('--secret-key')
        ?? getNetworkEnv(provider, 'VALIDATOR_SECRET_KEY_HEX')
        ?? (await provider.ui().input('Validator secret key hex:')).trim();
    const adnlHex =
        getArgValue('--adnl')
        ?? getNetworkEnv(provider, 'VALIDATOR_ADNL_HEX')
        ?? '';
    const maxFactor = parseUint(
        (getArgValue('--max-factor')
        ?? getNetworkEnv(provider, 'VALIDATOR_MAX_FACTOR')
        ?? (await provider.ui().input('Max factor (default 65536):')).trim()) || '65536',
        'Max factor',
    );

    const publicKey = toBuffer32FromHex(publicKeyHex, 'validator public key');
    const secretKey = bufferFromHex(secretKeyHex, 'validator secret key');
    const adnlAddress = adnlHex ? BigInt(`0x${toBuffer32FromHex(adnlHex, 'validator ADNL').toString('hex')}`) : 0n;

    const defaultStakeAmount =
        before.maxStakeValue !== null && before.maxStakeValue > 0n ? formatTon(before.maxStakeValue) : undefined;
    const stakeAmountInput =
        (getArgValue('--amount')
        ?? (
            await provider.ui().input(
                defaultStakeAmount
                    ? `Stake amount in TON (default ${defaultStakeAmount}):`
                    : 'Stake amount in TON:',
            )
        ).trim())
        || defaultStakeAmount;
    if (!stakeAmountInput) {
        fail('Stake amount is required');
    }

    const stakeAmount = toNano(stakeAmountInput);
    if (stakeAmount <= 0n) {
        fail('Stake amount must be positive');
    }
    if (before.maxStakeValue !== null && before.maxStakeValue > 0n && stakeAmount > before.maxStakeValue) {
        fail(`Stake amount ${formatTon(stakeAmount)} exceeds get_max_stake_value ${formatTon(before.maxStakeValue)}`);
    }

    const attachedValue = toNano(
        (getArgValue('--value')
        ?? getNetworkEnv(provider, 'CONTROLLER_STAKE_VALUE')
        ?? (await provider.ui().input(`TON to attach for new_stake (default ${formatTon(Conf.electorOpValue)}):`)).trim()) || formatTon(Conf.electorOpValue),
    );

    const controller = provider.open(Controller.createFromAddress(controllerAddress));
    const electorStakeBefore = await elector.getStake(publicKey).catch(() => 0n);

    provider.ui().write(`🧪 Controller state before: ${before.stateName}`);
    provider.ui().write(`💸 Borrowed amount:         ${formatTon(before.borrowedAmount)} TON`);
    provider.ui().write(`🗳️ Active election id:      ${activeElectionId}`);
    provider.ui().write(`🥩 Stake amount:            ${formatTon(stakeAmount)} TON`);

    if (!(await confirmPrompt(provider, 'Proceed with controller new_stake?'))) {
        provider.ui().write('🛑 Aborted');
        return;
    }

    const ltBefore = (await provider.provider(controllerAddress).getState()).last?.lt ?? 0n;
    await controller.sendNewStake(
        sender,
        stakeAmount,
        publicKey,
        secretKey,
        activeElectionId,
        maxFactor,
        adnlAddress,
        1,
        attachedValue,
    );
    await waitForTransaction(provider, controllerAddress, ltBefore);

    let after = await getControllerState(provider, controllerAddress);
    if (after.state === ControllerState.SENT_STAKE_REQUEST) {
        provider.ui().write('⏳ Waiting for elector response to the stake request...');
        after = await waitForStateSettle(provider, controllerAddress);
    }

    const electorStakeAfter = await elector.getStake(publicKey).catch(() => 0n);
    const electorDelta = electorStakeAfter - electorStakeBefore;

    provider.ui().write('✅ Stake request confirmed');
    provider.ui().write(`📌 Stake amount sent:       ${formatTon(stakeAmount)} TON`);
    provider.ui().write(`📌 Controller state before: ${before.stateName}`);
    provider.ui().write(`📌 Controller state after:  ${after.stateName}`);
    provider.ui().write(`🏛️ Elector confirmation:    ${electorDelta > 0n ? `participation increased by ${formatTon(electorDelta)} TON` : 'no participation delta observed yet; inspect elector txs manually'}`);
}
