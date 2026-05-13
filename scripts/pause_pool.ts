import { Address, toNano } from 'ton-core';
import { NetworkProvider } from '@ton-community/blueprint';
import { Pool } from '../wrappers/Pool';

export async function run(provider: NetworkProvider) {
  const ui = provider.ui();
  
  ui.write('\n🔴 PAUSE POOL');
  ui.write('═'.repeat(60));
  ui.write('\n');
  
  try {
    // Get pool address from CLI arg, env var, or prompt user
    let poolAddress: Address;
    const cliArg = process.argv.find((a) => a.startsWith('--pool='))?.split('=')[1];
    const envAddr = process.env.POOL_ADDRESS;
    
    if (cliArg) {
      poolAddress = Address.parse(cliArg);
      ui.write(`📍 Using pool from CLI arg: ${poolAddress}\n`);
    } else if (envAddr) {
      poolAddress = Address.parse(envAddr);
      ui.write(`📍 Using pool from env var: ${poolAddress}\n`);
    } else {
      const poolAddressStr = await ui.input('Enter Pool address:');
      poolAddress = Address.parse(poolAddressStr);
      ui.write(`📍 Pool: ${poolAddress}\n`);
    }
    
    // Get transaction value
    const cliValue = process.argv.find((a) => a.startsWith('--value='))?.split('=')[1];
    const envValue = process.env.HALT_VALUE;
    const valueStr = cliValue || envValue || '0.05';
    const value = toNano(valueStr);
    
    ui.write(`🔴 Pausing pool ${poolAddress.toString()}...`);
    ui.write(`💰 Sending ${value} TON with halt message`);

    const pool = provider.open(Pool.createFromAddress(poolAddress));

    // Check current status before attempting halt
    try {
      const currentData = await (pool as any).getFullData(provider);
      if (currentData.halted) {
        ui.write('⚠️  Pool is already halted!');
        return;
      }
      ui.write(`📊 Current state: ${currentData.state === 0 ? 'NORMAL' : 'REPAYMENT_ONLY'}`);
    } catch (e) {
      ui.write('⚠️  Could not fetch current pool status, proceeding...');
    }

    // Send OP_HALT. Requires the sender to be halter
    ui.write('📤 Sending halt message...');
    await pool.sendHaltMessage(provider.sender(), value);
    
    ui.write('⏳ Transaction sent, awaiting confirmation...');
    

  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    ui.write(`❌ Failed to pause pool: ${msg}`);
    
    // Provide helpful error context
    if (msg.includes('assert_sender')) {
      ui.write('💡 Hint: Make sure you are using the halter wallet');
    } else if (msg.includes('Invalid address')) {
      ui.write('💡 Hint: Check your pool address format');
    }
  }
}


