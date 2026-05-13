/*
 * TESTNET CHECKLIST
 * Before running: sender is the validator wallet; if Step 2 is included then sender must also equal pool.approver; POOL_ADDRESS / ELECTOR_ADDRESS configured; validator keys configured
 * After running:  call get_pool_full_data, get_validator_controller_data, get_loan(controllerId, validator, false), get_loan(controllerId, validator, true), active_election_id, participates_in(pubKey), compute_returned_stake(controller)
 * Known issues:   full-cycle automation across split validator/approver roles is not possible with a single NetworkProvider sender; resume with --from-step when approvals are done from a separate wallet
 */

import { NetworkProvider } from '@ton/blueprint';
import { Address, toNano } from '@ton/core';
import { Conf, ControllerState } from '../PoolConstants';
import { Controller } from '../wrappers/Controller';
import { Elector } from '../wrappers/Elector';
import { Pool } from '../wrappers/Pool';
import {
    ControllerSnapshot,
    PoolSnapshot,
    bufferFromHex,
    confirmPrompt,
    formatTon,
    getArgValue,
    getControllerState,
    getNetworkEnv,
    getPoolState,
    maxBigInt,
    printControllerSnapshot,
    printPoolSnapshot,
    readSenderOrFail,
    resolveControllerAddress,
    resolveElectorAddress,
    resolvePoolAddress,
    toBuffer32FromHex,
    waitForTransaction,
    warnIfKnownBug,
} from './scriptHelpers';

type CycleContext = {
    poolAddress: Address;
    controllerAddress: Address;
    validatorAddress: Address;
    controllerId: number | null;
    electorAddress: Address;
};

type CycleMetrics = {
    feesPaid: bigint;
    initialFreeBalance: bigint;
    recoverableBeforeRecover: bigint | null;
    debtBeforeRecover: bigint | null;
};

function parseUint(raw: string, field: string): number {
    const value = raw.trim();
    if (!/^\d+$/.test(value)) {
        throw new Error(`${field} must be a non-negative integer`);
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) {
        throw new Error(`${field} is too large`);
    }
    return parsed;
}

function assertOrThrow(condition: unknown, message: string): asserts condition {
    if (!condition) {
        throw new Error(message);
    }
}

function controllerFreeBalance(snapshot: ControllerSnapshot): bigint {
    return maxBigInt(snapshot.contractBalance - Conf.minStorageController - snapshot.borrowedAmount, 0n);
}

async function sleep(ms: number) {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

async function isActive(provider: NetworkProvider, address: Address): Promise<boolean> {
    return (await provider.provider(address).getState()).state.type === 'active';
}

async function tryGetControllerState(provider: NetworkProvider, address: Address): Promise<ControllerSnapshot | null> {
    try {
        if (!(await isActive(provider, address))) {
            return null;
        }
        return await getControllerState(provider, address);
    } catch {
        return null;
    }
}

async function waitUntilSettled(
    provider: NetworkProvider,
    controllerAddress: Address,
    pendingStates: number[],
    timeoutMs = 120_000,
    pollMs = 3_000,
) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        const snapshot = await getControllerState(provider, controllerAddress);
        if (!pendingStates.includes(snapshot.state)) {
            return snapshot;
        }
        await sleep(pollMs);
    }
    throw new Error(`Timed out waiting for controller ${controllerAddress.toString()} to leave pending state`);
}

async function waitForState(
    provider: NetworkProvider,
    controllerAddress: Address,
    targetState: number,
    timeoutSec: number,
    label: string,
) {
    const started = Date.now();
    const timeoutMs = timeoutSec * 1000;
    while (Date.now() - started < timeoutMs) {
        const snapshot = await getControllerState(provider, controllerAddress);
        if (snapshot.state === targetState) {
            return snapshot;
        }
        const remaining = Math.max(0, timeoutSec - Math.floor((Date.now() - started) / 1000));
        provider.ui().write(`⏳ ${label} | state=${snapshot.stateName} | ${remaining}s remaining`);
        await sleep(5_000);
    }
    throw new Error(`Timed out waiting for controller state ${targetState}`);
}

async function resolveCycleContext(
    provider: NetworkProvider,
    senderAddress: Address,
    fromStep: number,
): Promise<CycleContext> {
    const electorAddress = await resolveElectorAddress(provider);
    const explicitController = getArgValue('--controller') ?? getNetworkEnv(provider, 'CONTROLLER_ADDRESS');

    if (explicitController || fromStep > 1) {
        const controllerAddress = explicitController ? Address.parse(explicitController) : await resolveControllerAddress(provider);
        const controllerState = await getControllerState(provider, controllerAddress);
        return {
            poolAddress: controllerState.pool,
            controllerAddress,
            validatorAddress: controllerState.validator,
            controllerId: controllerState.controllerId,
            electorAddress,
        };
    }

    const poolAddress = await resolvePoolAddress(provider);
    const rawId =
        getArgValue('--controller-id')
        ?? getNetworkEnv(provider, 'CONTROLLER_ID')
        ?? (await provider.ui().input('Controller id (e.g. 0):')).trim();
    const controllerId = parseUint(rawId, 'Controller id');
    const pool = provider.open(Pool.createFromAddress(poolAddress));
    const controllerAddress = await pool.getControllerAddress(controllerId, senderAddress);

    return {
        poolAddress,
        controllerAddress,
        validatorAddress: senderAddress,
        controllerId,
        electorAddress,
    };
}

async function dumpState(provider: NetworkProvider, context: CycleContext | null) {
    if (!context) {
        return;
    }
    try {
        provider.ui().write('📦 Pool getter dump:');
        printPoolSnapshot(provider, await getPoolState(provider, context.poolAddress));
    } catch {
        provider.ui().write('⚠️ Failed to dump pool state');
    }

    try {
        const controllerState = await tryGetControllerState(provider, context.controllerAddress);
        if (controllerState) {
            provider.ui().write('🧭 Controller getter dump:');
            printControllerSnapshot(provider, controllerState);
        }
    } catch {
        provider.ui().write('⚠️ Failed to dump controller state');
    }
}

export async function run(provider: NetworkProvider) {
    const sender = await readSenderOrFail(provider);
    const fromStep = parseUint(getArgValue('--from-step') ?? '1', 'from-step');
    assertOrThrow(fromStep >= 1 && fromStep <= 8, '--from-step must be between 1 and 8');

    let currentStep = fromStep;
    let context: CycleContext | null = null;

    try {
        context = await resolveCycleContext(provider, sender.address!, fromStep);
        const initialController = await tryGetControllerState(provider, context.controllerAddress);
        const metrics: CycleMetrics = {
            feesPaid: 0n,
            initialFreeBalance: initialController ? controllerFreeBalance(initialController) : 0n,
            recoverableBeforeRecover: null,
            debtBeforeRecover: null,
        };

        provider.ui().write(`🧭 Validator flow starting from step ${fromStep}`);
        provider.ui().write(`🏊 Pool:       ${context.poolAddress.toString()}`);
        provider.ui().write(`🧱 Controller: ${context.controllerAddress.toString()}`);
        provider.ui().write(`👤 Validator:  ${context.validatorAddress.toString()}`);

        if (fromStep <= 2) {
            const poolState = await getPoolState(provider, context.poolAddress);
            assertOrThrow(
                sender.address!.equals(context.validatorAddress),
                'Full cycle Step 1/2 requires the current sender to be the validator wallet for this controller',
            );
            assertOrThrow(
                sender.address!.equals(poolState.approver),
                'Full cycle Step 2 requires sender == pool.approver. If roles are split, run controllerApprove separately and resume with --from-step 3 from the validator wallet.',
            );
        }

        if (fromStep <= 1) {
            currentStep = 1;
            const pool = provider.open(Pool.createFromAddress(context.poolAddress));
            assertOrThrow(context.controllerId !== null, 'Controller id is required for deployment');

            if (await isActive(provider, context.controllerAddress)) {
                provider.ui().write('✅ Step 1 complete — controller already deployed');
            } else {
                const defaultDeployValue =
                    Conf.minStoragePool + Conf.hashUpdateFine + 3n * Conf.stakeRecoverFine + toNano('1');
                const deployValue = toNano(
                    (getArgValue('--deploy-value')
                    ?? getNetworkEnv(provider, 'CONTROLLER_DEPLOY_VALUE')
                    ?? (await provider.ui().input(`TON to attach for deploy_controller (default ${formatTon(defaultDeployValue)}):`)).trim()) || formatTon(defaultDeployValue),
                );

                provider.ui().write(`🧪 Step 1 precheck — controller id ${context.controllerId}`);
                const ltBefore = (await provider.provider(context.poolAddress).getState()).last?.lt ?? 0n;
                await pool.sendRequestControllerDeploy(sender, deployValue, context.controllerId);
                await waitForTransaction(provider, context.poolAddress, ltBefore);
                await provider.waitForDeploy(context.controllerAddress);
                metrics.feesPaid += deployValue;

                const deployed = await getControllerState(provider, context.controllerAddress);
                provider.ui().write(`✅ Step 1 complete — controller deployed, state=${deployed.stateName}`);
            }
        }

        if (fromStep <= 2) {
            currentStep = 2;
            const before = await getControllerState(provider, context.controllerAddress);
            if (before.approved) {
                provider.ui().write('✅ Step 2 complete — controller already approved');
            } else {
                const profitShare = parseUint(
                    (getArgValue('--profit-share')
                    ?? getNetworkEnv(provider, 'CONTROLLER_PROFIT_SHARE')
                    ?? (await provider.ui().input('Profit share (0-16777215, default 0):')).trim()) || '0',
                    'Profit share',
                );
                const allocation = toNano(
                    (getArgValue('--allocation')
                    ?? getNetworkEnv(provider, 'CONTROLLER_ALLOCATION')
                    ?? (await provider.ui().input('Allocation in TON (default 0 = unlimited):')).trim()) || '0',
                );
                const startPrior = parseUint(
                    (getArgValue('--start-prior')
                    ?? getNetworkEnv(provider, 'CONTROLLER_START_PRIOR')
                    ?? (await provider.ui().input('allowed_borrow_start_prior_elections_end (default 65536):')).trim()) || '65536',
                    'allowed_borrow_start_prior_elections_end',
                );
                const approveValue = toNano(
                    (getArgValue('--approve-value')
                    ?? getNetworkEnv(provider, 'CONTROLLER_APPROVE_VALUE')
                    ?? (await provider.ui().input('TON to attach for approve (default 0.2):')).trim()) || '0.2',
                );

                const controller = provider.open(Controller.createFromAddress(context.controllerAddress));
                const ltBefore = (await provider.provider(context.controllerAddress).getState()).last?.lt ?? 0n;
                await controller.sendApproveExtended(sender, {
                    startPriorElectionsEnd: startPrior,
                    allocation,
                    profitShare,
                }, approveValue);
                await waitForTransaction(provider, context.controllerAddress, ltBefore);
                metrics.feesPaid += approveValue;

                const after = await getControllerState(provider, context.controllerAddress);
                assertOrThrow(after.approved, 'Controller approval transaction completed but approved is still false');
                provider.ui().write(`✅ Step 2 complete — controller approved, profit_share=${after.approverSetProfitShare}`);
            }
        }

        if (fromStep <= 3) {
            currentStep = 3;
            const before = await getControllerState(provider, context.controllerAddress);
            assertOrThrow(
                sender.address!.equals(before.validator),
                'Step 3 requires sender == controller.validator',
            );
            assertOrThrow(before.approved, 'Controller must be approved before requesting a loan');
            assertOrThrow(before.state === ControllerState.REST, `Controller must be REST before request_loan, got ${before.stateName}`);

            if (before.borrowedAmount > 0n) {
                provider.ui().write('✅ Step 3 complete — controller already has credited loan balance');
            } else {
                const poolState = await getPoolState(provider, context.poolAddress);
                const minLoan = toNano(
                    (getArgValue('--min-loan')
                    ?? getNetworkEnv(provider, 'CONTROLLER_MIN_LOAN')
                    ?? (await provider.ui().input(`Min loan TON (default ${formatTon(poolState.minLoan)}):`)).trim()) || formatTon(poolState.minLoan),
                );
                const maxLoan = toNano(
                    (getArgValue('--max-loan')
                    ?? getNetworkEnv(provider, 'CONTROLLER_MAX_LOAN')
                    ?? (await provider.ui().input(`Max loan TON (default ${formatTon(poolState.maxLoan)}):`)).trim()) || formatTon(poolState.maxLoan),
                );
                const maxInterest = parseUint(
                    (getArgValue('--max-interest')
                    ?? getNetworkEnv(provider, 'CONTROLLER_MAX_INTEREST')
                    ?? (await provider.ui().input(`Max interest (24-bit, default ${poolState.interestRate}):`)).trim()) || String(poolState.interestRate),
                    'Max interest',
                );
                const acceptableProfitShare = parseUint(
                    (getArgValue('--acceptable-profit-share')
                    ?? getNetworkEnv(provider, 'CONTROLLER_ACCEPTABLE_PROFIT_SHARE')
                    ?? (await provider.ui().input(`Acceptable profit share (default ${before.approverSetProfitShare}):`)).trim()) || String(before.approverSetProfitShare),
                    'Acceptable profit share',
                );
                const requestValue = toNano(
                    (getArgValue('--request-value')
                    ?? getNetworkEnv(provider, 'CONTROLLER_REQUEST_VALUE')
                    ?? (await provider.ui().input('TON to attach for request_loan (default 1):')).trim()) || '1',
                );

                const controller = provider.open(Controller.createFromAddress(context.controllerAddress));
                const requiredBalance = await controller.getBalanceForLoan(maxLoan, maxInterest);
                assertOrThrow(
                    before.contractBalance >= requiredBalance,
                    `Controller balance ${formatTon(before.contractBalance)} TON is below required_balance_for_loan ${formatTon(requiredBalance)} TON`,
                );

                const ltBefore = (await provider.provider(context.controllerAddress).getState()).last?.lt ?? 0n;
                await controller.sendRequestLoan(
                    sender,
                    minLoan,
                    maxLoan,
                    maxInterest,
                    acceptableProfitShare,
                    requestValue,
                );
                await waitForTransaction(provider, context.controllerAddress, ltBefore);
                metrics.feesPaid += requestValue;

                const after = await waitUntilSettled(
                    provider,
                    context.controllerAddress,
                    [ControllerState.SENT_BORROWING_REQUEST],
                );
                assertOrThrow(after.borrowedAmount > 0n, 'Loan request settled but controller borrowedAmount is still zero');
                provider.ui().write(`✅ Step 3 complete — loan credited, borrowedAmount=${formatTon(after.borrowedAmount)} TON`);
            }
        }

        if (fromStep <= 4) {
            currentStep = 4;
            let before = await getControllerState(provider, context.controllerAddress);
            assertOrThrow(
                sender.address!.equals(before.validator),
                'Step 4 requires sender == controller.validator',
            );

            if (before.state === ControllerState.FUNDS_STAKEN || before.state === ControllerState.SENT_STAKE_REQUEST) {
                provider.ui().write(`✅ Step 4 complete — stake already requested, state=${before.stateName}`);
            } else {
                assertOrThrow(
                    before.state === ControllerState.REST || before.state === ControllerState.SENT_BORROWING_REQUEST,
                    `Controller must be REST or SENT_BORROWING_REQUEST before staking, got ${before.stateName}`,
                );
                warnIfKnownBug(
                    provider,
                    before.maxStakeValue === -1n,
                    '⚠️  KNOWN BUG: get_max_stake_value returned -1, this may be a getter inversion bug. Proceeding anyway — verify borrowing_time and utime_since manually before continuing.',
                );

                if (before.state === ControllerState.SENT_BORROWING_REQUEST) {
                    before = await waitUntilSettled(
                        provider,
                        context.controllerAddress,
                        [ControllerState.SENT_BORROWING_REQUEST],
                    );
                }

                assertOrThrow(before.state === ControllerState.REST, `Controller must be REST before new_stake, got ${before.stateName}`);
                assertOrThrow(before.borrowedAmount > 0n, 'Controller has no borrowed amount to stake');

                const elector = provider.open(Elector.createFromAddress(context.electorAddress));
                const activeElectionId = await elector.getActiveElectionId();
                assertOrThrow(activeElectionId > 0, 'Elector reports no active election id');

                const publicKey = toBuffer32FromHex(
                    getArgValue('--public-key')
                    ?? getNetworkEnv(provider, 'VALIDATOR_PUBLIC_KEY_HEX')
                    ?? (await provider.ui().input('Validator public key hex:')).trim(),
                    'validator public key',
                );
                const secretKey = bufferFromHex(
                    getArgValue('--secret-key')
                    ?? getNetworkEnv(provider, 'VALIDATOR_SECRET_KEY_HEX')
                    ?? (await provider.ui().input('Validator secret key hex:')).trim(),
                    'validator secret key',
                );
                const adnlHex = getArgValue('--adnl') ?? getNetworkEnv(provider, 'VALIDATOR_ADNL_HEX') ?? '';
                const adnlAddress = adnlHex ? BigInt(`0x${toBuffer32FromHex(adnlHex, 'validator ADNL').toString('hex')}`) : 0n;
                const maxFactor = parseUint(
                    (getArgValue('--max-factor')
                    ?? getNetworkEnv(provider, 'VALIDATOR_MAX_FACTOR')
                    ?? (await provider.ui().input('Max factor (default 65536):')).trim()) || '65536',
                    'Max factor',
                );
                const defaultStakeAmount =
                    before.maxStakeValue !== null && before.maxStakeValue > 0n ? formatTon(before.maxStakeValue) : undefined;
                const stakeAmount = toNano(
                    ((getArgValue('--stake-amount')
                    ?? (await provider.ui().input(defaultStakeAmount ? `Stake amount in TON (default ${defaultStakeAmount}):` : 'Stake amount in TON:')).trim()) || defaultStakeAmount || ''),
                );
                if (before.maxStakeValue !== null && before.maxStakeValue > 0n) {
                    assertOrThrow(stakeAmount <= before.maxStakeValue, 'Stake amount exceeds get_max_stake_value');
                }
                const stakeValue = toNano(
                    (getArgValue('--stake-value')
                    ?? getNetworkEnv(provider, 'CONTROLLER_STAKE_VALUE')
                    ?? (await provider.ui().input(`TON to attach for new_stake (default ${formatTon(Conf.electorOpValue)}):`)).trim()) || formatTon(Conf.electorOpValue),
                );

                const controller = provider.open(Controller.createFromAddress(context.controllerAddress));
                const ltBefore = (await provider.provider(context.controllerAddress).getState()).last?.lt ?? 0n;
                await controller.sendNewStake(
                    sender,
                    stakeAmount,
                    publicKey,
                    secretKey,
                    activeElectionId,
                    maxFactor,
                    adnlAddress,
                    1,
                    stakeValue,
                );
                await waitForTransaction(provider, context.controllerAddress, ltBefore);
                metrics.feesPaid += stakeValue;

                const after = await getControllerState(provider, context.controllerAddress);
                provider.ui().write(`✅ Step 4 complete — stake request sent, state=${after.stateName}`);
            }
        }

        if (fromStep <= 5) {
            currentStep = 5;
            const before = await getControllerState(provider, context.controllerAddress);
            if (before.state === ControllerState.FUNDS_STAKEN) {
                provider.ui().write('✅ Step 5 complete — elector already confirmed stake, state=FUNDS_STAKEN');
            } else {
                assertOrThrow(
                    before.state === ControllerState.SENT_STAKE_REQUEST,
                    `Step 5 expects SENT_STAKE_REQUEST before waiting, got ${before.stateName}`,
                );
                const timeoutSec = parseUint(
                    (getArgValue('--elector-timeout-seconds')
                    ?? getNetworkEnv(provider, 'ELECTOR_TIMEOUT_SECONDS')
                    ?? (await provider.ui().input('Seconds to wait for elector response (default 180):')).trim()) || '180',
                    'elector-timeout-seconds',
                );
                const after = await waitForState(
                    provider,
                    context.controllerAddress,
                    ControllerState.FUNDS_STAKEN,
                    timeoutSec,
                    'Waiting for elector stake confirmation',
                );
                provider.ui().write(`✅ Step 5 complete — elector confirmed stake, state=${after.stateName}`);
            }
        }

        if (fromStep <= 6) {
            currentStep = 6;
            const before = await getControllerState(provider, context.controllerAddress);
            assertOrThrow(
                sender.address!.equals(before.validator),
                'Step 6 requires sender == controller.validator',
            );

            if (before.state === ControllerState.REST && before.borrowedAmount === 0n) {
                provider.ui().write('✅ Step 6 complete — stake already recovered and loan already closed');
            } else {
                assertOrThrow(
                    before.state === ControllerState.FUNDS_STAKEN || before.state === ControllerState.SENT_RECOVER_REQUEST,
                    `Controller must be FUNDS_STAKEN or WAITING_FOR_ELECTOR_RESPONSE, got ${before.stateName}`,
                );

                warnIfKnownBug(
                    provider,
                    before.borrowedAmount === 0n && before.approverSetProfitShare > 0,
                    '⚠️  KNOWN BUG: borrowed_amount is 0 but profit_share > 0. Pool will incorrectly take a share of pure validator profit on repayment.',
                );

                const elector = provider.open(Elector.createFromAddress(context.electorAddress));
                const recoverableBefore = await elector.getReturnedStake(context.controllerAddress).catch(() => 0n);
                metrics.recoverableBeforeRecover = recoverableBefore;
                metrics.debtBeforeRecover = before.borrowedAmount;

                if (before.state === ControllerState.FUNDS_STAKEN) {
                    assertOrThrow(
                        recoverableBefore > 0n,
                        'Elector reports zero returned stake for this controller. Wait until the stake unlocks, then resume with --from-step 6.',
                    );
                    const recoverValue = toNano(
                        (getArgValue('--recover-value')
                        ?? getNetworkEnv(provider, 'CONTROLLER_RECOVER_VALUE')
                        ?? (await provider.ui().input(`TON to attach for recover_stake (default ${formatTon(Conf.electorOpValue)}):`)).trim()) || formatTon(Conf.electorOpValue),
                    );

                    const controller = provider.open(Controller.createFromAddress(context.controllerAddress));
                    const ltBefore = (await provider.provider(context.controllerAddress).getState()).last?.lt ?? 0n;
                    await controller.sendRecoverStake(sender, recoverValue);
                    await waitForTransaction(provider, context.controllerAddress, ltBefore);
                    metrics.feesPaid += recoverValue;
                }

                const after = await waitUntilSettled(
                    provider,
                    context.controllerAddress,
                    [ControllerState.SENT_RECOVER_REQUEST],
                );
                provider.ui().write(`✅ Step 6 complete — recover processed, state=${after.stateName}, remaining debt=${formatTon(after.borrowedAmount)} TON`);
            }
        }

        if (fromStep <= 7) {
            currentStep = 7;
            const before = await getControllerState(provider, context.controllerAddress);
            assertOrThrow(
                sender.address!.equals(before.validator),
                'Step 7 requires sender == controller.validator',
            );

            if (before.borrowedAmount === 0n) {
                provider.ui().write('✅ Step 7 complete — loan already closed, nothing to repay');
            } else {
                assertOrThrow(before.state === ControllerState.REST, `Controller must be REST before return_unused_loan, got ${before.stateName}`);

                assertOrThrow(before.controllerId !== null, 'Unable to derive controller id for loan lookup');
                const pool = provider.open(Pool.createFromAddress(before.pool));
                const currentLoan = await pool.getLoan(before.controllerId, before.validator, false);
                const previousLoan = await pool.getLoan(before.controllerId, before.validator, true);
                const activeLoan = currentLoan.borrowed > 0n || currentLoan.interestAmount > 0n ? currentLoan : previousLoan;
                const totalOwed = activeLoan.borrowed + activeLoan.interestAmount;

                provider.ui().write(`💸 Borrowed principal: ${formatTon(activeLoan.borrowed)} TON`);
                provider.ui().write(`📈 Interest amount:    ${formatTon(activeLoan.interestAmount)} TON`);
                provider.ui().write(`🧾 Total owed:         ${formatTon(totalOwed)} TON`);

                const confirmed = await confirmPrompt(provider, 'Proceed with return_unused_loan?');
                if (!confirmed) {
                    throw new Error('User cancelled Step 7');
                }

                const repayValue = toNano(
                    (getArgValue('--repay-value')
                    ?? getNetworkEnv(provider, 'CONTROLLER_REPAY_VALUE')
                    ?? (await provider.ui().input('TON to attach for return_unused_loan (default 0.5):')).trim()) || '0.5',
                );

                const controller = provider.open(Controller.createFromAddress(context.controllerAddress));
                const ltBefore = (await provider.provider(context.controllerAddress).getState()).last?.lt ?? 0n;
                const poolBefore = await getPoolState(provider, before.pool);
                await controller.sendReturnUnusedLoan(sender, repayValue);
                await waitForTransaction(provider, context.controllerAddress, ltBefore);
                metrics.feesPaid += repayValue;

                const after = await getControllerState(provider, context.controllerAddress);
                const poolAfter = await getPoolState(provider, before.pool);
                assertOrThrow(after.borrowedAmount === 0n, 'Loan repayment transaction confirmed but controller borrowedAmount is still non-zero');
                provider.ui().write(`✅ Step 7 complete — loan repaid, pool totalBalance ${formatTon(poolBefore.totalBalance)} -> ${formatTon(poolAfter.totalBalance)} TON`);
            }
        }

        currentStep = 8;
        const finalController = await getControllerState(provider, context.controllerAddress);
        const finalPool = await getPoolState(provider, context.poolAddress);
        const finalFreeBalance = controllerFreeBalance(finalController);
        const netValidatorReturn = finalFreeBalance - metrics.initialFreeBalance;
        const estimatedProfit = metrics.recoverableBeforeRecover !== null && metrics.debtBeforeRecover !== null
            ? maxBigInt(metrics.recoverableBeforeRecover - metrics.debtBeforeRecover, 0n)
            : maxBigInt(netValidatorReturn + metrics.feesPaid, 0n);

        provider.ui().write('✅ Step 8 complete — final summary');
        provider.ui().write(`💰 Estimated profit earned: ${formatTon(estimatedProfit)} TON`);
        provider.ui().write(`🧾 Fees paid this run:      ${formatTon(metrics.feesPaid)} TON`);
        provider.ui().write(`👤 Net validator return:    ${formatTon(netValidatorReturn)} TON`);
        provider.ui().write(`📌 Final controller state:  ${finalController.stateName}`);
        provider.ui().write(`🏊 Final pool totalBalance: ${formatTon(finalPool.totalBalance)} TON`);
        if (fromStep > 1) {
            provider.ui().write('ℹ️ Fees/profit figures are computed from the steps executed in this invocation plus current controller balances.');
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        provider.ui().write(`❌ Step ${currentStep} failed — exit code 1: ${message}`);
        await dumpState(provider, context);
        process.exit(1);
    }
}
