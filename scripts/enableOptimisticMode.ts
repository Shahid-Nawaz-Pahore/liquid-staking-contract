import { Address, toNano } from '@ton/core';
import { Pool } from '../wrappers/Pool';
import { NetworkProvider } from '@ton/blueprint';

export async function run(provider: NetworkProvider) {
    const poolAddress = Address.parse("EQDGATLLt9nXRC680Vhe_YaLot1KHtknjS5_fa_QhYrjwkhZ");
    const pool = provider.open(Pool.createFromAddress(poolAddress));

    console.log("Switching pool to optimistic deposits mode...");

    await pool.sendSetDepositSettings(
        provider.sender(),
        toNano("1"),        // Gas fee (1 TON should be enough)
        true,               // optimistic = TRUE (enable optimistic mode)
        true,               // depositsOpen = TRUE (keep deposits enabled)
        0                   // instantWithdrawalFee = 0 (no instant withdrawal fee)
    );

    console.log("✅ Transaction sent!");
    console.log("After confirmation, deposits will immediately mint jettons instead of NFTs");
}
