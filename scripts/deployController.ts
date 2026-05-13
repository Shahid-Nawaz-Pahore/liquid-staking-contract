import { Address, fromNano, toNano } from '@ton/core';
import { NetworkProvider } from '@ton/blueprint';
import { Pool } from '../wrappers/Pool';
import { Controller } from '../wrappers/Controller';
import { Conf } from '../PoolConstants';

function parseControllerId(raw: string): number {
    const value = raw.trim();
    if (!/^\d+$/.test(value)) {
        throw new Error('Controller id must be a non-negative integer');
    }
    return Number(value);
}

export async function run(provider: NetworkProvider) {
    const ui = provider.ui();
    const sender = provider.sender();
    if (!sender.address) {
        throw new Error('Sender address is not available');
    }

    const poolAddress = Address.parse(await ui.input('Pool address:'));
    const validatorInput = (await ui.input(`Validator address (default ${sender.address.toString()}):`)).trim();
    const validatorAddress = validatorInput ? Address.parse(validatorInput) : sender.address;

    const controllerId = parseControllerId(await ui.input('Controller id (e.g. 0):'));

    const defaultDeployValue =
        Conf.minStoragePool + Conf.hashUpdateFine + 3n * Conf.stakeRecoverFine + toNano('1');
    const deployValueInput = (await ui.input(
        `TON to attach for deploy_controller (default ${fromNano(defaultDeployValue)}):`,
    )).trim();
    const deployValue = toNano(deployValueInput || fromNano(defaultDeployValue));

    ui.write(`\nSummary:
  Pool:       ${poolAddress.toString()}
  Validator:  ${validatorAddress.toString()}
  Controller: ${controllerId}
  Value:      ${fromNano(deployValue)} TON\n`);

    const confirmed = await ui.prompt('Proceed with controller deploy request?');
    if (!confirmed) {
        ui.write('Aborted by user.');
        return;
    }

    const pool = provider.open(Pool.createFromAddress(poolAddress));
    await pool.sendRequestControllerDeploy(sender, deployValue, controllerId);
    ui.write('Deploy request sent to pool.');

    const controllerAddress = await pool.getControllerAddress(controllerId, validatorAddress);
    ui.write(`Computed controller address: ${controllerAddress.toString()}`);

    const waitForDeploy = await ui.prompt('Wait for controller deployment confirmation?');
    if (waitForDeploy) {
        await provider.waitForDeploy(controllerAddress);
        ui.write('Controller is deployed.');
    }

    const sendApprove = await ui.prompt('Send approve=true from current wallet now?');
    if (!sendApprove) {
        return;
    }

    const approveValueInput = (await ui.input('TON to attach for approve tx (default 0.2):')).trim();
    const approveValue = toNano(approveValueInput || '0.2');
    const controller = provider.open(Controller.createFromAddress(controllerAddress));
    await controller.sendApprove(sender, true, approveValue);
    ui.write('Approve message sent.');
}
