import { Address, toNano } from 'ton-core';
import { Pool } from '../wrappers/Pool';
import { NetworkProvider } from '@ton-community/blueprint';

export async function run(provider: NetworkProvider) {
    const ui = provider.ui();
    const sender = provider.sender();

    ui.write('⏱️  Pool Proxy Admin - Set Freeze Period\n');
    ui.write('='.repeat(50) + '\n\n');

    const poolAddressStr = await ui.input('Enter Pool address:');
    const poolAddress = Address.parse(poolAddressStr);
    const pool = provider.open(Pool.createFromAddress(poolAddress));

    ui.write('\n📊 Fetching Pool data...\n');
    const poolData = await pool.getFullData();

    ui.write(`   Pool Address:    ${poolAddress}\n`);
    ui.write(`   Governor:        ${poolData.governor}\n`);
    ui.write(`   Your Address:    ${sender.address}\n\n`);

    if (!sender.address?.equals(poolData.governor)) {
        ui.write('❌ ERROR: You are not the governor!\n');
        return;
    }

    ui.write('✅ Authorization confirmed\n\n');

    ui.write('💡 Freeze Period Options:\n');
    ui.write('   0         = No auto-freeze\n');
    ui.write('   86400     = 1 day\n');
    ui.write('   604800    = 7 days\n');
    ui.write('   1209600   = 14 days (default)\n');
    ui.write('   2592000   = 30 days\n\n');

    const periodStr = await ui.input('Enter freeze period (in seconds, must be >= 0):');
    const period = parseInt(periodStr);

    if (period < 0) {
        ui.write('❌ ERROR: Freeze period must be >= 0\n');
        return;
    }

    const days = Math.floor(period / 86400);
    const hours = Math.floor((period % 86400) / 3600);

    ui.write('\n📋 Freeze Period Details:\n');
    ui.write(`   New Period:      ${period} seconds\n`);
    ui.write(`   Human Readable:  ${days} days, ${hours} hours\n`);
    ui.write(`   Effect:          Wallets auto-freeze after inactivity\n\n`);

    const confirm = await ui.input('Confirm change? (yes/no):');
    if (confirm.toLowerCase() !== 'yes') {
        ui.write('❌ Operation cancelled\n');
        return;
    }

    ui.write('\n🚀 Sending set freeze period transaction...\n');

    try {
        await pool.sendSetFreezePeriod(
            sender,
            period
        );

        ui.write('✅ Transaction sent!\n\n');
        ui.write('⏳ Waiting for confirmation...\n');
        await new Promise(resolve => setTimeout(resolve, 5000));

        ui.write('\n✅ SUCCESS! Freeze period updated\n');
        ui.write(`   New default: ${period} seconds (${days} days, ${hours} hours)\n`);

    } catch (error) {
        ui.write('❌ ERROR: Transaction failed\n');
        ui.write(`   ${error}\n`);
    }

    ui.write('\n🎉 Set freeze period operation complete\n');
}

