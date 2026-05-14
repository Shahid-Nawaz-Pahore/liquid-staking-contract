import { Address, fromNano, toNano } from '@ton/core';
import { NetworkProvider } from '@ton/blueprint';
import {
    formatTon,
    getJettonContext,
    printPoolSnapshot,
    ratioTonPerKton,
    resolvePoolAddress,
} from './scriptHelpers';

// TON to attach to the burn message. Must cover:
//   - jetton-wallet gas + burn_notification fee (~0.75 TON, see jetton_dao/contracts/jetton-wallet.func:19)
//   - pool::withdraw processing (WITHDRAWAL_FEE = 0.5 TON, see pool.func:87)
// 1 TON is comfortable. Increase if the pool ever rejects with not_enough_TON.
const BURN_TX_VALUE = toNano('1');

export async function run(provider: NetworkProvider) {
    const ui = provider.ui();
    const sender = provider.sender();
    if (!sender.address) {
        throw new Error('Sender wallet not connected.');
    }
    const owner = sender.address;

    const poolAddress = await resolvePoolAddress(provider);
    const ctx = await getJettonContext(provider, poolAddress, owner);
    const { poolState, walletAddress, wallet, walletData } = ctx;

    ui.write(`Pool:           ${poolAddress.toString()}`);
    ui.write(`Owner:          ${owner.toString()}`);
    ui.write(`Your jetton wallet (STAKEED): ${walletAddress.toString()}`);
    ui.write('');
    ui.write('--- Pool state ---');
    printPoolSnapshot(provider, poolState);
    ui.write('');

    // walletData.balance is the immediately-spendable amount.
    // walletData.locked is jettons currently locked by an active vote.
    const available = walletData.balance;
    const locked = walletData.locked;
    ui.write(`Available STAKEED to unstake: ${formatTon(available)}`);
    if (locked > 0n) {
        ui.write(`Locked (in active vote):     ${formatTon(locked)}  (cannot unstake until vote expires)`);
    }

    if (available <= 0n) {
        ui.write('Nothing to unstake.');
        return;
    }

    // Rate quotes
    const currentRate = ratioTonPerKton(poolState.totalBalance, poolState.poolJettonSupply);
    const projectedRate = ratioTonPerKton(poolState.projectedTotalBalance, poolState.projectedPoolSupply);
    ui.write('');
    ui.write(`Current rate    (used by IMMEDIATE path):  1 STAKEED ~= ${currentRate} TON`);
    ui.write(`Projected rate  (used by ROUND-END path):  1 STAKEED ~= ${projectedRate} TON`);
    ui.write('');

    // Amount
    const amountInput = (await ui.input(
        `How much STAKEED to unstake? (default = all ${formatTon(available)}):`,
    )).trim();
    const jettonAmount = amountInput === '' ? available : toNano(amountInput);
    if (jettonAmount <= 0n) throw new Error('Amount must be positive.');
    if (jettonAmount > available) throw new Error(`Amount exceeds available ${formatTon(available)} STAKEED.`);

    // Mode selection
    ui.write('');
    ui.write('Two paths:');
    ui.write('  1) IMMEDIATE  — TON returns to your wallet now, if pool has enough free liquidity.');
    ui.write('                 If not enough liquidity, you can choose to (a) fall back to round-end,');
    ui.write('                 or (b) revert (fill-or-kill).');
    ui.write('  2) ROUND-END  — You receive a Payout NFT; redeem it for TON once the round closes (~18h).');
    ui.write('');
    const modeInput = (await ui.input('Pick path: type "1" or "2" (default 1):')).trim();
    const wantImmediate = modeInput === '' || modeInput === '1';

    let waitTillRoundEnd = !wantImmediate;
    let fillOrKill = false;
    if (wantImmediate) {
        const fallbackInput = (await ui.input(
            'If immediate is unavailable, fall back to round-end? (y/N):',
        )).trim().toLowerCase();
        const fallback = fallbackInput === 'y' || fallbackInput === 'yes';
        fillOrKill = !fallback;
    }

    // Rough TON estimate (informational only)
    const estTonImmediate = poolState.poolJettonSupply > 0n
        ? (jettonAmount * poolState.totalBalance) / poolState.poolJettonSupply
        : 0n;
    const estTonRoundEnd = poolState.projectedPoolSupply > 0n
        ? (jettonAmount * poolState.projectedTotalBalance) / poolState.projectedPoolSupply
        : 0n;

    // Pre-flight checks
    if (poolState.halted) {
        throw new Error('Pool is HALTED. Burn would mint jettons back to you in the catch path — not useful right now.');
    }
    if (!waitTillRoundEnd && !poolState.optimisticDepositWithdrawals) {
        ui.write('');
        ui.write('NOTE: pool has optimistic mode DISABLED. The immediate path will be ignored;');
        ui.write('the pool will route this through round-end regardless of your choice.');
    }
    if (!waitTillRoundEnd && poolState.optimisticDepositWithdrawals && poolState.availableLiquidity < estTonImmediate) {
        ui.write('');
        ui.write(`WARNING: Pool available liquidity is ${formatTon(poolState.availableLiquidity)} TON,`);
        ui.write(`         estimated immediate payout is ${formatTon(estTonImmediate)} TON.`);
        if (fillOrKill) {
            ui.write('         fillOrKill = true → tx will revert. Consider fall-back to round-end instead.');
        } else {
            ui.write('         The pool will fall back to round-end and mint a Payout NFT.');
        }
    }

    ui.write('');
    ui.write('Summary:');
    ui.write(`  Amount:           ${formatTon(jettonAmount)} STAKEED`);
    ui.write(`  Path:             ${waitTillRoundEnd ? 'ROUND-END (NFT)' : 'IMMEDIATE'}`);
    if (wantImmediate) ui.write(`  fillOrKill:       ${fillOrKill}`);
    ui.write(`  Est. TON now:     ~${formatTon(estTonImmediate)} TON   (current rate)`);
    ui.write(`  Est. TON @ round: ~${formatTon(estTonRoundEnd)} TON   (projected rate)`);
    ui.write(`  Gas attached:     ${formatTon(BURN_TX_VALUE)} TON   (most of it is refunded as excesses)`);
    ui.write('');

    const confirm = (await ui.input('Type "yes" to send, anything else to abort:')).trim().toLowerCase();
    if (confirm !== 'yes') {
        ui.write('Aborted.');
        return;
    }

    await wallet.sendBurnWithParams(
        sender,
        BURN_TX_VALUE,
        jettonAmount,
        owner,                // response_address — where excesses + the TON payout return
        waitTillRoundEnd,
        fillOrKill,
    );

    ui.write('');
    ui.write('Burn message sent. Wait ~30s, then check:');
    if (waitTillRoundEnd) {
        ui.write('  - Your STAKEED balance dropped by the unstaked amount.');
        ui.write('  - A Payout NFT was minted to your wallet (Tonviewer → NFTs tab).');
        ui.write('  - At round end (~18h on mainnet), the pool distributes TON to NFT holders.');
        ui.write('  - To claim TON after the round ends, burn the Payout NFT (see scripts/poolWithdrawPending.ts).');
    } else {
        ui.write('  - Your STAKEED balance dropped by the unstaked amount.');
        ui.write('  - TON arrives at your wallet (look for op pool::withdrawal in Tonviewer).');
        ui.write('  - If immediate path failed (no liquidity), either:');
        ui.write(`      a) fillOrKill=true (${fillOrKill}) → tx reverted, your STAKEED was returned by the catch handler.`);
        ui.write('      b) fillOrKill=false → you got a Payout NFT instead (round-end path).');
    }
}
