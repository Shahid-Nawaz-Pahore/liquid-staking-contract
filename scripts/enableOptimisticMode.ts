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
    const poolAddressInput = await provider.ui().input('Please enter pool address:');
    const poolAddress = Address.parse(poolAddressInput);
    const pool = provider.open(Pool.createFromAddress(poolAddress));
    const beforeOptimistic = await readOptimisticMode(provider, poolAddress);
    const enableOptimistic = (await provider.ui().input('Enable optimistic mode? (y/N):')).trim().toLowerCase() === 'y';
    const keepDepositsOpen = (await provider.ui().input('Keep deposits open? (Y/n):')).trim().toLowerCase() !== 'n';
    const instantWithdrawalFeeInput = (await provider.ui().input('Instant withdrawal fee (0-16777215, default 0):')).trim();
    const instantWithdrawalFee = instantWithdrawalFeeInput ? Number(instantWithdrawalFeeInput) : 0;

    if (!Number.isInteger(instantWithdrawalFee) || instantWithdrawalFee < 0 || instantWithdrawalFee > 0xffffff) {
        throw new Error('Invalid instant withdrawal fee. Must be an integer between 0 and 16777215.');
    }

    console.log(`Updating pool ${poolAddress.toString()} deposit mode...`);
    console.log(`Current optimistic mode: ${beforeOptimistic ? 'ON' : 'OFF'}`);
    console.log(`Target optimistic mode: ${enableOptimistic ? 'ON' : 'OFF'}`);
    console.log(`Deposits open: ${keepDepositsOpen ? 'YES' : 'NO'}`);

    await pool.sendSetDepositSettings(
        provider.sender(),
        toNano('1'),
        enableOptimistic,
        keepDepositsOpen,
        instantWithdrawalFee
    );

    console.log('Transaction sent.');

    for (let i = 0; i < 20; i++) {
        await sleep(1500);
        const optimistic = await readOptimisticMode(provider, poolAddress);
        if (optimistic === enableOptimistic) {
            console.log(`Confirmed on-chain: optimistic mode is ${optimistic ? 'ON' : 'OFF'}.`);
            if (optimistic) {
                console.log('New deposits should mint jettons directly.');
            } else {
                console.log('New deposits should mint payout NFTs (pessimistic mode).');
            }
            return;
        }
    }

    console.log('Mode change not confirmed yet. Wait and check again.');
}
