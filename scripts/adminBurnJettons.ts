import { Address, toNano } from '@ton/core';
import { NetworkProvider } from '@ton/blueprint';
import { Pool } from '../wrappers/Pool';

export async function run(provider: NetworkProvider) {
    const ui = provider.ui();
    const sender = provider.sender();

    const poolAddress = Address.parse(await ui.input('Pool address:'));
    const fromWallet = Address.parse(await ui.input('From jetton wallet address:'));
    const jettonAmount = toNano(await ui.input('Jetton amount to burn (e.g. 10.5):'));
    const value = toNano((await ui.input('TON to attach for burn flow fees (default 1.2):')) || '1.2');
    const waitTillRoundEnd = (await ui.input('Wait till round end? (y/N):')).trim().toLowerCase() === 'y';
    const fillOrKill = (await ui.input('Fill-or-kill if immediate payout is unavailable? (y/N):')).trim().toLowerCase() === 'y';

    ui.write(`\nSummary:
  Pool:      ${poolAddress}
  From wal:  ${fromWallet}
  Amount:    ${jettonAmount}
  Value:     ${value} nanoTON
  Wait end:  ${waitTillRoundEnd}
  Fill/Kill: ${fillOrKill}\n`);

    const confirmed = await ui.prompt('Proceed with admin burn?');
    if (!confirmed) {
        ui.write('Aborted by user.');
        return;
    }

    const pool = provider.open(Pool.createFromAddress(poolAddress));
    await pool.sendAdminBurnJettons(sender, {
        value,
        fromWallet,
        jettonAmount,
        waitTillRoundEnd,
        fillOrKill,
    });

    ui.write('Admin burn message sent.');
}
