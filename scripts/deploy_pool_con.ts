import { Address, Cell, toNano } from 'ton-core';
import { Pool, poolFullConfigToCell } from '../wrappers/Pool';
import { PoolState } from "../PoolConstants";
import { compile, NetworkProvider, sleep } from '@ton-community/blueprint';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';

/**
 * Deploy Pool with Existing Minter
 * Use this when you already have a minter deployed
 */

export async function run(provider: NetworkProvider) {
    const ui = provider.ui();
    const sender = provider.sender();
    const admin: Address = sender.address!;

    ui.write('\n🚀 DEPLOYING POOL WITH EXISTING MINTER\n');
    ui.write('═'.repeat(60));
    ui.write('\n');

    // ============================================
    // Step 1: Get Minter Address
    // ============================================
    const minterAddressStr = await ui.input(
        'Enter your Minter address (EQC...):'
    );
    const minterAddress = Address.parse(minterAddressStr);
    
    ui.write(`✅ Using Minter: ${minterAddress}\n\n`);

    // ============================================
    // Step 2: Verify Minter Exists
    // ============================================
    ui.write('🔍 Verifying minter...\n');
    
    let minterVerified = false;
    
    // Try Orbs API first
    try {
        const block = await provider.api().getLastBlock();
        const minterState = await provider.api().getAccount(block.last.seqno, minterAddress);
        
        if (minterState.account.state.type === 'active') {
            minterVerified = true;
            ui.write('✅ Minter verified (Orbs API)!\n\n');
        }
    } catch (orbsError) {
        ui.write('⚠️  Orbs API error, trying TONCenter...\n');
        
        // Fallback to TONCenter
        try {
            const tonCenterUrl = `https://testnet.toncenter.com/api/v2/getAddressInformation?address=${minterAddress.toString()}`;
            const response = await axios.get(tonCenterUrl, { timeout: 15000 });
            
            if (response.data.ok && response.data.result.state === 'active') {
                minterVerified = true;
                ui.write('✅ Minter verified (TONCenter API)!\n\n');
            }
        } catch (tonCenterError) {
            ui.write(`❌ Both APIs failed. Errors:\n`);
            ui.write(`   Orbs: ${orbsError}\n`);
            ui.write(`   TONCenter: ${tonCenterError}\n`);
        }
    }
    
    if (!minterVerified) {
        ui.write('\n⚠️  Could not verify minter automatically.\n');
        ui.write('   However, you can continue if you are SURE the minter is deployed.\n');
        ui.write(`   Check manually: https://testnet.tonscan.org/address/${minterAddress}\n\n`);
        
        const continueAnyway = await ui.input('Continue anyway? (yes/no):');
        if (continueAnyway.toLowerCase() !== 'yes' && continueAnyway.toLowerCase() !== 'y') {
            ui.write('❌ Deployment cancelled\n');
            return;
        }
        ui.write('⚠️  Continuing without verification...\n\n');
    }

    // ============================================
    // Step 3: Compile Pool
    // ============================================
    ui.write('📦 Compiling Pool contract...\n');
    
    const pool_code = await compile('Pool');
    const controller_code = await compile('Controller');
    
    // Load awaited wallet code
    const awaitedWalletPath = path.join(__dirname, '../contracts/awaited_minter/build/JettonWallet.compiled.json');
    
    if (!fs.existsSync(awaitedWalletPath)) {
        ui.write('❌ ERROR: Jetton wallet code not found!\n');
        ui.write('   Please compile: cd contracts/awaited_minter && npx blueprint build\n');
        return;
    }
    
    const awaited_wallet_code = Cell.fromBoc(
        Buffer.from(JSON.parse(fs.readFileSync(awaitedWalletPath, 'utf-8')).hex, 'hex')
    )[0];
    
    ui.write('✅ Contracts loaded\n\n');

    // ============================================
    // Step 4: Configure Pool
    // ============================================
    ui.write('⚙️  Configuring Pool...\n');
    
    const poolFullConfig = {
        state: PoolState.NORMAL as (0 | 1),
        halted: false,
        totalBalance: 0n,
        poolJetton: minterAddress, // YOUR MINTER!
        poolJettonSupply: 0n,

        // No NFT payouts - using optimistic mode
        depositMinter: null,
        requestedForDeposit: null,
        withdrawalMinter: null,
        requestedForWithdrawal: null,

        // Interest rate: 7% APY = 1830
        interestRate: 1830,
        optimisticDepositWithdrawals: true,
        depositsOpen: true,

        savedValidatorSetHash: 0n,
        currentRound: {
            borrowers: null,
            roundId: 0,
            activeBorrowers: 0n,
            borrowed: 0n,
            expected: 0n,
            returned: 0n,
            profit: 0n
        },
        prevRound: {
            borrowers: null,
            roundId: 0,
            activeBorrowers: 0n,
            borrowed: 0n,
            expected: 0n,
            returned: 0n,
            profit: 0n
        },

        minLoanPerValidator: toNano('10000'),
        maxLoanPerValidator: toNano('700000'),
        governanceFee: 2516582, // 15%
        minDepositAmount: toNano('0.1'), // 0.1 TON minimum

        // All roles = your wallet (for testing)
        sudoer: admin,
        sudoerSetAt: 0,
        governor: admin,
        governorUpdateAfter: 0xffffffffffff,
        interest_manager: admin,
        halter: admin,
        approver: admin,

        controller_code: controller_code,
        pool_jetton_wallet_code: awaited_wallet_code,
    };

    const pool = provider.open(
        Pool.createFromFullConfig(poolFullConfig, pool_code)
    );

    ui.write(`   Pool Address: ${pool.address}\n`);
    ui.write(`   Minter: ${minterAddress}\n`);
    ui.write(`   Optimistic: Enabled\n`);
    ui.write(`   Interest: 7% APY\n\n`);

    // ============================================
    // Step 5: Check if Pool Already Exists
    // ============================================
    ui.write('🔍 Checking if pool exists...\n');
    
    try {
        const block = await provider.api().getLastBlock();
        const poolState = await provider.api().getAccount(block.last.seqno, pool.address);
        
        if (poolState.account.state.type === 'active') {
            ui.write('⚠️  Pool already exists at this address!\n');
            ui.write(`   Address: ${pool.address}\n`);
            
            const proceed = await ui.input('Skip deployment? (yes/no):');
            if (proceed.toLowerCase() === 'yes' || proceed.toLowerCase() === 'y') {
                ui.write('\n✅ Using existing pool\n');
                ui.write(`🏦 Pool: ${pool.address}\n`);
                ui.write(`🪙 Minter: ${minterAddress}\n`);
                return;
            }
        }
    } catch (e) {
        // Pool doesn't exist yet - OK
    }

    // ============================================
    // Step 6: Confirm Deployment
    // ============================================
    ui.write('\n📋 DEPLOYMENT SUMMARY\n');
    ui.write('─'.repeat(40));
    ui.write(`\nPool Address: ${pool.address}`);
    ui.write(`\nMinter: ${minterAddress}`);
    ui.write(`\nAdmin: ${admin}`);
    ui.write(`\nCost: ~0.15 TON`);
    ui.write('\n' + '─'.repeat(40));
    
    const confirm = await ui.input('\nDeploy pool? (yes/no):');
    if (confirm.toLowerCase() !== 'yes' && confirm.toLowerCase() !== 'y') {
        ui.write('❌ Deployment cancelled\n');
        return;
    }

    // ============================================
    // Step 7: Deploy Pool
    // ============================================
    ui.write('\n🚀 Deploying Pool...\n');
    
    await pool.sendDeploy(sender, toNano("2"));
    
    ui.write('✅ Transaction sent!\n');
    ui.write('⏳ Waiting for deployment...\n');
    
    // Wait for deployment
    let deployed = false;
    for (let i = 0; i < 20; i++) {
        await sleep(3000);
        
        try {
            const block = await provider.api().getLastBlock();
            const poolState = await provider.api().getAccount(block.last.seqno, pool.address);
            
            if (poolState.account.state.type === 'active') {
                deployed = true;
                break;
            }
        } catch (e) {
            // Continue waiting
        }
        
        ui.write(`   Checking... (${i + 1}/20)\n`);
    }

    if (!deployed) {
        ui.write('\n⚠️  Deployment verification timed out\n');
        ui.write('   The pool might still be deploying...\n');
        ui.write('   Check manually in 1-2 minutes\n');
        ui.write(`   Address: ${pool.address}\n`);
        return;
    }

    ui.write('\n✅ Pool deployed successfully!\n\n');

    // ============================================
    // Step 8: Transfer Minter Admin to Pool
    // ============================================
    ui.write('🔄 Transfer minter admin to Pool? (IMPORTANT)\n');
    ui.write('   This allows the pool to mint jettons on deposits.\n');
    
    const transferAdmin = await ui.input('Transfer admin now? (yes/no):');
    
    if (transferAdmin.toLowerCase() === 'yes' || transferAdmin.toLowerCase() === 'y') {
        ui.write('\n🔄 Transferring minter admin...\n');
        
        const changeAdminMsg = beginCell()
            .storeUint(0x4840664f, 32) // op::change_admin
            .storeUint(0, 64)
            .storeAddress(pool.address)
            .endCell();

        await sender.send({
            to: minterAddress,
            value: toNano('0.1'),  // Match official implementation
            body: changeAdminMsg,
            bounce: true  // Bounce if minter rejects
        });

        ui.write('✅ Admin transfer transaction sent!\n');
        ui.write('⏳ Waiting for confirmation...\n');
        
        await sleep(10000); // Wait 10 seconds
        
        // Verify admin transfer
        try {
            const block = await provider.api().getLastBlock();
            const jettonData = await provider.api().runMethod(
                block.last.seqno,
                minterAddress,
                'get_jetton_data'
            );
            
            // get_jetton_data returns: total_supply, mintable, admin_address, content, wallet_code
            // Admin is returned as a Slice in the tuple
            const adminItem = jettonData.result[2];
            if (adminItem.type !== 'slice') {
                throw new Error('Unexpected admin data type');
            }
            const newAdmin = adminItem.cell.beginParse().loadAddress();
            
            if (newAdmin.toString() === pool.address.toString()) {
                ui.write('✅ Admin transfer verified! Pool is now minter admin.\n\n');
            } else {
                ui.write('⚠️  Admin verification unclear, but transaction was sent.\n');
                ui.write(`   Expected: ${pool.address}\n`);
                ui.write(`   Got: ${newAdmin}\n\n`);
            }
        } catch (e) {
            ui.write('⚠️  Could not verify admin transfer (API issue)\n');
            ui.write('   Transaction was sent - verify manually on explorer\n\n');
        }
    } else {
        ui.write('\n⚠️  Admin NOT transferred\n');
        ui.write('   You need to transfer admin manually later:\n');
        ui.write('   npx blueprint run changeAdmin (in awaited_minter folder)\n\n');
    }

    // ============================================
    // Step 9: Configure Pool Settings
    // ============================================
    ui.write('⚙️  Configuring pool settings...\n');
    
    await pool.sendSetDepositSettings(sender, toNano("0.05"), true, true);
    await sleep(5000);
    
    ui.write('✅ Optimistic mode enabled\n\n');

    // ============================================
    // DEPLOYMENT COMPLETE
    // ============================================
    ui.write('═'.repeat(60));
    ui.write('\n🎉 DEPLOYMENT COMPLETE!\n');
    ui.write('═'.repeat(60));
    ui.write('\n\n');
    
    ui.write('📋 Deployment Summary:\n');
    ui.write(`   🏦 Pool: ${pool.address}\n`);
    ui.write(`   🪙 Minter: ${minterAddress}\n`);
    ui.write(`   👤 Admin: ${admin}\n`);
    ui.write(`   ⚡ Optimistic: Enabled\n`);
    ui.write(`   💰 Cost: ~0.25 TON\n\n`);

    ui.write('🔗 Next Steps:\n');
    ui.write('   1. Verify deployment on explorer\n');
    ui.write('   2. Test deposit: npx blueprint run deposit_to_pool\n');
    ui.write('   3. Check status: npx blueprint run check_status\n');
    ui.write('   4. Verify jettons received\n\n');

    ui.write('💡 Useful Commands:\n');
    ui.write(`   export POOL_ADDRESS=${pool.address}\n`);
    ui.write('   npx blueprint run deposit_to_pool --amount=2\n');
    ui.write('   npx blueprint run check_status\n\n');

    ui.write('📚 Documentation:\n');
    ui.write('   Deposit Guide: scripts/DEPOSIT_GUIDE.md\n');
    ui.write('   Quick Start: scripts/QUICK_START.md\n\n');
}

function beginCell() {
    return require('ton-core').beginCell();
}

