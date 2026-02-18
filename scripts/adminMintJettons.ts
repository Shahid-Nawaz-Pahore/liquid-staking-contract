import { Address, toNano } from '@ton/core';
import { NetworkProvider } from '@ton/blueprint';
import { Pool } from '../wrappers/Pool';

export async function run(provider: NetworkProvider) {
    const ui = provider.ui();
    const sender = provider.sender();

    const poolAddress = Address.parse(await ui.input('Pool address:'));
    const toAddress = Address.parse(await ui.input('Recipient address:'));
    const jettonAmount = toNano(await ui.input('Jetton amount to mint (e.g. 10.5):'));
    const value = toNano((await ui.input('TON to attach for fees (default 0.5):')) || '0.5');

    ui.write(`\nSummary:
  Pool:    ${poolAddress}
  To:      ${toAddress}
  Amount:  ${jettonAmount}
  Value:   ${value} nanoTON\n`);

    const confirmed = await ui.prompt('Proceed with admin mint?');
    if (!confirmed) {
        ui.write('Aborted by user.');
        return;
    }

    const pool = provider.open(Pool.createFromAddress(poolAddress));
    await pool.sendAdminMintJettons(sender, {
        value,
        toAddress,
        jettonAmount,
    });

    ui.write('Admin mint message sent.');
}
