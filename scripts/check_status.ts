import { Address } from 'ton-core';
import { NetworkProvider } from '@ton-community/blueprint';
import { Pool } from '../wrappers/Pool';

export async function run(provider: NetworkProvider) {
  const ui = provider.ui();
  
  ui.write('\n🔍 CHECK POOL STATUS');
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
    
    ui.write('⏳ Fetching data...\n');
    
    const pool = provider.open(Pool.createFromAddress(poolAddress));
    const data = await (pool as any).getFullData(provider);
    
    if (data.halted) {
      ui.write('🔴 Pool is PAUSED not accepting deposits and withdrawals');
    } else if (data.depositsOpen) {
      ui.write('🟢 Pool is RUNNING accepting deposits and withdrawals');
    } else {
      ui.write('🟡 Pool is RUNNING but deposits are CLOSED');
    }
    
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    ui.write(`❌ Status check failed: ${msg}`);
    
    if (msg.includes('Invalid address')) {
      ui.write('💡 Hint: Check your pool address format');
    } else if (msg.includes('not found') || msg.includes('not deployed')) {
      ui.write('💡 Hint: Pool contract may not be deployed at this address');
    }
  }
}


