/*
 * TESTNET CHECKLIST
 * Before running: POOL_ADDRESS set or passed
 * After running:  compare with get_pool_full_data{,_raw}; historical rounds beyond current/previous require external indexing
 * Known issues:   on-chain getters expose only current + previous round, so this script summarizes those two rounds only
 */

import { NetworkProvider } from '@ton/blueprint';
import { formatTon, getPoolState, ratioTonPerKton, resolvePoolAddress } from './scriptHelpers';

export async function run(provider: NetworkProvider) {
    const poolAddress = await resolvePoolAddress(provider);
    const pool = await getPoolState(provider, poolAddress);
    const currentRate = ratioTonPerKton(pool.totalBalance, pool.poolJettonSupply);
    const projectedRate = ratioTonPerKton(pool.projectedTotalBalance, pool.projectedPoolSupply);

    provider.ui().write(`📘 Pool round summary for ${poolAddress.toString()}`);
    for (const round of [pool.previousRound, pool.currentRound]) {
        const badDebt = round.returned < round.borrowed;
        provider.ui().write(`🔁 roundId=${round.roundId}`);
        provider.ui().write(`   totalStaked(pool-lent): ${formatTon(round.borrowed)} TON`);
        provider.ui().write(`   totalBorrowed:          ${formatTon(round.borrowed)} TON`);
        provider.ui().write(`   totalRepaid:            ${formatTon(round.returned)} TON`);
        provider.ui().write(`   interestEarned:         ${formatTon(round.expected - round.borrowed)} TON`);
        provider.ui().write(`   profitDistributed:      ${formatTon(round.profit)} TON`);
        if (badDebt) {
            provider.ui().write(`   ⚠️ bad debt detected: repaid ${formatTon(round.returned)} < borrowed ${formatTon(round.borrowed)}`);
        }
    }

    provider.ui().write(`💱 Current rate:  1 KTON ~= ${currentRate} TON`);
    provider.ui().write(`💱 Projected rate:1 KTON ~= ${projectedRate} TON`);
}
