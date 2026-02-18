import { Address, toNano } from '@ton/core';
import { NetworkProvider } from '@ton/blueprint';
import { Pool } from '../wrappers/Pool';

export async function run(provider: NetworkProvider) {
    const ui = provider.ui();
    const sender = provider.sender();

    const poolAddress = Address.parse(await ui.input('Pool address:'));
    const walletAddress = Address.parse(await ui.input('Jetton wallet address to unfreeze:'));
    const value = toNano((await ui.input('TON to attach for fees (default 0.3):')) || '0.3');

    ui.write(`\nSummary:
  Pool:   ${poolAddress}
  Wallet: ${walletAddress}
  Value:  ${value} nanoTON\n`);

    const confirmed = await ui.prompt('Proceed with admin unfreeze?');
    if (!confirmed) {
        ui.write('Aborted by user.');
        return;
    }

    const pool = provider.open(Pool.createFromAddress(poolAddress));
    await pool.sendAdminUnfreezeJettonWallet(sender, {
        value,
        walletAddress,
    });

    ui.write('Admin unfreeze message sent.');
}
