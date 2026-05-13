import { Address, toNano } from 'ton-core';
import { Pool } from '../wrappers/Pool';
import { NetworkProvider } from '@ton-community/blueprint';

/**
 * Script to set minimum deposit amount for the pool
 * 
 * Usage: npx blueprint run set_min_deposit
 * 
 * This script allows the governor to update the minimum deposit amount
 * required for users to stake in the pool.
 */

export async function run(provider: NetworkProvider) {
    const ui = provider.ui();

    // Get pool address from user
    const poolAddressStr = await ui.input('Enter pool address');
    const poolAddress = Address.parse(poolAddressStr);
    
    const pool = provider.open(Pool.createFromAddress(poolAddress));

    // Display current pool data
    ui.write('Fetching current pool data...\n');
    try {
        const poolData = await pool.getFullData();
        ui.write(`Current minimum deposit: ${poolData.minDepositAmount} nanotons (${Number(poolData.minDepositAmount) / 1e9} TON)\n`);
        ui.write(`Current total balance: ${poolData.totalBalance} nanotons (${Number(poolData.totalBalance) / 1e9} TON)\n`);
        ui.write(`Governor: ${poolData.governor.toString()}\n\n`);
    } catch (error) {
        ui.write('Could not fetch pool data. Continuing...\n\n');
    }

    // Get new minimum deposit amount
    const minDepositTon = await ui.input('Enter new minimum deposit amount (in TON)');
    const minDepositAmount = toNano(minDepositTon);

    ui.write(`\nSetting minimum deposit to: ${minDepositAmount} nanotons (${minDepositTon} TON)\n`);

    // Confirm action
    const confirm = await ui.input('Confirm? (yes/no)');
    if (confirm.toLowerCase() !== 'yes') {
        ui.write('Action cancelled.\n');
        return;
    }

    // Send transaction
    ui.write('Sending transaction...\n');
    
    try {
        await pool.sendSetMinDeposit(
            provider.sender(),
            minDepositAmount
        );

        ui.write('✅ Transaction sent successfully!\n')

        
    } catch (error: any) {
        ui.write(`❌ Error: ${error.message}\n`);
        ui.write('Make sure you are using the governor wallet!\n');
    }
}

