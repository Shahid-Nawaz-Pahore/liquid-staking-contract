import { Address, toNano } from 'ton-core';
import { Pool } from '../wrappers/Pool';
import { NetworkProvider } from '@ton-community/blueprint';

export async function run(provider: NetworkProvider) {
    const ui = provider.ui();
    const sender = provider.sender();

    ui.write('🔥 Pool Proxy Admin - Burn Jettons\n');
    ui.write('='.repeat(50) + '\n\n');

    const poolAddressStr = await ui.input('Enter Pool address:');
    const poolAddress = Address.parse(poolAddressStr);
    const pool = provider.open(Pool.createFromAddress(poolAddress));

    ui.write('\n📊 Fetching Pool data...\n');
    const poolData = await pool.getFullData();

    ui.write(`   Pool Address:    ${poolAddress}\n`);
    ui.write(`   Current Supply:  ${poolData.poolJettonSupply}\n`);
    ui.write(`   Governor:        ${poolData.governor}\n`);
    ui.write(`   Your Address:    ${sender.address}\n\n`);

    if (!sender.address?.equals(poolData.governor)) {
        ui.write('❌ ERROR: You are not the governor!\n');
        return;
    }

    ui.write('✅ Authorization confirmed\n\n');

    const fromAddressStr = await ui.input('Enter address to burn from:');
    const fromAddress = Address.parse(fromAddressStr);

    const amountStr = await ui.input('Enter amount to burn (in tokens):');
    const amount = toNano(amountStr);

    const forwardTonStr = await ui.input('Enter forward TON amount (default 0.1):') || '0.1';
    const forwardTon = toNano(forwardTonStr);

    ui.write('\n📋 Burn Details:\n');
    ui.write(`   From Address:    ${fromAddress}\n`);
    ui.write(`   Amount:          ${amount} (${amountStr} tokens)\n`);
    ui.write(`   Forward TON:     ${forwardTon}\n`);
    ui.write(`   New Supply:      ${poolData.poolJettonSupply - amount}\n\n`);

    const confirm = await ui.input('Confirm burn? (yes/no):');
    if (confirm.toLowerCase() !== 'yes') {
        ui.write('❌ Burn cancelled\n');
        return;
    }

    ui.write('\n🚀 Sending admin burn transaction...\n');

    try {
        await pool.sendAdminBurn(
            sender,
            fromAddress,
            amount,
            forwardTon
        );

        ui.write('✅ Transaction sent!\n\n');
        ui.write('⏳ Waiting for confirmation...\n');
        await new Promise(resolve => setTimeout(resolve, 5000));

        const newPoolData = await pool.getFullData();

        ui.write(`   Old Supply:  ${poolData.poolJettonSupply}\n`);
        ui.write(`   New Supply:  ${newPoolData.poolJettonSupply}\n`);
        ui.write(`   Difference:  ${poolData.poolJettonSupply - newPoolData.poolJettonSupply}\n\n`);

        if (newPoolData.poolJettonSupply === poolData.poolJettonSupply - amount) {
            ui.write('✅ SUCCESS! Jettons burned\n');
        } else {
            ui.write('⚠️  Supply changed by unexpected amount\n');
        }

    } catch (error) {
        ui.write('❌ ERROR: Transaction failed\n');
        ui.write(`   ${error}\n`);
    }

    ui.write('\n🎉 Burn operation complete\n');
}

