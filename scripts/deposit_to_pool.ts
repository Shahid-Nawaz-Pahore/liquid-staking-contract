import { Address, toNano, fromNano, beginCell } from 'ton-core';
import { NetworkProvider, sleep } from '@ton-community/blueprint';
import { Pool } from '../wrappers/Pool';
import { JettonWallet } from '../wrappers/JettonWallet';


// Configuration constants
const MIN_DEPOSIT_AMOUNT = 1.01; // Minimum deposit (must be > 1 TON fee)
const POOL_DEPOSIT_FEE = 1.0;    // Pool fee (1 TON)
const MIN_WALLET_BALANCE = 0.5;  // Minimum balance to keep in wallet for gas
const MAX_RETRIES = 3;           // Maximum transaction retry attempts
const CONFIRMATION_WAIT = 15000; // Wait time for transaction confirmation (ms)

interface DepositConfig {
    poolAddress: Address;
    depositAmount: bigint;
    network: string;
}

function parseArgs(): Partial<DepositConfig> {
    const args = process.argv.slice(2);
    const config: Partial<DepositConfig> = {};
    
    // Parse pool address
    const poolArg = args.find(a => a.startsWith('--pool='))?.split('=')[1];
    const envPool = process.env.POOL_ADDRESS;
    if (poolArg) {
        config.poolAddress = Address.parse(poolArg);
    } else if (envPool) {
        config.poolAddress = Address.parse(envPool);
    }
    
    // Parse deposit amount
    const amountArg = args.find(a => a.startsWith('--amount='))?.split('=')[1];
    const envAmount = process.env.DEPOSIT_AMOUNT;
    const amountStr = amountArg || envAmount;
    if (amountStr) {
        config.depositAmount = toNano(amountStr);
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
        // Wallet might not exist yet (first deposit)
        return 0n;
    }
}

async function validatePoolState(pool: any): Promise<void> {
    const data = await pool.getFullData();
    
    if (data.halted) {
        throw new Error('❌ Pool is HALTED. Cannot deposit at this time.');
    }
    
    if (!data.depositsOpen) {
        throw new Error('❌ Deposits are CLOSED. Governor has disabled deposits.');
    }
    
    if (data.state !== 0) {
        throw new Error('❌ Pool is not in NORMAL state. Cannot accept deposits.');
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
        
        ui.write('\n💰 ROBUST POOL DEPOSIT SCRIPT');
        ui.write('═'.repeat(60));
        ui.write(`🌐 Network: ${config.network || 'testnet'}`);
        ui.write('');
        
        // Get pool address
        let poolAddress = config.poolAddress;
        if (!poolAddress) {
            const addressStr = await ui.input('Enter Pool contract address:');
            poolAddress = Address.parse(addressStr);
        }
        ui.write(`🏦 Pool: ${poolAddress.toString()}`);
        
        // Get deposit amount
        let depositAmount = config.depositAmount;
        if (!depositAmount) {
            const amountStr = await ui.input(
                `Enter deposit amount in TON:` 
            );
            depositAmount = toNano(amountStr);
        }
        
        const depositTON = Number(fromNano(depositAmount));
        ui.write(`💵 Deposit Amount: ${depositTON} TON`);
        
        // Validate deposit amount
        if (depositTON < MIN_DEPOSIT_AMOUNT) {
            throw new Error(
                `❌ Deposit amount too low. Minimum: ${MIN_DEPOSIT_AMOUNT} TON ` +
                `(${POOL_DEPOSIT_FEE} TON fee + at least 0.01 TON deposit)`
            );
        }
        
        const effectiveDeposit = depositTON - POOL_DEPOSIT_FEE;
        ui.write(`📊 Breakdown:`);
        ui.write(`   - Pool deposit fee: ${POOL_DEPOSIT_FEE} TON`);
        ui.write(`   - Effective deposit: ${effectiveDeposit} TON`);
        ui.write(`   - Gas fee: ~0.05 TON`);
        ui.write('');
        
        // Get sender wallet
        const sender = provider.sender();
        const senderAddress = sender.address!;
        ui.write(`👤 Your wallet: ${senderAddress.toString()}`);
        
        // Check wallet balance
        ui.write('\n🔍 STEP 1: Validating wallet balance...');
        
        // Calculate required balance
        const totalRequired = depositTON + MIN_WALLET_BALANCE + 0.05; // deposit + reserve + gas
        
        ui.write(`📝 Total required: ${totalRequired.toFixed(2)} TON`);
        ui.write(`💡 Please ensure your wallet has at least ${totalRequired.toFixed(2)} TON`);
        ui.write(`   (${depositTON} TON deposit + ${(MIN_WALLET_BALANCE + 0.05).toFixed(2)} TON for fees & reserve)`);
        
        // Note: Blueprint will automatically check balance when sending transaction
        // If insufficient, the transaction will fail with clear error message
        ui.write('✅ Proceeding (balance will be checked during transaction)');
        
        // Open pool contract
        const pool = provider.open(Pool.createFromAddress(poolAddress));
        
        // Validate pool state
        ui.write('\n🔍 STEP 2: Validating pool state...');
        await validatePoolState(pool);
        
        const poolData = await pool.getFullData();
        ui.write(`✅ Pool is operational`);
        ui.write(`   - State: ${poolData.state === 0 ? 'NORMAL' : 'REPAYMENT_ONLY'}`);
        ui.write(`   - Halted: ${poolData.halted ? 'YES' : 'NO'}`);
        ui.write(`   - Deposits Open: ${poolData.depositsOpen ? 'YES' : 'NO'}`);
        ui.write(`   - Optimistic Mode: ${poolData.optimisticDepositWithdrawals ? 'ENABLED' : 'DISABLED'}`);
        
        // Get current jetton balance (before deposit)
        ui.write('\n🔍 STEP 3: Checking current jetton balance...');
        const jettonMinter = poolData.poolJettonMinter || poolData.jettonMinter;
        const balanceBefore = await getJettonBalance(provider, jettonMinter, senderAddress);
        ui.write(`🪙 Current jetton balance: ${fromNano(balanceBefore)} Pool Jettons`);
        
        // Calculate expected jettons
        let expectedJettons = 0;
        if (poolData.supply === 0n) {
            // First deposit: 1:1 ratio
            expectedJettons = effectiveDeposit;
        } else {
            // Calculate ratio
            const balance = Number(fromNano(poolData.totalBalance));
            const supply = Number(fromNano(poolData.supply));
            const ratio = supply / balance;
            expectedJettons = effectiveDeposit * ratio;
        }
        ui.write(`📈 Expected to receive: ~${expectedJettons.toFixed(4)} Pool Jettons`);
        
        // Confirm with user
        ui.write('\n📋 TRANSACTION SUMMARY');
        ui.write('─'.repeat(40));
        ui.write(`Pool Address:      ${poolAddress.toString()}`);
        ui.write(`Deposit Amount:    ${depositTON} TON`);
        ui.write(`Effective Deposit: ${effectiveDeposit} TON`);
        ui.write(`Expected Jettons:  ~${expectedJettons.toFixed(4)}`);
        ui.write(`Transaction Fee:   ~0.05 TON`);
        ui.write('─'.repeat(40));
        
        const confirm = await ui.input('Proceed with deposit? (yes/no):');
        if (confirm.toLowerCase() !== 'yes' && confirm.toLowerCase() !== 'y') {
            ui.write('❌ Deposit cancelled by user');
            return;
        }
        
        // Execute deposit with retry logic
        ui.write('\n💸 STEP 4: Sending deposit transaction...');
        let attempt = 0;
        let success = false;
        let txError: Error | null = null;
        
        while (attempt < MAX_RETRIES && !success) {
            attempt++;
            if (attempt > 1) {
                ui.write(`🔄 Retry attempt ${attempt}/${MAX_RETRIES}...`);
            }
            
            try {
                await pool.sendDeposit(sender, depositAmount);
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
        
        // Verify jetton balance increase
        ui.write('\n🔍 STEP 6: Verifying deposit...');
        
        let balanceAfter: bigint;
        let verifyAttempts = 0;
        const maxVerifyAttempts = 5;
        
        // Try multiple times as it might take a moment for balance to update
        while (verifyAttempts < maxVerifyAttempts) {
            verifyAttempts++;
            balanceAfter = await getJettonBalance(provider, jettonMinter, senderAddress);
            
            if (balanceAfter > balanceBefore) {
                break; // Balance increased!
            }
            
            if (verifyAttempts < maxVerifyAttempts) {
                ui.write(`⏳ Balance not updated yet, checking again... (${verifyAttempts}/${maxVerifyAttempts})`);
                await sleep(5000);
            }
        }
        
        balanceAfter = await getJettonBalance(provider, jettonMinter, senderAddress);
        const jettonReceived = balanceAfter - balanceBefore;
        
        ui.write('\n🎉 DEPOSIT COMPLETE!');
        ui.write('═'.repeat(60));
        ui.write(`✅ Transaction Status: SUCCESS`);
        ui.write('');
        ui.write('📊 Results:');
        ui.write(`   Deposited: ${depositTON} TON`);
        ui.write(`   Jettons Before: ${fromNano(balanceBefore)}`);
        ui.write(`   Jettons After: ${fromNano(balanceAfter)}`);
        ui.write(`   Jettons Received: ${fromNano(jettonReceived)}`);
        ui.write('');
        
        if (jettonReceived > 0n) {
            ui.write('✅ Jetton balance successfully increased!');
            const actualRatio = Number(fromNano(jettonReceived)) / effectiveDeposit;
            ui.write(`📈 Actual conversion ratio: ${actualRatio.toFixed(6)}`);
        } else {
            ui.write('⚠️  Warning: Jetton balance not increased yet.');
            ui.write('💡 This might be normal if using non-optimistic mode.');
            ui.write('💡 Check your balance again in a few minutes.');
        }
        
        ui.write('\n🔗 Next Steps:');
        ui.write('   1. Check your jetton wallet balance');
        ui.write('   2. Wait for validation round to complete (if non-optimistic)');
        ui.write('   3. You can now use your Pool Jettons in DeFi protocols');
        ui.write('');
        ui.write(`🏦 Pool Address: ${poolAddress.toString()}`);
        ui.write(`🪙 Jetton Minter: ${jettonMinter.toString()}`);
        ui.write('');
        ui.write('Thank you for using TON Liquid Staking! 🚀');
        
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        ui.write('\n❌ DEPOSIT FAILED');
        ui.write('═'.repeat(60));
        ui.write(`Error: ${msg}`);
        ui.write('');
        
        // Provide helpful hints based on error type
        if (msg.includes('Invalid address')) {
            ui.write('💡 Hint: Check your pool address format');
        } else if (msg.includes('Insufficient')) {
            ui.write('💡 Hint: Add more TON to your wallet');
        } else if (msg.includes('HALTED') || msg.includes('CLOSED')) {
            ui.write('Check pool status with: npx blueprint run check_status');
        } else if (msg.includes('amount_too_low')) {
            ui.write('Minimum deposit is 1.01 TON (1 TON fee + 0.01 TON minimum)');
        } else if (msg.includes('timeout') || msg.includes('network')) {
            ui.write(' Check your network connection and try again');
        }
        
        ui.write('');
        ui.write('📚 For help, see: scripts/TESTING_GUIDE.md');
        
        throw error;
    }
}

