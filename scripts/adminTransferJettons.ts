import { Address, toNano } from '@ton/core';
import { NetworkProvider } from '@ton/blueprint';
import { Pool } from '../wrappers/Pool';

export async function run(provider: NetworkProvider) {
    const ui = provider.ui();
    const sender = provider.sender();

    const poolAddress = Address.parse(await ui.input('Pool address:'));
    const fromWallet = Address.parse(await ui.input('From jetton wallet address:'));
    const toAddress = Address.parse(await ui.input('To address:'));
    const jettonAmount = toNano(await ui.input('Jetton amount (e.g. 10.5):'));

    // Optional params with sane defaults
    const value = toNano((await ui.input('TON to attach for fees (default 0.3):')) || '0.3');
    const forwardTonAmount = toNano((await ui.input('Forward TON amount to send with transfer (default 0):')) || '0');
    const responseAddressInput = await ui.input('Response address (default = sender):');
    const responseAddress = responseAddressInput ? Address.parse(responseAddressInput) : sender.address!;

    ui.write(`\nSummary:
  Pool:      ${poolAddress}
  From wal:  ${fromWallet}
  To:        ${toAddress}
  Amount:    ${jettonAmount}
  Value:     ${value} nanoTON
  Fwd TON:   ${forwardTonAmount}
  Response:  ${responseAddress}\n`);

    const confirmed = await ui.prompt('Proceed with admin transfer?');
    if (!confirmed) {
        ui.write('Aborted by user.');
        return;
    }

    const pool = provider.open(Pool.createFromAddress(poolAddress));

    await pool.sendAdminTransferJettons(sender, {
        value,
        fromWallet,
        toAddress,
        jettonAmount,
        responseAddress,
        forwardTonAmount,
    });

    ui.write('Admin transfer message sent.');
}
