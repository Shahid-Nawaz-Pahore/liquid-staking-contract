import { Address, toNano } from 'ton-core';
import { Pool } from '../wrappers/Pool';
import { NetworkProvider } from '@ton-community/blueprint';

export async function run(provider: NetworkProvider) {
    const ui = provider.ui();
    const sender = provider.sender();

    ui.write('🔓 Pool Proxy Admin - Unfreeze Wallet\n');
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

    const walletOwnerStr = await ui.input('Enter wallet owner address to unfreeze:');
    const walletOwner = Address.parse(walletOwnerStr);

    ui.write('\n📋 Unfreeze Details:\n');
    ui.write(`   Wallet Owner:    ${walletOwner}\n`);
    ui.write(`   Action:          Unfreeze wallet (allow transfers)\n\n`);

    const confirm = await ui.input('Confirm unfreeze? (yes/no):');
    if (confirm.toLowerCase() !== 'yes') {
        ui.write('❌ Unfreeze cancelled\n');
        return;
    }

    ui.write('\n🚀 Sending unfreeze wallet transaction...\n');

    try {
        await pool.sendUnfreezeWallet(
            sender,
            walletOwner
        );

        ui.write('✅ Transaction sent!\n\n');
        ui.write('⏳ Waiting for confirmation...\n');
        await new Promise(resolve => setTimeout(resolve, 5000));

        ui.write('\n✅ SUCCESS! Wallet unfrozen\n');
        ui.write(`   ${walletOwner} can now transfer jettons\n`);

    } catch (error) {
        ui.write('❌ ERROR: Transaction failed\n');
        ui.write(`   ${error}\n`);
    }

    ui.write('\n🎉 Unfreeze operation complete\n');
}

