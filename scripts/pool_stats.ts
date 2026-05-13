import { Address, fromNano } from 'ton-core';
import { NetworkProvider } from '@ton-community/blueprint';

export async function run(provider: NetworkProvider) {
    const ui = provider.ui();
    
    const poolAddressStr = await ui.input('Enter Pool address:');
    const poolAddress = Address.parse(poolAddressStr);
    
    ui.write('\n📊 Pool Stats\n');
    ui.write('═'.repeat(50) + '\n\n');
    
    try {
        const block = await provider.api().getLastBlock();
        
        // Get pool full data
        const result = await provider.api().runMethod(
            block.last.seqno,
            poolAddress,
            'get_pool_full_data'
        );
        
        // Extract key metrics (matching Pool.ts getFullData order)
        // 0: state, 1: halted, 2: totalBalance, 3: interestRate, 4: optimistic, 5: depositsOpen, ...
        // 13: poolJettonMinter, 14: poolJettonSupply
        const stateItem = result.result[0];
        const state = stateItem.type === 'int' ? Number(stateItem.value) : 0;
        
        const totalBalanceItem = result.result[2];
        const totalBalance = totalBalanceItem.type === 'int' ? totalBalanceItem.value : 0n;
        
        const optimisticItem = result.result[4];
        const optimistic = optimisticItem.type === 'int' ? Number(optimisticItem.value) === -1 : false;
        
        const jettonSupplyItem = result.result[14];
        const jettonSupply = jettonSupplyItem.type === 'int' ? jettonSupplyItem.value : 0n;
        
        // Calculate price: 1 Jetton = ? TON
        let price = '0';
        if (jettonSupply > 0n) {
            // Price = totalBalance / jettonSupply
            const priceNum = Number(totalBalance) / Number(jettonSupply);
            price = priceNum.toFixed(9);
        }
        
        // Display
        const isPaused = state !== 0;
        const status = isPaused ? '🔴 PAUSED' : '🟢 ACTIVE';
        
        ui.write(`   Status:          ${status}\n`);
        
        ui.write('💰 Liquidity:\n');
        ui.write(`   TON Balance:     ${fromNano(totalBalance)} TON\n\n`);
        
        ui.write('🪙 Jetton Supply:\n');
        ui.write(`   Total Supply:    ${fromNano(jettonSupply)} Jettons\n\n`);
        
        ui.write('💵 Current Price:\n');
        ui.write(`   1 Jetton =       ${price} TON\n`);
        ui.write(`   1 TON =          ${jettonSupply > 0n ? (Number(jettonSupply) / Number(totalBalance)).toFixed(9) : '0'} Jettons\n\n`);
        
        ui.write('═'.repeat(50) + '\n');
        
    } catch (error) {
        ui.write(`❌ Error: ${error}\n`);
        ui.write('   Make sure the pool address is correct.\n');
    }
}

