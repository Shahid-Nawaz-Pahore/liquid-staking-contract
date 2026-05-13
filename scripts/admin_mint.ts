import { Address, toNano } from 'ton-core';
import { Pool } from '../wrappers/Pool';
import { NetworkProvider } from '@ton-community/blueprint';

/**
 * Admin Mint Script
 * 
 * Allows the governor to mint jettons to any address via Pool's proxy admin function.
 * Pool forwards the mint operation to the Jetton Minter.
 * 
 * Usage:
 *   npx blueprint run admin_mint
 */

export async function run(provider: NetworkProvider) {
    const ui = provider.ui();
    const sender = provider.sender();

    ui.write('🪙 Pool Proxy Admin - Mint Jettons\n');
    ui.write('=' .repeat(50) + '\n\n');

    // Step 1: Get Pool address
    const poolAddressStr = await ui.input('Enter Pool address:');
    const poolAddress = Address.parse(poolAddressStr);
    const pool = provider.open(Pool.createFromAddress(poolAddress));

    // Step 2: Get Pool data to verify
    ui.write('\n📊 Fetching Pool data...\n');
    const poolData = await pool.getFullData();

    ui.write(`   Pool Address:    ${poolAddress}\n`);
    ui.write(`   Minter Address:  ${poolData.poolJettonMinter}\n`);
    ui.write(`   Current Supply:  ${poolData.poolJettonSupply}\n`);
    ui.write(`   Governor:        ${poolData.governor}\n`);
    ui.write(`   Your Address:    ${sender.address}\n\n`);

    // Step 3: Check authorization
    if (!sender.address?.equals(poolData.governor)) {
        ui.write('❌ ERROR: You are not the governor!\n');
        ui.write(`   Governor is:  ${poolData.governor}\n`);
        ui.write(`   You are:      ${sender.address}\n`);
        return;
    }

    ui.write('✅ Authorization confirmed: You are the governor\n\n');

    // Step 4: Get mint parameters
    ui.write('📝 Mint Parameters:\n');
    ui.write('─'.repeat(50) + '\n\n');
    
    ui.write('💡 Quick options:\n');
    ui.write(`   • Your wallet: ${sender.address}\n`);
    ui.write(`   • Pool address: ${poolAddress}\n\n`);
    
    let recipient: Address;
    while (true) {
        try {
            const recipientStr = await ui.input('Enter recipient address (or paste from above):');
            recipient = Address.parse(recipientStr);
            ui.write(`✅ Recipient: ${recipient}\n\n`);
            break; // Valid address, exit loop
        } catch (error) {
            ui.write('❌ Invalid address format! Please enter a valid TON address.\n');
            ui.write('   Must be 48 characters starting with EQ, UQ, kQ, or 0Q\n\n');
        }
    }

    const amountStr = await ui.input('Enter amount to mint (in tokens, e.g., 1000):');
    const amount = toNano(amountStr);

    const forwardTonStr = await ui.input('Enter forward TON amount (default 0.05):') || '0.05';
    const forwardTon = toNano(forwardTonStr);

    const totalTonStr = await ui.input('Enter total TON for gas (default 0.15):') || '0.15';
    const totalTon = toNano(totalTonStr);

    // Step 5: Confirm operation
    ui.write('\n📋 Mint Details:\n');
    ui.write(`   Recipient:       ${recipient}\n`);
    ui.write(`   Amount:          ${amount} (${amountStr} tokens)\n`);
    ui.write(`   Forward TON:     ${forwardTon}\n`);
    ui.write(`   Total TON:       ${totalTon}\n`);
    ui.write(`   New Supply:      ${poolData.poolJettonSupply + amount}\n\n`);

    const confirm = await ui.input('Confirm mint? (yes/no):');
    if (confirm.toLowerCase() !== 'yes') {
        ui.write('❌ Mint cancelled\n');
        return;
    }

    // Step 6: Send mint operation
    ui.write('\n🚀 Sending admin mint transaction...\n');

    try {
        await pool.sendAdminMint(
            sender,
            recipient,
            amount,
            forwardTon,
            totalTon
        );

        ui.write('✅ Transaction sent!\n\n');

        // Step 7: Wait and verify
        ui.write('⏳ Waiting for transaction confirmation (5 seconds)...\n');
        await new Promise(resolve => setTimeout(resolve, 5000));

        ui.write('\n📊 Fetching updated Pool data...\n');
        const newPoolData = await pool.getFullData();

        ui.write(`   Old Supply:  ${poolData.poolJettonSupply}\n`);
        ui.write(`   New Supply:  ${newPoolData.poolJettonSupply}\n`);
        ui.write(`   Difference:  ${newPoolData.poolJettonSupply - poolData.poolJettonSupply}\n\n`);

        if (newPoolData.poolJettonSupply === poolData.poolJettonSupply + amount) {
            ui.write('✅ SUCCESS! Supply updated correctly\n');
            ui.write(`   ${amount} jettons minted to ${recipient}\n`);
        } else if (newPoolData.poolJettonSupply === poolData.poolJettonSupply) {
            ui.write('⚠️  WARNING: Supply unchanged\n');
            ui.write('   Transaction may have failed or still processing\n');
            ui.write('   Check blockchain explorer for details\n');
        } else {
            ui.write('⚠️  WARNING: Supply changed by unexpected amount\n');
            ui.write('   Please investigate the transaction\n');
        }

    } catch (error) {
        ui.write('❌ ERROR: Transaction failed\n');
        ui.write(`   ${error}\n`);
    }

    ui.write('\n' + '='.repeat(50) + '\n');
    ui.write('🎉 Mint operation complete\n');
}

