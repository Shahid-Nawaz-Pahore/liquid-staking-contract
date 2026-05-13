import { Address } from 'ton-core';
import { NetworkProvider } from '@ton-community/blueprint';

export async function run(provider: NetworkProvider) {
    const ui = provider.ui();
    
    // Get minter address from user
    const minterAddressStr = await ui.input('Enter minter address:');
    const minterAddress = Address.parse(minterAddressStr);
    
    ui.write('\n🔍 Checking minter admin...\n');
    ui.write(`Minter: ${minterAddress}\n\n`);
    
    try {
        // Get jetton data
        const block = await provider.api().getLastBlock();
        const result = await provider.api().runMethod(
            block.last.seqno,
            minterAddress,
            'get_jetton_data'
        );
        
        // Extract data
        const totalSupply = result.result[0];
        const mintable = result.result[1];
        const adminItem = result.result[2];
        
        if (adminItem.type !== 'slice') {
            ui.write('❌ Could not parse admin address\n');
            return;
        }
        
        const adminAddress = adminItem.cell.beginParse().loadAddress();
        
        ui.write('📊 Jetton Data:\n');
        ui.write(`   Admin: ${adminAddress.toString()}\n\n`);
        
        // Check if admin is the expected pool
        const yourWallet = provider.sender().address;
        
        if (adminAddress.equals(yourWallet!)) {
            ui.write('⚠️  Admin is YOUR WALLET\n');
            ui.write('   You need to transfer admin to Pool!\n');
            ui.write('   Run: npx blueprint run quick_transfer_admin\n');
        } else {
            ui.write('✅ Admin is a CONTRACT (likely Pool)\n');
            ui.write(`   Admin Address: ${adminAddress}\n`);
            ui.write('   This is correct! Pool can now mint jettons.\n');
        }
        
    } catch (error) {
        ui.write(`❌ Error: ${error}\n`);
        ui.write('   Make sure the minter address is correct.\n');
    }
}

