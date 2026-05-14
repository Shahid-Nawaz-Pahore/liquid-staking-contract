import { NetworkProvider } from '@ton/blueprint';
import { toNano } from '@ton/core';
import { Pool } from '../wrappers/Pool';
import {
    formatTon,
    getPoolState,
    printPoolSnapshot,
    resolvePoolAddress,
} from './scriptHelpers';

// How much TON to credit to `total_balance`.
// IMPORTANT: wrappers/Pool.ts:sendDonate sends `DONATION + 1 TON` (the +1 is DEPOSIT_FEE).
// The DEPOSIT_FEE portion is refunded as excesses via CARRY_ALL_BALANCE,
// so the net cost is ~DONATION + a few cents of chain fees.
// BUT your wallet must temporarily front (DONATION + 1 TON).
//
// Pool currently has total_balance=0.25 TON. To unblock optimistic deposits,
// total_balance must exceed FINALIZE_ROUND_FEE = 1 TON, i.e. DONATION > 0.75 TON.
//
// With a 1.89 TON wallet, the maximum safe DONATION is ~0.8 TON
// (wallet sends 1.8 TON, leaving ~0.09 TON for wallet storage during the tx;
// excesses refund ~0.99 TON shortly after).
const DONATION = toNano('1');

export async function run(provider: NetworkProvider) {
    const ui = provider.ui();
    const sender = provider.sender();
    const senderAddress = sender.address;
    if (!senderAddress) {
        throw new Error('Sender wallet not connected.');
    }

    const poolAddress = await resolvePoolAddress(provider);
    const before = await getPoolState(provider, poolAddress);

    const msgValue = DONATION + toNano('0.1'); // matches wrappers/Pool.ts sendDonate
    ui.write(`Pool:       ${poolAddress.toString()}`);
    ui.write(`Sender:     ${senderAddress.toString()}`);
    ui.write(`Donation:   ${formatTon(DONATION)} TON  (credited to total_balance)`);
    ui.write(`msg_value:  ${formatTon(msgValue)} TON  (wallet must have at least this much)`);
    ui.write(`Net cost:   ~${formatTon(DONATION)} TON + tx fees`);
    ui.write('');
    ui.write('--- Pool BEFORE ---');
    printPoolSnapshot(provider, before);

    if (before.halted) {
        throw new Error('Pool is halted; donate handler runs after assert_not_halted!() and will revert.');
    }

    const answer = (await ui.input('Type "yes" to send, anything else to abort:')).trim().toLowerCase();
    if (answer !== 'yes') {
        ui.write('Aborted.');
        return;
    }

    const pool = provider.open(Pool.createFromAddress(poolAddress));
    await pool.sendDonate(sender, DONATION);

    ui.write('');
    ui.write('Transaction sent. Wait ~30s, then re-run poolGetState to confirm.');
    ui.write('Expected after success:');
    ui.write(`  - total_balance ~= ${formatTon(before.totalBalance + DONATION)} TON`);
    ui.write('  - supply unchanged (no KTON minted to you)');
    ui.write('  - projected rate becomes non-zero, so deposits stop failing with exit 4');
}
