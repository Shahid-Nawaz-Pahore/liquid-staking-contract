import { Address, beginCell, toNano, fromNano } from 'ton-core';
import { NetworkProvider, sleep } from '@ton-community/blueprint';

/**
 * SIMPLE WITHDRAWAL SCRIPT
 * 
 * Withdraw TON from Pool by burning your jettons
 * 
 * Usage:
 *   npx blueprint run simple_withdraw --testnet
 */

export async function run(provider: NetworkProvider) {
    const ui = provider.ui();
    const sender = provider.sender();
    const userAddress = sender.address!;

    ui.write('\n💸 WITHDRAW FROM POOL - SIMPLE MODE\n');
    ui.write('═'.repeat(60) + '\n\n');

    // ============================================
    // Configuration (Update these if needed)
    // ============================================
    const POOL_ADDRESS = 'EQCDhDcSd2_ph80QxGDUKTkvuPIn4iei5160G3nxjfTRf5bB';
    const MINTER_ADDRESS = 'EQDd8yLE7xqLksoVR9khyEiJEd0JDSndnOdVIVul9ZxOQVjM';
    
    ui.write('📍 Configuration:\n');
    ui.write(`   Pool: ${POOL_ADDRESS}\n`);
    ui.write(`   Minter: ${MINTER_ADDRESS}\n`);
    ui.write(`   Your Wallet: ${userAddress}\n\n`);

    const poolAddress = Address.parse(POOL_ADDRESS);
    const jettonMinterAddress = Address.parse(MINTER_ADDRESS);

    // ============================================
    // Step 1: Get Your Jetton Wallet Address
    // ============================================
    ui.write('🔍 Finding your jetton wallet...\n');
    
    let jettonWalletAddress: Address;
    
    try {
        const block = await provider.api().getLastBlock();
        const userCell = beginCell().storeAddress(userAddress).endCell();
        
        const walletResult = await provider.api().runMethod(
            block.last.seqno,
            jettonMinterAddress,
            'get_wallet_address',
            [{ type: 'slice', cell: userCell }]
        );
        
        const walletTuple = walletResult.result[0];
        
        if (walletTuple.type === 'slice') {
            jettonWalletAddress = walletTuple.cell.beginParse().loadAddress();
        } else {
            throw new Error('Could not get wallet address');
        }
        
        ui.write(`✅ Jetton Wallet: ${jettonWalletAddress}\n\n`);
        
    } catch (e) {
        ui.write(`❌ Error finding jetton wallet: ${e}\n`);
        ui.write('   You might not have any pool jettons yet.\n');
        ui.write('   Make sure you deposited TON first.\n');
        return;
    }

    // ============================================
    // Step 2: Get Your Jetton Balance
    // ============================================
    ui.write('🔍 Checking your balance...\n');
    
    let jettonBalance: bigint;
    
    try {
        const block = await provider.api().getLastBlock();
        const walletData = await provider.api().runMethod(
            block.last.seqno,
            jettonWalletAddress,
            'get_wallet_data'
        );
        
        const balanceTuple = walletData.result[0];
        if (balanceTuple.type === 'int') {
            jettonBalance = balanceTuple.value;
        } else {
            throw new Error('Unexpected balance format');
        }
        
        ui.write(`💰 Your Balance: ${fromNano(jettonBalance)} Pool Jettons\n\n`);
        
        if (jettonBalance === 0n) {
            ui.write('❌ You have no jettons to withdraw!\n');
            ui.write('   Deposit TON first to get jettons.\n');
            return;
        }
        
    } catch (e) {
        ui.write(`❌ Could not get balance: ${e}\n`);
        return;
    }

    // ============================================
    // Step 3: Get Pool Stats
    // ============================================
    ui.write('📊 Pool Status:\n');
    
    try {
        const block = await provider.api().getLastBlock();
        const poolData = await provider.api().runMethod(
            block.last.seqno,
            poolAddress,
            'get_pool_full_data'
        );
        
        const totalBalanceItem = poolData.result[2];
        const totalBalance = totalBalanceItem.type === 'int' ? totalBalanceItem.value : 0n;
        
        const jettonSupplyItem = poolData.result[14];
        const jettonSupply = jettonSupplyItem.type === 'int' ? jettonSupplyItem.value : 0n;
        
        ui.write(`   Pool Balance: ${fromNano(totalBalance)} TON\n`);
        ui.write(`   Total Supply: ${fromNano(jettonSupply)} Jettons\n`);
        
        if (jettonSupply > 0n) {
            const price = Number(totalBalance) / Number(jettonSupply);
            ui.write(`   Exchange Rate: 1 Jetton = ${price.toFixed(9)} TON\n\n`);
        }
        
    } catch (e) {
        ui.write(`⚠️  Could not get pool stats: ${e}\n\n`);
    }

    // ============================================
    // Step 4: Choose Withdrawal Amount
    // ============================================
    const maxWithdraw = Number(fromNano(jettonBalance));
    
    ui.write('📝 Withdrawal Options:\n');
    ui.write(`   1. Withdraw ALL (${maxWithdraw.toFixed(4)} jettons)\n`);
    ui.write('   2. Withdraw custom amount\n\n');
    
    const choice = await ui.input('Choose option (1 or 2):');
    
    let withdrawAmount: bigint;
    
    if (choice === '1') {
        withdrawAmount = jettonBalance;
        ui.write(`✅ Withdrawing ALL: ${fromNano(withdrawAmount)} jettons\n\n`);
    } else {
        const amountStr = await ui.input(`Jettons to withdraw (max ${maxWithdraw.toFixed(4)}):`);
        withdrawAmount = toNano(amountStr);
        
        if (withdrawAmount > jettonBalance) {
            ui.write('❌ Amount exceeds your balance!\n');
            return;
        }
        
        if (withdrawAmount <= 0n) {
            ui.write('❌ Amount must be greater than 0!\n');
            return;
        }
        
        ui.write(`✅ Withdrawing: ${fromNano(withdrawAmount)} jettons\n\n`);
    }

    // ============================================
    // Step 5: Choose Withdrawal Mode
    // ============================================
    ui.write('🎯 Withdrawal Mode:\n');
    ui.write('   • Immediate: Get TON instantly (if pool has funds)\n');
    ui.write('   • Delayed: Wait for round end (guaranteed)\n\n');
    
    const modeChoice = await ui.input('Request immediate? (yes/no):');
    const requestImmediate = modeChoice.toLowerCase() === 'yes' || modeChoice.toLowerCase() === 'y';

    // ============================================
    // Step 6: Confirm Withdrawal
    // ============================================
    ui.write('\n📋 WITHDRAWAL SUMMARY\n');
    ui.write('═'.repeat(60) + '\n');
    ui.write(`Jettons to burn:  ${fromNano(withdrawAmount)}\n`);
    ui.write(`Mode:             ${requestImmediate ? 'Immediate' : 'Wait till round end'}\n`);
    ui.write(`Gas fee:          ~0.25 TON\n`);
    ui.write('═'.repeat(60) + '\n\n');
    
    const confirm = await ui.input('Proceed? (yes/no):');
    if (confirm.toLowerCase() !== 'yes' && confirm.toLowerCase() !== 'y') {
        ui.write('❌ Withdrawal cancelled\n');
        return;
    }

    // ============================================
    // Step 7: Send Burn Transaction
    // ============================================
    ui.write('\n💸 Sending withdrawal transaction...\n');
    
    // Build burn message
    // op::burn = 0x595f07bc
    const burnMsg = beginCell()
        .storeUint(0x595f07bc, 32)           // op::burn
        .storeUint(0, 64)                     // query_id
        .storeCoins(withdrawAmount)           // amount to burn
        .storeAddress(userAddress)            // response_destination
        .storeBit(!requestImmediate)          // wait_till_round_end
        .storeBit(false)                      // fill_or_kill
        .endCell();

    try {
        await sender.send({
            to: jettonWalletAddress,
            value: toNano('0.25'),
            body: burnMsg
        });

        ui.write('✅ Transaction sent!\n');
        ui.write('⏳ Waiting for confirmation...\n\n');
        
        await sleep(15000);
        
        // Check new balance
        ui.write('🔍 Checking new balance...\n');
        
        const block = await provider.api().getLastBlock();
        const walletData = await provider.api().runMethod(
            block.last.seqno,
            jettonWalletAddress,
            'get_wallet_data'
        );
        
        const newBalanceTuple = walletData.result[0];
        const newBalance = newBalanceTuple.type === 'int' ? newBalanceTuple.value : 0n;
        
        ui.write(`   Old Balance: ${fromNano(jettonBalance)} jettons\n`);
        ui.write(`   New Balance: ${fromNano(newBalance)} jettons\n`);
        ui.write(`   Burned: ${fromNano(jettonBalance - newBalance)} jettons\n\n`);

        // ============================================
        // Success!
        // ============================================
        ui.write('═'.repeat(60) + '\n');
        ui.write('🎉 WITHDRAWAL COMPLETE!\n');
        ui.write('═'.repeat(60) + '\n\n');
        
        if (requestImmediate) {
            ui.write('✅ Immediate withdrawal requested\n');
            ui.write('   • Check your wallet for TON in 1-2 minutes\n');
            ui.write('   • If pool had enough funds, TON sent immediately\n');
            ui.write('   • Otherwise, you\'ll receive withdrawal NFT\n\n');
        } else {
            ui.write('⏳ Delayed withdrawal\n');
            ui.write('   • Withdrawal bill (NFT) minted\n');
            ui.write('   • Converts to TON at round end (~24-48 hours)\n\n');
        }
        
        ui.write('🔗 Check transaction:\n');
        ui.write(`   https://testnet.tonviewer.com/${poolAddress}\n\n`);

    } catch (error) {
        ui.write(`❌ Transaction failed: ${error}\n`);
        ui.write('   Please try again or check your balance.\n');
        return;
    }
}


