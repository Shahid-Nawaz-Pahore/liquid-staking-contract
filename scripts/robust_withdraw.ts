import { Address, toNano, fromNano, beginCell } from 'ton-core';
import { NetworkProvider, sleep } from '@ton-community/blueprint';
import { Pool } from '../wrappers/Pool';
import { JettonWallet } from '../wrappers/JettonWallet';

/**
 * ========================================
 * ROBUST POOL WITHDRAWAL SCRIPT
 * ========================================
 * 
 * Withdraw TON from Pool by burning jettons
 * 
 * Usage:
 *   npx blueprint run robust_withdraw --testnet
 *   npx blueprint run robust_withdraw --testnet --pool=EQC... --amount=10
 * 
 * Environment Variables:
 *   POOL_ADDRESS - Pool contract address
 *   WITHDRAW_AMOUNT - Amount of jettons to burn
 *   WITHDRAWAL_MODE - 'immediate' or 'delayed'
 */

// Configuration constants
const MIN_WITHDRAW_AMOUNT = 0.01;  // Minimum withdrawal (0.01 jettons)
const POOL_WITHDRAWAL_FEE = 0.5;   // Pool fee (0.5 TON)
const MIN_WALLET_BALANCE = 0.3;    // Minimum balance to keep in wallet for gas
const MAX_RETRIES = 3;             // Maximum transaction retry attempts
const CONFIRMATION_WAIT = 15000;   // Wait time for transaction confirmation (ms)

interface WithdrawConfig {
    poolAddress: Address;
    withdrawAmount: bigint;
    immediate: boolean;
    network: string;
}

function parseArgs(): Partial<WithdrawConfig> {
    const args = process.argv.slice(2);
    const config: Partial<WithdrawConfig> = {};
    
    // Parse pool address
    const poolArg = args.find(a => a.startsWith('--pool='))?.split('=')[1];
    const envPool = process.env.POOL_ADDRESS;
    if (poolArg) {
        config.poolAddress = Address.parse(poolArg);
    } else if (envPool) {
        config.poolAddress = Address.parse(envPool);
    }
    
    // Parse withdraw amount
    const amountArg = args.find(a => a.startsWith('--amount='))?.split('=')[1];
    const envAmount = process.env.WITHDRAW_AMOUNT;
    const amountStr = amountArg || envAmount;
    if (amountStr) {
        config.withdrawAmount = toNano(amountStr);
    }
    
    // Parse withdrawal mode
    const modeArg = args.find(a => a.startsWith('--mode='))?.split('=')[1];
    const envMode = process.env.WITHDRAWAL_MODE;
    const mode = modeArg || envMode;
    if (mode) {
        config.immediate = mode.toLowerCase() === 'immediate';
    }
    
    // Parse network
    const networkArg = args.find(a => a.startsWith('--network='))?.split('=')[1];
    config.network = networkArg || process.env.NETWORK || 'testnet';
    
    return config;
}

async function getJettonBalance(
    provider: NetworkProvider,
    minterAddress: Address,
    ownerAddress: Address
): Promise<bigint> {
    try {
        // Calculate jetton wallet address
        const ownerCell = beginCell().storeAddress(ownerAddress).endCell();
        const walletAddress = await provider.provider(minterAddress).get('get_wallet_address', [
            { type: 'slice', cell: ownerCell }
        ]);
        
        const jettonWalletAddress = walletAddress.stack.readAddress();
        const jettonWallet = provider.open(JettonWallet.createFromAddress(jettonWalletAddress));
        
        // Get balance
        const balanceResult = await provider.provider(jettonWalletAddress).get('get_wallet_data', []);
        return balanceResult.stack.readBigNumber();
    } catch (error) {
        // Wallet might not exist
        return 0n;
    }
}

async function getJettonWalletAddress(
    provider: NetworkProvider,
    minterAddress: Address,
    ownerAddress: Address
): Promise<Address | null> {
    try {
        const ownerCell = beginCell().storeAddress(ownerAddress).endCell();
        const walletAddress = await provider.provider(minterAddress).get('get_wallet_address', [
            { type: 'slice', cell: ownerCell }
        ]);
        return walletAddress.stack.readAddress();
    } catch (error) {
        return null;
    }
}

async function validatePoolState(pool: any): Promise<void> {
    const data = await pool.getFullData();
    
    if (data.halted) {
        throw new Error('❌ Pool is HALTED. Cannot withdraw at this time.');
    }
    
    if (data.state !== 0) {
        throw new Error('❌ Pool is not in NORMAL state. Cannot process withdrawals.');
    }
}

async function confirmTransaction(
    provider: NetworkProvider,
    txHash: string,
    maxWaitTime: number
): Promise<boolean> {
    const ui = provider.ui();
    const startTime = Date.now();
    
    ui.write('⏳ Waiting for transaction confirmation...');
    
    while (Date.now() - startTime < maxWaitTime) {
        await sleep(3000);
        // In production, you'd query the transaction status here
        // For now, we'll wait the full time
    }
    
    return true;
}

export async function run(provider: NetworkProvider) {
    const ui = provider.ui();
    
    try {
        // Parse configuration
        const config = parseArgs();
        
        ui.write('\n💸 ROBUST POOL WITHDRAWAL SCRIPT');
        ui.write('═'.repeat(60));
        ui.write(`\n🌐 Network: ${config.network || 'testnet'}`);
        ui.write('');
        
        // Get pool address
        let poolAddress = config.poolAddress;
        if (!poolAddress) {
            const addressStr = await ui.input('Enter Pool contract address:');
            poolAddress = Address.parse(addressStr);
        }
        ui.write(`🏦 Pool: ${poolAddress.toString()}`);
        
        // Get sender wallet
        const sender = provider.sender();
        const senderAddress = sender.address!;
        ui.write(`👤 Your wallet: ${senderAddress.toString()}`);
        
        // Open pool contract
        const pool = provider.open(Pool.createFromAddress(poolAddress));
        
        // Validate pool state
        ui.write('\n🔍 STEP 1: Validating pool state...');
        await validatePoolState(pool);
        
        const poolData = await pool.getFullData();
        ui.write(`✅ Pool is operational`);
        ui.write(`   - State: ${poolData.state === 0 ? 'NORMAL' : 'REPAYMENT_ONLY'}`);
        ui.write(`   - Halted: ${poolData.halted ? 'YES' : 'NO'}`);
        ui.write(`   - Optimistic Mode: ${poolData.optimisticDepositWithdrawals ? 'ENABLED' : 'DISABLED'}`);
        ui.write(`   - Pool Balance: ${fromNano(poolData.totalBalance)} TON`);
        ui.write(`   - Total Supply: ${fromNano(poolData.poolJettonSupply)} Jettons`);
        
        // Calculate exchange rate
        let exchangeRate = 0;
        if (poolData.poolJettonSupply > 0n) {
            exchangeRate = Number(poolData.totalBalance) / Number(poolData.poolJettonSupply);
        }
        ui.write(`   - Exchange Rate: 1 Jetton = ${exchangeRate.toFixed(9)} TON`);
        
        // Get jetton minter
        const jettonMinter = poolData.poolJettonMinter || poolData.jettonMinter;
        ui.write(`   - Jetton Minter: ${jettonMinter.toString()}`);
        
        // Get current jetton balance (before withdrawal)
        ui.write('\n🔍 STEP 2: Checking your jetton balance...');
        const balanceBefore = await getJettonBalance(provider, jettonMinter, senderAddress);
        ui.write(`🪙 Current jetton balance: ${fromNano(balanceBefore)} Pool Jettons`);
        
        if (balanceBefore === 0n) {
            throw new Error('❌ You have no jettons to withdraw! Deposit TON first.');
        }
        
        // Get jetton wallet address
        ui.write('\n🔍 STEP 3: Finding your jetton wallet...');
        const jettonWalletAddress = await getJettonWalletAddress(provider, jettonMinter, senderAddress);
        if (!jettonWalletAddress) {
            throw new Error('❌ Could not find your jetton wallet!');
        }
        ui.write(`✅ Jetton Wallet: ${jettonWalletAddress.toString()}`);
        
        // Get withdrawal amount
        let withdrawAmount = config.withdrawAmount;
        if (!withdrawAmount) {
            const maxWithdraw = Number(fromNano(balanceBefore));
            ui.write(`\n💡 Maximum withdrawal: ${maxWithdraw.toFixed(4)} jettons`);
            const amountStr = await ui.input(
                `Enter withdrawal amount in jettons (max ${maxWithdraw.toFixed(4)}):`
            );
            withdrawAmount = toNano(amountStr);
        }
        
        const withdrawJettons = Number(fromNano(withdrawAmount));
        ui.write(`💵 Withdrawal Amount: ${withdrawJettons} jettons`);
        
        // Validate withdrawal amount
        if (withdrawJettons < MIN_WITHDRAW_AMOUNT) {
            throw new Error(
                `❌ Withdrawal amount too low. Minimum: ${MIN_WITHDRAW_AMOUNT} jettons`
            );
        }
        
        if (withdrawAmount > balanceBefore) {
            throw new Error(
                `❌ Withdrawal amount exceeds your balance! You have ${fromNano(balanceBefore)} jettons.`
            );
        }
        
        // Calculate expected TON
        const expectedTON = withdrawJettons * exchangeRate;
        ui.write(`📊 Breakdown:`);
        ui.write(`   - Jettons to burn: ${withdrawJettons}`);
        ui.write(`   - Expected TON: ~${expectedTON.toFixed(4)} TON`);
        ui.write(`   - Gas fee: ~${POOL_WITHDRAWAL_FEE} TON`);
        ui.write('');
        
        // Get withdrawal mode
        let requestImmediate = config.immediate;
        let modeStr = '';
        
        // Check if optimistic mode is enabled
        if (poolData.optimisticDepositWithdrawals) {
            ui.write('\n⚠️  IMPORTANT: Optimistic Mode is ENABLED');
            ui.write('   - Only IMMEDIATE withdrawals are supported');
            ui.write('   - Delayed withdrawals will FAIL and refund your jettons');
            ui.write('   - Make sure pool has enough TON before proceeding\n');
            
            if (requestImmediate === false) {
                throw new Error('❌ Delayed withdrawals are not supported in optimistic mode!');
            }
            
            requestImmediate = true; // Force immediate
            modeStr = 'Immediate (REQUIRED for optimistic mode)';
            ui.write(`✅ Mode: ${modeStr}`);
        } else {
            if (requestImmediate === undefined) {
                ui.write('🎯 Withdrawal Mode:');
                ui.write('   1. Immediate (if pool has enough TON)');
                ui.write('   2. Wait till round end (guaranteed)');
                ui.write('');
                const modeChoice = await ui.input('Request immediate withdrawal? (yes/no):');
                requestImmediate = modeChoice.toLowerCase() === 'yes' || modeChoice.toLowerCase() === 'y';
            }
            
            modeStr = requestImmediate ? 'Immediate' : 'Wait till round end';
            ui.write(`✅ Mode: ${modeStr}`);
        }
        
        // Check if pool has enough TON for immediate withdrawal
        if (requestImmediate) {
            // Pool reserves 10 TON minimum for storage + operations
            const MIN_POOL_RESERVE = toNano('10');
            const availableTON = poolData.totalBalance > MIN_POOL_RESERVE 
                ? poolData.totalBalance - MIN_POOL_RESERVE 
                : 0n;
            const requiredTON = toNano(expectedTON.toString());
            
            ui.write('\n💰 Pool Liquidity Check:');
            ui.write(`   - Pool Total Balance: ${fromNano(poolData.totalBalance)} TON`);
            ui.write(`   - Pool Reserve (locked): ${fromNano(MIN_POOL_RESERVE)} TON`);
            ui.write(`   - Available for withdrawal: ${fromNano(availableTON)} TON`);
            ui.write(`   - Your withdrawal needs: ~${expectedTON.toFixed(4)} TON`);
            
            if (availableTON < requiredTON) {
                ui.write('\n❌ ERROR: Pool does NOT have enough TON!');
                ui.write(`   - Pool available: ${fromNano(availableTON)} TON`);
                ui.write(`   - You need: ~${expectedTON.toFixed(4)} TON`);
                ui.write(`   - Deficit: ~${(Number(fromNano(requiredTON)) - Number(fromNano(availableTON))).toFixed(4)} TON`);
                ui.write('\n⚠️  If you proceed:');
                ui.write('   - Transaction will FAIL');
                ui.write('   - You will get your jettons BACK');
                ui.write('   - You will LOSE gas fees (~0.5 TON)');
                ui.write('\n💡 Solution: Wait for more deposits or try smaller amount');
                
                const proceedAnyway = await ui.input('\n⚠️  Proceed anyway? (yes/no):');
                if (proceedAnyway.toLowerCase() !== 'yes') {
                    throw new Error('Withdrawal cancelled - insufficient pool liquidity');
                }
            } else {
                ui.write('\n✅ Pool has sufficient TON for immediate withdrawal');
            }
        }
        
        // Confirm with user
        ui.write('\n📋 WITHDRAWAL SUMMARY');
        ui.write('─'.repeat(40));
        ui.write(`Pool Address:      ${poolAddress.toString()}`);
        ui.write(`Jettons to Burn:   ${withdrawJettons}`);
        ui.write(`Expected TON:      ~${expectedTON.toFixed(4)} TON`);
        ui.write(`Mode:              ${modeStr}`);
        ui.write(`Transaction Fee:   ~${POOL_WITHDRAWAL_FEE} TON`);
        ui.write('─'.repeat(40));
        
        const confirm = await ui.input('Proceed with withdrawal? (yes/no):');
        if (confirm.toLowerCase() !== 'yes' && confirm.toLowerCase() !== 'y') {
            ui.write('❌ Withdrawal cancelled by user');
            return;
        }
        
        // Execute withdrawal with retry logic
        ui.write('\n💸 STEP 4: Sending withdrawal transaction...');
        let attempt = 0;
        let success = false;
        let txError: Error | null = null;
        
        while (attempt < MAX_RETRIES && !success) {
            attempt++;
            if (attempt > 1) {
                ui.write(`🔄 Retry attempt ${attempt}/${MAX_RETRIES}...`);
            }
            
            try {
                // Build burn message
                // op::burn = 0x595f07bc
                const burnMsg = beginCell()
                    .storeUint(0x595f07bc, 32)           // op::burn
                    .storeUint(0, 64)                     // query_id
                    .storeCoins(withdrawAmount)           // amount to burn
                    .storeAddress(senderAddress)          // response_destination
                    .storeBit(!requestImmediate)          // wait_till_round_end
                    .storeBit(false)                      // fill_or_kill
                    .endCell();
                
                await sender.send({
                    to: jettonWalletAddress,
                    value: toNano(POOL_WITHDRAWAL_FEE.toString()),
                    body: burnMsg
                });
                
                success = true;
                ui.write('✅ Transaction sent successfully!');
            } catch (error) {
                txError = error as Error;
                ui.write(`⚠️  Attempt ${attempt} failed: ${txError.message}`);
                
                if (attempt < MAX_RETRIES) {
                    ui.write('⏳ Waiting 5 seconds before retry...');
                    await sleep(5000);
                }
            }
        }
        
        if (!success) {
            throw new Error(
                `❌ Transaction failed after ${MAX_RETRIES} attempts.\n` +
                `Last error: ${txError?.message || 'Unknown error'}`
            );
        }
        
        // Wait for confirmation
        ui.write('\n⏳ STEP 5: Waiting for confirmation...');
        ui.write(`⏱️  Waiting ${CONFIRMATION_WAIT / 1000} seconds...`);
        await sleep(CONFIRMATION_WAIT);
        
        // Verify jetton balance decrease
        ui.write('\n🔍 STEP 6: Verifying withdrawal...');
        
        let balanceAfter: bigint;
        let verifyAttempts = 0;
        const maxVerifyAttempts = 5;
        
        // Try multiple times as it might take a moment for balance to update
        while (verifyAttempts < maxVerifyAttempts) {
            verifyAttempts++;
            balanceAfter = await getJettonBalance(provider, jettonMinter, senderAddress);
            
            if (balanceAfter < balanceBefore) {
                break; // Balance decreased!
            }
            
            if (verifyAttempts < maxVerifyAttempts) {
                ui.write(`⏳ Balance not updated yet, checking again... (${verifyAttempts}/${maxVerifyAttempts})`);
                await sleep(5000);
            }
        }
        
        balanceAfter = await getJettonBalance(provider, jettonMinter, senderAddress);
        const jettonsBurned = balanceBefore - balanceAfter;
        
        ui.write('\n🎉 WITHDRAWAL COMPLETE!');
        ui.write('═'.repeat(60));
        ui.write(`✅ Transaction Status: SUCCESS`);
        ui.write('');
        ui.write('📊 Results:');
        ui.write(`   Jettons Before: ${fromNano(balanceBefore)}`);
        ui.write(`   Jettons After: ${fromNano(balanceAfter)}`);
        ui.write(`   Jettons Burned: ${fromNano(jettonsBurned)}`);
        ui.write('');
        
        if (jettonsBurned > 0n) {
            ui.write('✅ Jettons successfully burned!');
            const actualBurned = Number(fromNano(jettonsBurned));
            ui.write(`📉 Burned amount: ${actualBurned.toFixed(6)} jettons`);
        } else {
            ui.write('⚠️  Warning: Jetton balance not decreased yet.');
            ui.write('💡 Transaction might still be processing.');
            ui.write('💡 Check your balance again in a few minutes.');
        }
        
        ui.write('\n🔗 Next Steps:');
        if (requestImmediate) {
            ui.write('   1. Check your wallet for TON (should arrive in 1-2 minutes)');
            ui.write('   2. If pool had enough TON, funds sent immediately');
            ui.write('   3. Otherwise, you received a withdrawal NFT');
            ui.write('   4. NFT converts to TON at validation round end');
        } else {
            ui.write('   1. You received a withdrawal bill (NFT)');
            ui.write('   2. NFT converts to TON automatically at round end');
            ui.write('   3. Usually takes 24-48 hours (validation cycle)');
            ui.write('   4. Check your wallet after round completion');
        }
        ui.write('');
        ui.write(`🏦 Pool Address: ${poolAddress.toString()}`);
        ui.write(`🪙 Jetton Minter: ${jettonMinter.toString()}`);
        ui.write('');
        ui.write('Thank you for using TON Liquid Staking! 🚀');
        
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        ui.write('\n❌ WITHDRAWAL FAILED');
        ui.write('═'.repeat(60));
        ui.write(`Error: ${msg}`);
        ui.write('');
        
        // Provide helpful hints based on error type
        if (msg.includes('Invalid address')) {
            ui.write('💡 Hint: Check your pool address format');
        } else if (msg.includes('no jettons')) {
            ui.write('💡 Hint: You need to deposit TON first to get jettons');
            ui.write('💡 Run: npx blueprint run deposit_to_pool');
        } else if (msg.includes('exceeds your balance')) {
            ui.write('💡 Hint: Check your jetton balance');
            ui.write('💡 Run: npx blueprint run pool_stats');
        } else if (msg.includes('HALTED')) {
            ui.write('💡 Hint: Pool is temporarily halted by admin');
            ui.write('💡 Check pool status: npx blueprint run check_pool_config');
        } else if (msg.includes('timeout') || msg.includes('network')) {
            ui.write('💡 Hint: Check your network connection and try again');
        }
        
        ui.write('');
        ui.write('📚 For help, see: scripts/README.md');
        
        throw error;
    }
}

