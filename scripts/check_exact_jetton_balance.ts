import { Address } from 'ton-core';
import { NetworkProvider } from '@ton-community/blueprint';

export async function run(provider: NetworkProvider) {
    const ui = provider.ui();
    
    const walletAddr = await ui.input('Enter your wallet address:');
    const minterAddr = await ui.input('Enter minter address:');
    
    const wallet = Address.parse(walletAddr);
    const minter = Address.parse(minterAddr);
    
    ui.write('\n🔍 Checking EXACT jetton balance...\n\n');
    
    try {
        // Get wallet address from minter
        const block = await provider.api().getLastBlock();
        const walletAddrResult = await provider.api().runMethod(
            block.last.seqno,
            minter,
            'get_wallet_address',
            [{ type: 'slice', cell: beginCell().storeAddress(wallet).endCell() }]
        );
        
        const jettonWalletAddr = walletAddrResult.result[0];
        if (jettonWalletAddr.type !== 'slice') {
            throw new Error('Invalid wallet address');
        }
        
        const jettonWallet = jettonWalletAddr.cell.beginParse().loadAddress();
        
        ui.write(`📍 Your Jetton Wallet: ${jettonWallet}\n\n`);
        
        // Get balance
        const balanceResult = await provider.api().runMethod(
            block.last.seqno,
            jettonWallet,
            'get_wallet_data'
        );
        
        const balance = balanceResult.result[0];
        if (balance.type !== 'int') {
            throw new Error('Invalid balance');
        }
        
        ui.write(`🪙 RAW Balance (on-chain units): ${balance.value.toString()}\n`);
        ui.write(`🪙 With 9 decimals: ${(Number(balance.value) / 1_000_000_000).toFixed(9)}\n`);
        ui.write(`🪙 With 0 decimals: ${balance.value.toString()}\n\n`);
        
        if (balance.value < 1_000_000_000n) {
            ui.write('⚠️  WARNING: Balance is less than 1 billion units!\n');
            ui.write('This means the Pool is NOT multiplying by decimals!\n\n');
            ui.write('Expected for 0.5 TON deposit: 500,000,000 units\n');
            ui.write(`Actual: ${balance.value.toString()} units\n`);
        } else {
            ui.write('✅ Balance looks correct (in proper decimal units)\n');
        }
        
    } catch (error) {
        ui.write(`❌ Error: ${error}\n`);
    }
}

function beginCell() {
    return require('ton-core').beginCell();
}

