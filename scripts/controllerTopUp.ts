import { Address, fromNano, toNano } from '@ton/core';
import { NetworkProvider } from '@ton/blueprint';
import { Controller } from '../wrappers/Controller';

export async function run(provider: NetworkProvider) {
    const ui = provider.ui();
    const sender = provider.sender();
    if (!sender.address) {
        throw new Error('Sender address is not available');
    }

    const controllerAddress = Address.parse(await ui.input('Controller address:'));
    const amountInput = (await ui.input('TON to top up controller with:')).trim();
    const amount = toNano(amountInput);

    ui.write(`\nSummary:
  Controller: ${controllerAddress}
  Sender:     ${sender.address}
  Amount:     ${fromNano(amount)} TON\n`);

    const confirmed = await ui.prompt('Proceed with controller top up?');
    if (!confirmed) {
        ui.write('Aborted by user.');
        return;
    }

    const controller = provider.open(Controller.createFromAddress(controllerAddress));
    await controller.sendTopUp(sender, amount);
    ui.write('Controller top up message sent.');
}
