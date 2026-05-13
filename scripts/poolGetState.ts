

import { NetworkProvider } from '@ton/blueprint';
import {
    formatTon,
    getPoolState,
    printPoolSnapshot,
    ratioTonPerKton,
    resolvePoolAddress,
} from './scriptHelpers';

export async function run(provider: NetworkProvider) {
    const poolAddress = await resolvePoolAddress(provider);
    const pool = await getPoolState(provider, poolAddress);

    provider.ui().write(`🏊 Pool: ${poolAddress.toString()}`);
    printPoolSnapshot(provider, pool);
    provider.ui().write(`📤 Open loans:            ${pool.openLoans.length}`);
    for (const loan of pool.openLoans) {
        provider.ui().write(`  - ${loan.address.toString()} borrowed=${formatTon(loan.borrowed)} interest=${formatTon(loan.accountedInterest)}`);
    }
    provider.ui().write(`🧾 Pending withdrawal queue length: ${pool.pendingWithdrawalQueueLength}`);
    provider.ui().write(`🧾 Total queued TON est.:          ${formatTon(pool.queuedWithdrawalTonEstimate)} TON`);
    provider.ui().write(`📊 Previous round: id=${pool.previousRound.roundId} borrowed=${formatTon(pool.previousRound.borrowed)} returned=${formatTon(pool.previousRound.returned)} profit=${formatTon(pool.previousRound.profit)}`);
    provider.ui().write(`💱 Projected rate: 1 KTON ~= ${ratioTonPerKton(pool.projectedTotalBalance, pool.projectedPoolSupply)} TON`);
}
