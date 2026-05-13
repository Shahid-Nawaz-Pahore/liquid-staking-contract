import { Address, beginCell, toNano, fromNano } from 'ton-core';
import { NetworkProvider, sleep } from '@ton-community/blueprint';

/**
 * Withdraw TON from Pool by Burning Jettons
 * 
 * This script burns your pool jettons and receives TON back.
 * 
 * Usage:
 *   npx blueprint run withdraw_from_pool
 * 
 * Options:
 *   Set POOL_ADDRESS env variable
 */

export async function run(provider: NetworkProvider) {
    const ui = provider.ui();
    const sender = provider.sender();
    const userAddress = sender.address!;

    ui.write('\n💸 WITHDRAW TON FROM POOL\n');
    ui.write('═'.repeat(60));
    ui.write('\n\n');

    // ============================================
    // Step 1: Get Pool Address
    // ============================================
    const envPool = process.env.POOL_ADDRESS;
    const poolAddressStr = envPool || await ui.input('Pool address (EQ...):');
    const poolAddress = Address.parse(poolAddressStr);
    
    ui.write(`✅ Pool: ${poolAddress}\n\n`);

    // ============================================
    // Step 2: Get Jetton Minter from Pool
    // ============================================
    ui.write('🔍 Getting pool info...\n');
    
    let jettonMinterAddress: Address;
    
    try {
        const block = await provider.api().getLastBlock();
        const poolData = await provider.api().runMethod(
            block.last.seqno,
            poolAddress,
            'get_pool_full_data'
        );
        
        // Try to get minter address from result[13] (poolJettonMinter)
        // Pool data order: state, halted, totalBalance, ..., poolJettonMinter (index 13)
        let minterTuple = poolData.result[13];
        
        if (minterTuple && minterTuple.type === 'slice') {
            jettonMinterAddress = minterTuple.cell.beginParse().loadAddress();
        } else {
            throw new Error('Minter address not found at expected index');
        }
        
        ui.write(`✅ Jetton Minter: ${jettonMinterAddress}\n\n`);
        
    } catch (e) {
        ui.write(`⚠️  Auto-detection failed: ${e}\n`);
        ui.write('💡 Known minter: EQDd8yLE7xqLksoVR9khyEiJEd0JDSndnOdVIVul9ZxOQVjM\n\n');
        const minterStr = await ui.input('Enter Jetton Minter address:');
        jettonMinterAddress = Address.parse(minterStr);
        ui.write(`✅ Using Minter: ${jettonMinterAddress}\n\n`);
    }

    // ============================================
    // Step 3: Get Your Jetton Wallet Address
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
        
        ui.write(`✅ Your Jetton Wallet: ${jettonWalletAddress}\n\n`);
        
    } catch (e) {
        ui.write(`❌ Could not find your jetton wallet: ${e}\n`);
        ui.write('   You might not have any pool jettons yet.\n');
        return;
    }

    // ============================================
    // Step 4: Get Your Jetton Balance
    // ============================================
    ui.write('🔍 Checking your jetton balance...\n');
    
    let jettonBalance: bigint;
    
    try {
        const block = await provider.api().getLastBlock();
        const walletData = await provider.api().runMethod(
            block.last.seqno,
            jettonWalletAddress,
            'get_wallet_data'
        );
        
        // Handle tuple item properly
        const balanceTuple = walletData.result[0];
        if (balanceTuple.type === 'int') {
            jettonBalance = balanceTuple.value;
        } else {
            throw new Error('Unexpected balance format');
        }
        
        ui.write(`💰 Your Balance: ${fromNano(jettonBalance)} Pool Jettons\n\n`);
        
        if (jettonBalance === 0n) {
            ui.write('❌ You have no jettons to withdraw!\n');
            return;
        }
        
    } catch (e) {
        ui.write(`❌ Could not get balance: ${e}\n`);
        return;
    }

    // ============================================
    // Step 5: Get Withdrawal Amount
    // ============================================
    const maxWithdraw = Number(fromNano(jettonBalance));
    
    ui.write(`📝 How much do you want to withdraw?\n`);
    ui.write(`   Maximum: ${maxWithdraw.toFixed(4)} jettons\n\n`);
    
    const withdrawAmountStr = await ui.input(
        `Jettons to burn (max ${maxWithdraw.toFixed(4)}):`
    );
    
    const withdrawAmount = toNano(withdrawAmountStr);
    
    if (withdrawAmount > jettonBalance) {
        ui.write('❌ Amount exceeds your balance!\n');
        return;
    }
    
    if (withdrawAmount <= 0n) {
        ui.write('❌ Amount must be greater than 0!\n');
        return;
    }

    // Estimate TON to receive (approximate)
    const tonToReceive = Number(withdrawAmountStr) * 0.99; // Roughly 1:1 minus fees
    
    ui.write(`\n📊 Withdrawal Details:\n`);
    ui.write(`   Jettons to burn: ${withdrawAmountStr}\n`);
    ui.write(`   Estimated TON: ~${tonToReceive.toFixed(2)} TON\n`);
    ui.write(`   Withdrawal fee: ~0.25 TON\n\n`);

    // ============================================
    // Step 6: Withdrawal Options
    // ============================================
    ui.write('🎯 Withdrawal Mode:\n');
    ui.write('   1. Immediate (if pool has enough TON)\n');
    ui.write('   2. Wait till round end (guaranteed)\n\n');
    
    const immediate = await ui.input('Request immediate withdrawal? (yes/no):');
    const requestImmediate = immediate.toLowerCase() === 'yes' || immediate.toLowerCase() === 'y';

    // ============================================
    // Step 7: Confirm Withdrawal
    // ============================================
    ui.write('\n📋 WITHDRAWAL SUMMARY\n');
    ui.write('─'.repeat(40));
    ui.write(`\nJettons to burn: ${withdrawAmountStr}`);
    ui.write(`\nEstimated TON: ~${tonToReceive.toFixed(2)}`);
    ui.write(`\nMode: ${requestImmediate ? 'Immediate' : 'Wait till round end'}`);
    ui.write(`\nCost: ~0.25 TON`);
    ui.write('\n' + '─'.repeat(40));
    
    const confirm = await ui.input('\nProceed with withdrawal? (yes/no):');
    if (confirm.toLowerCase() !== 'yes' && confirm.toLowerCase() !== 'y') {
        ui.write('❌ Withdrawal cancelled\n');
        return;
    }

    // ============================================
    // Step 8: Build Burn Message
    // ============================================
    ui.write('\n💸 Processing withdrawal...\n');
    
    // Build burn message
    // op::burn = 0x595f07bc
    const burnMsg = beginCell()
        .storeUint(0x595f07bc, 32)      // op::burn
        .storeUint(0, 64)                // query_id
        .storeCoins(withdrawAmount)      // amount to burn
        .storeAddress(userAddress)       // response_destination
        .storeBit(!requestImmediate)     // wait_till_round_end (opposite of immediate)
        .storeBit(false)                 // fill_or_kill
        .endCell();

    try {
        await sender.send({
            to: jettonWalletAddress,
            value: toNano('0.25'), // Gas for burn + withdrawal
            body: burnMsg
        });

        ui.write('✅ Transaction sent!\n');
        ui.write('⏳ Waiting for confirmation...\n');
        
        await sleep(15000);
        
        ui.write('✅ Transaction processed\n\n');

    } catch (error) {
        ui.write(`❌ Transaction failed: ${error}\n`);
        return;
    }

    // ============================================
    // WITHDRAWAL COMPLETE
    // ============================================
    ui.write('═'.repeat(60));
    ui.write('\n🎉 WITHDRAWAL INITIATED!\n');
    ui.write('═'.repeat(60));
    ui.write('\n\n');
    
    ui.write('📋 Summary:\n');
    ui.write(`   Jettons Burned: ${withdrawAmountStr}\n`);
    ui.write(`   Expected TON: ~${tonToReceive.toFixed(2)}\n`);
    ui.write(`   Mode: ${requestImmediate ? 'Immediate' : 'Round end'}\n\n`);

    if (requestImmediate) {
        ui.write('✅ If pool has enough TON:\n');
        ui.write('   - TON sent to your wallet immediately\n');
        ui.write('   - Check your wallet in 1-2 minutes\n\n');
        
        ui.write('⚠️  If pool lacks TON:\n');
        ui.write('   - Withdrawal bill (NFT) minted\n');
        ui.write('   - Convertible at round end\n\n');
    } else {
        ui.write('⏳ Wait till round end:\n');
        ui.write('   - Withdrawal bill (NFT) minted\n');
        ui.write('   - Converts automatically after validation round\n');
        ui.write('   - Usually 24-48 hours\n\n');
    }

    ui.write('🔗 Check Status:\n');
    ui.write('   - View wallet balance\n');
    ui.write('   - Check pool on explorer\n');
    ui.write(`   - https://testnet.tonviewer.com/${poolAddress}\n\n`);
}

