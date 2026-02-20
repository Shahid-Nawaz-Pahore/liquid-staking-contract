import { Address, toNano } from '@ton/core';
import { Pool } from '../wrappers/Pool';
import { NetworkProvider, sleep } from '@ton/blueprint';

async function readOptimisticMode(provider: NetworkProvider, poolAddress: Address): Promise<boolean> {
    const contractProvider = provider.provider(poolAddress);
    const { stack } = await contractProvider.get('get_pool_full_data', []);
    stack.readNumber(); // state
    stack.readBoolean(); // halted
    stack.readBigNumber(); // total_balance
    stack.readNumber(); // interest_rate
    return stack.readBoolean(); // optimistic_deposit_withdrawals
}

export async function run(provider: NetworkProvider) {
    const poolAddressInput = await provider.ui().input("Please enter pool address:");
    const poolAddress = Address.parse(poolAddressInput);
    const pool = provider.open(Pool.createFromAddress(poolAddress));
    const beforeOptimistic = await readOptimisticMode(provider, poolAddress);

    console.log(`Switching pool ${poolAddress.toString()} to optimistic deposits mode...`);
    console.log(`Current optimistic mode: ${beforeOptimistic ? "ON" : "OFF"}`);

    await pool.sendSetDepositSettings(
        provider.sender(),
        toNano("1"),        // Gas fee (1 TON should be enough)
        true,               // optimistic = TRUE (enable optimistic mode)
        true,               // depositsOpen = TRUE (keep deposits enabled)
        0                   // instantWithdrawalFee = 0 (no instant withdrawal fee)
    );

    console.log("✅ Transaction sent!");

    for (let i = 0; i < 20; i++) {
        await sleep(1500);
        const optimistic = await readOptimisticMode(provider, poolAddress);
        if (optimistic) {
            console.log("✅ Confirmed on-chain: optimistic mode is ON");
            console.log("New deposits will mint jettons (not deposit NFT).");
            return;
        }
    }

    console.log("⚠️ Optimistic mode is not confirmed yet. Wait and check again before depositing.");
}
