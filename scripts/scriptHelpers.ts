import { NetworkProvider } from '@ton/blueprint';
import { Address, beginCell, Cell, ContractProvider, Dictionary, fromNano, Sender, toNano, TupleReader } from '@ton/core';
import { BorrowerDiscriptionValue, Pool } from '../wrappers/Pool';
import { Controller } from '../wrappers/Controller';
import { JettonMinter as DAOJettonMinter } from '../contracts/jetton_dao/wrappers/JettonMinter';
import { JettonWallet as PoolJettonWallet } from '../wrappers/JettonWallet';
import { PayoutCollection } from '../wrappers/PayoutNFTCollection';
import { PayoutItem } from '../wrappers/PayoutNFTItem';
import { Conf, ControllerState, PoolState } from '../PoolConstants';

const NANO = 1_000_000_000n;

export type PoolSnapshot = Awaited<ReturnType<Pool['getFullData']>> & {
    contractBalance: bigint;
    availableLiquidity: bigint;
    queuedWithdrawalTonEstimate: bigint;
    pendingWithdrawalQueueLength: number;
    openLoans: {
        address: Address;
        borrowed: bigint;
        accountedInterest: bigint;
    }[];
};

export type ControllerSnapshot = Awaited<ReturnType<Controller['getControllerData']>> & {
    contractBalance: bigint;
    stateName: string;
    requestWindow: { since: number; until: number } | null;
    maxStakeValue: bigint | null;
    controllerId: number | null;
};

export type WithdrawalItem = {
    collection: Address;
    nft: Address;
    index: bigint;
    billAmount: bigint;
    distributionActive: boolean;
};

type BorrowerEntry = {
    borrowed: bigint;
    accounted_interest: bigint;
};

type RoundSnapshot = {
    borrowers: Cell | null;
    roundId: number;
    activeBorrowers: bigint;
    borrowed: bigint;
    expected: bigint;
    returned: bigint;
    profit: bigint;
};

function padHashBuffer(input: Buffer, length = 32): Buffer {
    if (input.length >= length) {
        return input.subarray(input.length - length);
    }
    return Buffer.concat([Buffer.alloc(length - input.length, 0), input]);
}

export function formatTon(value: bigint): string {
    const sign = value < 0n ? '-' : '';
    const abs = value < 0n ? -value : value;
    const whole = abs / NANO;
    const frac = abs % NANO;
    const frac4 = (frac / 100_000n).toString().padStart(4, '0');
    return `${sign}${whole.toString()}.${frac4}`;
}

export function formatAddress(address: Address | null | undefined): string {
    return address ? address.toString() : 'null';
}

export function fail(message: string): never {
    console.error(`❌ ${message}`);
    process.exit(1);
}

export function logStep(provider: NetworkProvider, message: string) {
    provider.ui().write(message);
}

export function warnIfKnownBug(
    provider: NetworkProvider,
    condition: boolean,
    bugDescription: string,
) {
    if (condition) {
        provider.ui().write(bugDescription);
    }
}

export function getArgValue(flag: string): string | undefined {
    const args = getScriptArgs();
    const eqPrefix = `${flag}=`;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === flag) {
            return args[i + 1];
        }
        if (arg.startsWith(eqPrefix)) {
            return arg.slice(eqPrefix.length);
        }
    }
    return undefined;
}

export function getPositionalArg(index: number): string | undefined {
    const args = getScriptArgs().filter((arg) => !arg.startsWith('--'));
    return args[index];
}

function getScriptArgs(): string[] {
    const args = process.argv.slice(2);
    const separator = args.indexOf('--');
    if (separator >= 0) {
        return args.slice(separator + 1);
    }
    if (args[0] === 'run') {
        return args.slice(2);
    }
    return args;
}

export function getNetworkEnv(provider: NetworkProvider, key: string): string | undefined {
    const networkPrefix = provider.network().toUpperCase();
    return process.env[`${networkPrefix}_${key}`] ?? process.env[key];
}

export async function resolveAddressInput(
    provider: NetworkProvider,
    envKey: string,
    prompt: string,
    cliValue?: string,
): Promise<Address> {
    const raw = cliValue ?? getArgValue(`--${envKey.toLowerCase().replace(/_/g, '-')}`) ?? getNetworkEnv(provider, envKey) ?? (await provider.ui().input(prompt)).trim();
    try {
        return Address.parse(raw);
    } catch {
        fail(`Invalid address for ${envKey}: ${raw}`);
    }
}

export async function resolveAddressInputOrSender(
    provider: NetworkProvider,
    envKey: string,
    prompt: string,
): Promise<Address> {
    const sender = provider.sender();
    if (!sender.address) {
        fail('Sender address is not available');
    }
    const fallback = sender.address.toString();
    const raw = (getNetworkEnv(provider, envKey) ?? (await provider.ui().input(`${prompt} (default ${fallback}):`)).trim()) || fallback;
    try {
        return Address.parse(raw);
    } catch {
        fail(`Invalid address for ${envKey}: ${raw}`);
    }
}

export async function resolveTonAmountInput(
    provider: NetworkProvider,
    envKey: string,
    prompt: string,
    fallback?: string,
): Promise<bigint> {
    const value = (getNetworkEnv(provider, envKey) ?? (await provider.ui().input(fallback ? `${prompt} (default ${fallback}):` : prompt)).trim()) || fallback;
    if (!value) {
        fail(`Missing TON amount for ${envKey}`);
    }
    try {
        return toNano(value);
    } catch {
        fail(`Invalid TON amount for ${envKey}: ${value}`);
    }
}

export async function confirmPrompt(provider: NetworkProvider, message: string): Promise<boolean> {
    return provider.ui().prompt(message);
}

export async function waitForTransaction(
    provider: NetworkProvider,
    address: Address,
    lt?: bigint | null,
    timeoutMs = 120_000,
    pollMs = 3_000,
) {
    const cp = provider.provider(address);
    const startLt = lt ?? (await cp.getState()).last?.lt ?? 0n;
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        const state = await cp.getState();
        if ((state.last?.lt ?? 0n) !== startLt) {
            return state;
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    fail(`Timed out waiting for transaction on ${address.toString()}`);
}

export function controllerStateName(state: number): string {
    switch (state) {
        case ControllerState.REST:
            return 'REST';
        case ControllerState.SENT_BORROWING_REQUEST:
            return 'SENT_BORROWING_REQUEST';
        case ControllerState.SENT_STAKE_REQUEST:
            return 'SENT_STAKE_REQUEST';
        case ControllerState.FUNDS_STAKEN:
            return 'FUNDS_STAKEN';
        case ControllerState.SENT_RECOVER_REQUEST:
            return 'SENT_RECOVER_REQUEST';
        case ControllerState.INSOLVENT:
            return 'INSOLVENT';
        default:
            return `UNKNOWN(${state})`;
    }
}

export async function getPoolState(provider: NetworkProvider, poolAddress: Address): Promise<PoolSnapshot> {
    const data = await readPoolFullData(provider, poolAddress);
    const providerState = await provider.provider(poolAddress).getState();
    const queuedWithdrawalTonEstimate =
        data.projectedPoolSupply > 0n
            ? (data.requestedForWithdrawal * data.projectedTotalBalance) / data.projectedPoolSupply
            : 0n;
    const availableLiquidity = maxBigInt(providerState.balance - Conf.minStoragePool - queuedWithdrawalTonEstimate, 0n);
    const borrowers = data.currentRound.borrowers
        ? Dictionary.loadDirect(Dictionary.Keys.BigInt(256), BorrowerDiscriptionValue, data.currentRound.borrowers)
        : Dictionary.empty(Dictionary.Keys.BigInt(256), BorrowerDiscriptionValue);
    const openLoans = [...borrowers].map(([rawKey, rawValue]) => {
        const key = rawKey as bigint;
        const value = rawValue as BorrowerEntry;
        return {
            address: Address.parseRaw(`-1:${key.toString(16).padStart(64, '0')}`),
            borrowed: value.borrowed,
            accountedInterest: value.accounted_interest,
        };
    });

    let pendingWithdrawalQueueLength = 0;
    if (data.withdrawalPayout) {
        try {
            const payout = provider.open(PayoutCollection.createFromAddress(data.withdrawalPayout));
            pendingWithdrawalQueueLength = Number((await payout.getCollectionData()).nextItemIndex);
        } catch {
            pendingWithdrawalQueueLength = 0;
        }
    }

    return {
        ...data,
        contractBalance: providerState.balance,
        availableLiquidity,
        queuedWithdrawalTonEstimate,
        pendingWithdrawalQueueLength,
        openLoans,
    };
}

async function getPoolFullDataStack(provider: NetworkProvider, poolAddress: Address) {
    const contractProvider = provider.provider(poolAddress);
    try {
        const { stack } = await contractProvider.get('get_pool_full_data_raw', []);
        return stack;
    } catch {
        const { stack } = await contractProvider.get('get_pool_full_data', []);
        return stack;
    }
}

function readRawBigInt(value: unknown, label: string): bigint {
    if (typeof value === 'bigint') {
        return value;
    }
    if (typeof value === 'number') {
        return BigInt(value);
    }
    if (typeof value === 'string') {
        return BigInt(value);
    }
    if (value && typeof value === 'object' && 'type' in value) {
        const typed = value as { type?: string; value?: bigint | string | number };
        if (typed.type === 'int' && typed.value !== undefined) {
            return typeof typed.value === 'bigint' ? typed.value : BigInt(typed.value);
        }
    }
    throw new Error(`Unsupported round numeric item for ${label}`);
}

function readRoundBorrowersCell(raw: unknown): Cell | null {
    if (raw === null || raw === undefined) {
        return null;
    }
    if (Array.isArray(raw) && raw.length === 0) {
        return null;
    }
    if (raw && typeof raw === 'object' && 'type' in raw) {
        const typed = raw as { type?: string; cell?: Cell; value?: bigint | string | number };
        if (typed.type === 'null') {
            return null;
        }
        if ((typed.type === 'cell' || typed.type === 'slice' || typed.type === 'builder') && typed.cell) {
            return typed.cell;
        }
        if (typed.type === 'int' && typed.value !== undefined && BigInt(typed.value) === 0n) {
            return null;
        }
    }
    return null;
}

function readRoundSnapshot(round: TupleReader): RoundSnapshot {
    const rawItems = (round as unknown as { items?: unknown[] }).items;
    if (!Array.isArray(rawItems) || rawItems.length < 7) {
        throw new Error('Unexpected round tuple layout');
    }

    return {
        borrowers: readRoundBorrowersCell(rawItems[0]),
        roundId: Number(readRawBigInt(rawItems[1], 'roundId')),
        activeBorrowers: readRawBigInt(rawItems[2], 'activeBorrowers'),
        borrowed: readRawBigInt(rawItems[3], 'borrowed'),
        expected: readRawBigInt(rawItems[4], 'expected'),
        returned: readRawBigInt(rawItems[5], 'returned'),
        profit: readRawBigInt(rawItems[6], 'profit'),
    };
}

async function readPoolFullData(provider: NetworkProvider, poolAddress: Address) {
    const stack = await getPoolFullDataStack(provider, poolAddress);
    const stackItems = stack.remaining;
    if (stackItems < 30) {
        fail(`Unexpected get_pool_full_data stack layout: ${stackItems} items`);
    }

    const hasExtendedFields = stackItems >= 34;
    if (!hasExtendedFields && stackItems !== 30) {
        fail(`Unsupported get_pool_full_data stack layout: ${stackItems} items`);
    }

    const rawState = stack.readNumber();
    const state = rawState as typeof PoolState.NORMAL | typeof PoolState.REPAYMENT_ONLY;
    const halted = stack.readBoolean();
    const totalBalance = stack.readBigNumber();
    const interestRate = stack.readNumber();
    const optimisticDepositWithdrawals = stack.readBoolean();
    const depositsOpen = stack.readBoolean();
    const instantWithdrawalFee = hasExtendedFields ? stack.readNumber() : 0;
    const savedValidatorSetHash = stack.readBigNumber();
    const previousRound = readRoundSnapshot(stack.readTuple());
    const currentRound = readRoundSnapshot(stack.readTuple());
    const minLoan = stack.readBigNumber();
    const maxLoan = stack.readBigNumber();
    const governanceFee = stack.readNumber();
    const accruedGovernanceFee = hasExtendedFields ? stack.readBigNumber() : 0n;
    const disbalanceTolerance = hasExtendedFields ? stack.readNumber() : 30;
    const creditStartPriorElectionsEnd = hasExtendedFields ? stack.readNumber() : 0;
    const poolJettonMinter = stack.readAddress();
    const poolJettonSupply = stack.readBigNumber();
    const depositPayout = stack.readAddressOpt();
    const requestedForDeposit = stack.readBigNumber();
    const withdrawalPayout = stack.readAddressOpt();
    const requestedForWithdrawal = stack.readBigNumber();
    const sudoer = stack.readAddress();
    const sudoerSetAt = stack.readNumber();
    const governor = stack.readAddress();
    const governorUpdateAfter = stack.readNumber();
    const interestManager = stack.readAddress();
    const halter = stack.readAddress();
    const approver = stack.readAddress();
    const controllerCode = stack.readCell();
    const jettonWalletCode = stack.readCell();
    const payoutMinterCode = stack.readCell();
    const projectedTotalBalance = stack.readBigNumber();
    const projectedPoolSupply = stack.readBigNumber();

    return {
        state,
        halted,
        totalBalance,
        interestRate,
        optimisticDepositWithdrawals,
        depositsOpen,
        instantWithdrawalFee,
        savedValidatorSetHash,
        previousRound,
        currentRound,
        minLoan,
        maxLoan,
        governanceFee,
        accruedGovernanceFee,
        disbalanceTolerance,
        creditStartPriorElectionsEnd,
        poolJettonMinter,
        poolJettonSupply,
        supply: poolJettonSupply,
        depositPayout,
        requestedForDeposit,
        withdrawalPayout,
        requestedForWithdrawal,
        sudoer,
        sudoerSetAt,
        governor,
        governorUpdateAfter,
        interestManager,
        halter,
        approver,
        controllerCode,
        jettonWalletCode,
        payoutMinterCode,
        projectedTotalBalance,
        projectedPoolSupply,
    };
}

export async function getControllerMaxStakeValue(provider: NetworkProvider, controllerAddress: Address): Promise<bigint | null> {
    try {
        const { stack } = await provider.provider(controllerAddress).get('get_max_stake_value', []);
        return stack.readBigNumber();
    } catch {
        return null;
    }
}

export async function findControllerId(
    provider: NetworkProvider,
    poolAddress: Address,
    controllerAddress: Address,
    validatorAddress: Address,
    searchLimit = 32,
): Promise<number | null> {
    const pool = provider.open(Pool.createFromAddress(poolAddress));
    for (let id = 0; id < searchLimit; id++) {
        const expected = await pool.getControllerAddress(id, validatorAddress);
        if (expected.equals(controllerAddress)) {
            return id;
        }
    }
    return null;
}

export async function getControllerState(
    provider: NetworkProvider,
    controllerAddress: Address,
): Promise<ControllerSnapshot> {
    const controller = provider.open(Controller.createFromAddress(controllerAddress));
    const data = await controller.getControllerData();
    const requestWindow = await controller.getRequestWindow().catch(() => null);
    const maxStakeValue = await getControllerMaxStakeValue(provider, controllerAddress);
    const controllerId = await findControllerId(provider, data.pool, controllerAddress, data.validator);
    const providerState = await provider.provider(controllerAddress).getState();

    return {
        ...data,
        contractBalance: providerState.balance,
        stateName: controllerStateName(data.state),
        requestWindow,
        maxStakeValue,
        controllerId,
    };
}

export function isLikelyValidStakingWindow(controller: ControllerSnapshot, nowTs: number): boolean {
    return !!controller.requestWindow &&
        nowTs >= controller.requestWindow.since &&
        nowTs <= controller.requestWindow.until &&
        controller.state === ControllerState.REST &&
        controller.borrowedAmount > 0n;
}

export async function getJettonContext(
    provider: NetworkProvider,
    poolAddress: Address,
    ownerAddress: Address,
) {
    const poolState = await getPoolState(provider, poolAddress);
    const minter = provider.open(DAOJettonMinter.createFromAddress(poolState.poolJettonMinter));
    const walletAddress = await minter.getWalletAddress(ownerAddress);
    const wallet = provider.open(PoolJettonWallet.createFromAddress(walletAddress));
    const walletData = await wallet.getDaoData();
    return {
        poolState,
        minter,
        minterAddress: poolState.poolJettonMinter,
        wallet,
        walletAddress,
        walletData,
    };
}

export async function scanOwnedWithdrawalItems(
    provider: NetworkProvider,
    ownerAddress: Address,
    collectionAddresses: Address[],
): Promise<WithdrawalItem[]> {
    const found: WithdrawalItem[] = [];
    for (const collectionAddress of collectionAddresses) {
        try {
            const payout = provider.open(PayoutCollection.createFromAddress(collectionAddress));
            const collectionData = await payout.getCollectionData();
            const distribution = await payout.getDistribution();
            for (let index = 0n; index < collectionData.nextItemIndex; index++) {
                const nftAddress = await payout.getNFTAddress(index);
                const item = provider.open(PayoutItem.createFromAddress(nftAddress));
                const nftData = await item.getNFTData();
                if (nftData.owner.equals(ownerAddress)) {
                    found.push({
                        collection: collectionAddress,
                        nft: nftAddress,
                        index,
                        billAmount: await item.getBillAmount(),
                        distributionActive: distribution.active,
                    });
                }
            }
        } catch {
            continue;
        }
    }
    return found;
}

export function maxBigInt(a: bigint, b: bigint) {
    return a > b ? a : b;
}

export function ratioTonPerKton(totalBalance: bigint, supply: bigint): string {
    if (supply === 0n) {
        return '0.0000';
    }
    const scaled = (totalBalance * 10_000n) / supply;
    const whole = scaled / 10_000n;
    const frac = scaled % 10_000n;
    return `${whole.toString()}.${frac.toString().padStart(4, '0')}`;
}

export function toBuffer32FromHex(hex: string, label: string): Buffer {
    const normalized = hex.trim().replace(/^0x/, '');
    if (!/^[0-9a-fA-F]+$/.test(normalized)) {
        fail(`Invalid hex for ${label}`);
    }
    return padHashBuffer(Buffer.from(normalized, 'hex'));
}

export function bufferFromHex(hex: string, label: string): Buffer {
    const normalized = hex.trim().replace(/^0x/, '');
    if (!/^[0-9a-fA-F]+$/.test(normalized) || normalized.length % 2 !== 0) {
        fail(`Invalid hex for ${label}`);
    }
    return Buffer.from(normalized, 'hex');
}

export function nowSeconds(): number {
    return Math.floor(Date.now() / 1000);
}

export async function readSenderOrFail(provider: NetworkProvider): Promise<Sender> {
    const sender = provider.sender();
    if (!sender.address) {
        fail('Sender address is not available');
    }
    return sender;
}

export async function resolvePoolAddress(provider: NetworkProvider): Promise<Address> {
    return resolveAddressInput(provider, 'POOL_ADDRESS', 'Pool address:', getArgValue('--pool') ?? getPositionalArg(0));
}

export async function resolveControllerAddress(provider: NetworkProvider): Promise<Address> {
    return resolveAddressInput(provider, 'CONTROLLER_ADDRESS', 'Controller address:', getArgValue('--controller') ?? getPositionalArg(0));
}

export async function resolveElectorAddress(provider: NetworkProvider): Promise<Address> {
    return resolveAddressInput(provider, 'ELECTOR_ADDRESS', 'Elector address:', getArgValue('--elector'));
}

export function printPoolSnapshot(provider: NetworkProvider, pool: PoolSnapshot) {
    const ui = provider.ui();
    ui.write(`📦 Pool balance:          ${formatTon(pool.contractBalance)} TON`);
    ui.write(`🏦 Accounted totalBalance:${formatTon(pool.totalBalance)} TON`);
    ui.write(`💧 Available liquidity:   ${formatTon(pool.availableLiquidity)} TON`);
    ui.write(`📉 Total borrowed:        ${formatTon(pool.currentRound.borrowed)} TON`);
    ui.write(`🪙 KTON total supply:     ${formatTon(pool.poolJettonSupply)} KTON`);
    ui.write(`💱 1 KTON ~= ${ratioTonPerKton(pool.projectedTotalBalance, pool.projectedPoolSupply)} TON`);
    ui.write(`📈 Interest rate:         ${pool.interestRate}`);
    ui.write(`🏧 Max per validator:     ${formatTon(pool.maxLoan)} TON`);
    ui.write(`⛔ Halted:               ${pool.halted}`);
    ui.write(`🔁 Current round:         id=${pool.currentRound.roundId} active=${pool.currentRound.activeBorrowers.toString()} borrowed=${formatTon(pool.currentRound.borrowed)} returned=${formatTon(pool.currentRound.returned)} profit=${formatTon(pool.currentRound.profit)}`);
}

export function printControllerSnapshot(provider: NetworkProvider, controller: ControllerSnapshot) {
    const ui = provider.ui();
    const maxStakeLabel =
        controller.maxStakeValue === null
            ? 'unavailable'
            : controller.maxStakeValue === -1n
                ? '-1 (known bug signal)'
                : `${formatTon(controller.maxStakeValue)} TON`;
    ui.write(`🧭 State:                 ${controller.stateName}`);
    ui.write(`✅ Approved:              ${controller.approved}`);
    ui.write(`🏦 Contract balance:      ${formatTon(controller.contractBalance)} TON`);
    ui.write(`💸 Borrowed amount:       ${formatTon(controller.borrowedAmount)} TON`);
    ui.write(`📈 Interest raw share:    ${controller.interest}`);
    ui.write(`🤝 Profit share:          ${controller.approverSetProfitShare}`);
    ui.write(`👤 Validator:             ${controller.validator.toString()}`);
    ui.write(`🏊 Pool:                  ${controller.pool.toString()}`);
    ui.write(`🆔 Controller id:         ${controller.controllerId ?? 'unknown'}`);
    ui.write(`🎯 get_max_stake_value:   ${maxStakeLabel}`);
}

export function buildJettonBurnBody(
    queryId: bigint,
    jettonAmount: bigint,
    responseAddress: Address,
    waitTillRoundEnd: boolean,
    fillOrKill: boolean,
): Cell {
    const customPayload = beginCell()
        .storeBit(waitTillRoundEnd)
        .storeBit(fillOrKill)
        .endCell();
    return beginCell()
        .storeUint(0x595f07bc, 32)
        .storeUint(queryId, 64)
        .storeCoins(jettonAmount)
        .storeAddress(responseAddress)
        .storeMaybeRef(customPayload)
        .endCell();
}

export async function sendJettonBurn(
    provider: ContractProvider,
    via: Sender,
    value: bigint,
    body: Cell,
) {
    await provider.internal(via, {
        value,
        sendMode: 1,
        body,
    });
}
