import { Address, toNano, beginCell } from 'ton-core';
import { NetworkProvider } from '@ton-community/blueprint';

export async function run(provider: NetworkProvider) {
    const sender = provider.sender();
    
    // YOUR ADDRESSES
    const minterAddress = Address.parse('EQBonV3fCT-iWgXx3ivBRpaCDSOplti_hQukgqkZh3J7KFM-');
    const poolAddress = Address.parse('EQD0ybZudkyst9ylmyBoXC2A6X8708RpjmC6EFQnEOQxlRiI');
    
    console.log('🔄 Transferring minter admin to Pool...');
    console.log(`   Minter: ${minterAddress}`);
    console.log(`   New Admin (Pool): ${poolAddress}\n`);
    
    // Build change_admin message
    const changeAdminMsg = beginCell()
        .storeUint(0x4840664f, 32)  // op::change_admin
        .storeUint(0, 64)           // query_id
        .storeAddress(poolAddress)   // new admin
        .endCell();
    
    // Send transaction
    await sender.send({
        to: minterAddress,
        value: toNano('0.05'),
        body: changeAdminMsg,
        bounce: true
    });
    
    console.log('✅ Transaction sent!');
    console.log('⏳ Wait 10-15 seconds, then verify:');
    console.log(`   https://testnet.tonscan.org/address/${minterAddress}`);
    console.log('   Check "Methods" tab → get_jetton_data → admin_address');
    console.log(`   Should show: ${poolAddress}\n`);
}

