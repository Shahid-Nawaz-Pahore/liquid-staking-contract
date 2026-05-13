import { Address, toNano } from 'ton-core';
import { Pool } from '../wrappers/Pool';
import { NetworkProvider } from '@ton-community/blueprint';

export async function run(provider: NetworkProvider) {
    const ui = provider.ui();
    const sender = provider.sender();

    ui.write('💸 Pool Proxy Admin - Transfer Jettons\n');
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

    const fromAddressStr = await ui.input('Enter FROM address:');
    const fromAddress = Address.parse(fromAddressStr);

    const toAddressStr = await ui.input('Enter TO address:');
    const toAddress = Address.parse(toAddressStr);

    const amountStr = await ui.input('Enter amount to transfer (in tokens):');
    const amount = toNano(amountStr);

    const forwardTonStr = await ui.input('Enter forward TON amount (default 0.05):') || '0.05';
    const forwardTon = toNano(forwardTonStr);

    ui.write('\n📋 Transfer Details:\n');
    ui.write(`   From:            ${fromAddress}\n`);
    ui.write(`   To:              ${toAddress}\n`);
    ui.write(`   Amount:          ${amount} (${amountStr} tokens)\n`);
    ui.write(`   Forward TON:     ${forwardTon}\n`);
    ui.write(`   Supply Change:   None (transfer doesn't change supply)\n\n`);

    const confirm = await ui.input('Confirm transfer? (yes/no):');
    if (confirm.toLowerCase() !== 'yes') {
        ui.write('❌ Transfer cancelled\n');
        return;
    }

    ui.write('\n🚀 Sending admin transfer transaction...\n');

    try {
        await pool.sendAdminTransfer(
            sender,
            fromAddress,
            toAddress,
            amount,
            forwardTon
        );

        ui.write('✅ Transaction sent!\n\n');
        ui.write('⏳ Waiting for confirmation...\n');
        await new Promise(resolve => setTimeout(resolve, 5000));

        const newPoolData = await pool.getFullData();

        ui.write(`   Supply Before:   ${poolData.poolJettonSupply}\n`);
        ui.write(`   Supply After:    ${newPoolData.poolJettonSupply}\n\n`);

        if (newPoolData.poolJettonSupply === poolData.poolJettonSupply) {
            ui.write('✅ SUCCESS! Transfer completed\n');
            ui.write('   (Supply unchanged as expected)\n');
        } else {
            ui.write('⚠️  WARNING: Supply changed unexpectedly\n');
        }

    } catch (error) {
        ui.write('❌ ERROR: Transaction failed\n');
        ui.write(`   ${error}\n`);
    }

    ui.write('\n🎉 Transfer operation complete\n');
}

