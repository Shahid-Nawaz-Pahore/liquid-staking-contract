import { Address, toNano } from 'ton-core';
import { NetworkProvider } from '@ton-community/blueprint';
import { Pool } from '../wrappers/Pool';

export async function run(provider: NetworkProvider) {
  const ui = provider.ui();
  
  ui.write('\n🟢 UNPAUSE POOL');
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
    const envValue = process.env.UNHALT_VALUE;
    const valueStr = cliValue || envValue || '0.05';
    const value = toNano(valueStr);
    
    ui.write(`🟢 Unpausing pool ${poolAddress.toString()}...`);
    ui.write(`💰 Sending ${value} TON with unhalt message`);

    const pool = provider.open(Pool.createFromAddress(poolAddress));

    // Check current status before attempting unhalt
    try {
      const currentData = await (pool as any).getFullData(provider);
      if (!currentData.halted) {
        ui.write('⚠️  Pool is already running (not halted)!');
        return;
      }
      ui.write(`📊 Current state: ${currentData.state === 0 ? 'NORMAL' : 'REPAYMENT_ONLY'} (halted)`);
    } catch (e) {
      ui.write('⚠️  Could not fetch current pool status, proceeding...');
    }

    // Send OP_UNHALT. Requires the sender to be governor
    ui.write('📤 Sending unhalt message...');
    await pool.sendUnhalt(provider.sender(), value);
    
   

  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    ui.write(`❌ Failed to unpause pool: ${msg}`);
    
    // Provide helpful error context
    if (msg.includes('assert_sender')) {
      ui.write('💡 Hint: Make sure you are using the governor wallet');
    } else if (msg.includes('Invalid address')) {
      ui.write('💡 Hint: Check your pool address format');
    }
  }
}


