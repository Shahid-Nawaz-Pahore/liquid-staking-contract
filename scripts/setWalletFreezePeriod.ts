import { toNano } from '@ton/core';
import { NetworkProvider } from '@ton/blueprint';
import { Pool } from '../wrappers/Pool';
import { Address } from '@ton/core';

export async function run(provider: NetworkProvider) {
    const ui = provider.ui();
    const sender = provider.sender();

    const poolAddress = Address.parse(await ui.input('Pool address:'));
    const freezePeriodDays = Number(await ui.input('Freeze period in days (0 disables new auto-freeze timers):'));
    const value = toNano((await ui.input('TON to attach for fees (default 0.3):')) || '0.3');

    if (!Number.isFinite(freezePeriodDays) || freezePeriodDays < 0) {
        throw new Error('Freeze period must be a non-negative number.');
    }

    const freezePeriod = BigInt(Math.floor(freezePeriodDays * 86400));

    ui.write(`\nSummary:
  Pool:          ${poolAddress}
  Freeze period: ${freezePeriodDays} days (${freezePeriod} sec)
  Value:         ${value} nanoTON\n`);

    const confirmed = await ui.prompt('Proceed with freeze period update?');
    if (!confirmed) {
        ui.write('Aborted by user.');
        return;
    }

    const pool = provider.open(Pool.createFromAddress(poolAddress));
    await pool.sendSetWalletFreezePeriod(sender, {
        value,
        freezePeriod,
    });

    ui.write('Freeze period update message sent.');
}
