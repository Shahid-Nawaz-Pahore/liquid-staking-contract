import { Address, fromNano } from 'ton-core';
import { Pool } from '../wrappers/Pool';
import { NetworkProvider } from '@ton-community/blueprint';

/**
 * Simple script to get ONLY the minimum deposit value from a pool
 * 
 * Usage: npx blueprint run get_min_deposit
 */

export async function run(provider: NetworkProvider) {
    const ui = provider.ui();

    // Get pool address from user
    const poolAddressStr = await ui.input('Enter Pool address:');
    const poolAddress = Address.parse(poolAddressStr);
    
    try {
        // Open pool contract
        const pool = provider.open(Pool.createFromAddress(poolAddress));
        
        // Get minimum deposit amount
        const poolData = await pool.getFullData();
        const minDepositNanotons = poolData.minDepositAmount;
        const minDepositTON = fromNano(minDepositNanotons);
        
        // Display ONLY the minimum deposit value
        ui.write(`\nMinimum Deposit: ${minDepositTON} TON\n`);
        
    } catch (error: any) {
        ui.write(`\n❌ Error: ${error.message}\n`);
    }
}

