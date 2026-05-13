
import { fromNano, toNano, Address } from '@ton/core';
import { NetworkProvider } from '@ton/blueprint';
import { Controller } from '../wrappers/Controller';
import { getPoolState } from './scriptHelpers';

function parseUint(raw: string, field: string): number {
    const value = raw.trim();
    if (!/^\d+$/.test(value)) {
        throw new Error(`${field} must be a non-negative integer`);
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) {
        throw new Error(`${field} is too large`);
    }
    return parsed;
}

function formatUnixUtc(timestamp: number): string {
    return new Date(timestamp * 1000).toISOString().replace('.000Z', 'Z');
}

export async function run(provider: NetworkProvider) {
    const ui = provider.ui();
    const sender = provider.sender();
    if (!sender.address) {
        throw new Error('Sender address is not available');
    }

    const controllerAddress = Address.parse(await ui.input('Controller address:'));
    const controller = provider.open(Controller.createFromAddress(controllerAddress));
    const controllerData = await controller.getControllerData();
    const poolData = await getPoolState(provider, controllerData.pool);

    ui.write(`Controller validator: ${controllerData.validator?.toString()}`);
    ui.write(`Controller approved: ${controllerData.approved}`);
    ui.write(`Pool: ${controllerData.pool.toString()}`);
    ui.write(`Pool interestRate (24-bit): ${poolData.interestRate}`);
    ui.write(`Pool minLoan: ${fromNano(poolData.minLoan)} TON`);
    ui.write(`Pool maxLoan: ${fromNano(poolData.maxLoan)} TON`);

    if (controllerData.borrowedAmount > 0n) {
        ui.write(`Controller already has an active loan: ${fromNano(controllerData.borrowedAmount)} TON`);
        ui.write('Repay or close the current loan before sending another request_loan.');
        return;
    }

    const minLoanInput = (await ui.input(`Min loan TON (default ${fromNano(poolData.minLoan)}):`)).trim();
    const maxLoanInput = (await ui.input(`Max loan TON (default ${fromNano(poolData.maxLoan)}):`)).trim();
    const interestInput = (await ui.input(`Max interest (24-bit, default ${poolData.interestRate}):`)).trim();
    const profitShareInput = (await ui.input('Acceptable profit share (0-16777215, default 0):')).trim();
    const valueInput = (await ui.input('TON to attach for request (default 1):')).trim();

    const minLoan = toNano(minLoanInput || fromNano(poolData.minLoan));
    const maxLoan = toNano(maxLoanInput || fromNano(poolData.maxLoan));
    const maxInterest = parseUint(interestInput || String(poolData.interestRate), 'Max interest');
    const acceptableProfitShare = parseUint(profitShareInput || '0', 'Acceptable profit share');
    const value = toNano(valueInput || '1');
    const controllerBalance = (await provider.provider(controllerAddress).getState()).balance;
    const requiredBalance = await controller.getBalanceForLoan(maxLoan, maxInterest);
    const requestWindow = await controller.getRequestWindow().catch(() => null);
    const now = Math.floor(Date.now() / 1000);

    ui.write(`\nSummary:
  Controller: ${controllerAddress}
  Sender:     ${sender.address}
  Min loan:   ${fromNano(minLoan)} TON
  Max loan:   ${fromNano(maxLoan)} TON
  Interest:   ${maxInterest}
  Profit sh:  ${acceptableProfitShare}
  Value:      ${fromNano(value)} TON
  C balance:  ${fromNano(controllerBalance)} TON
  Required:   ${fromNano(requiredBalance)} TON\n`);

    if (requestWindow) {
        ui.write(`Window:     ${formatUnixUtc(requestWindow.since)} -> ${formatUnixUtc(requestWindow.until)} UTC`);
        ui.write(`Now:        ${formatUnixUtc(now)} UTC`);
        if (now < requestWindow.since) {
            ui.write('Controller request window has not opened yet.');
            return;
        }
        if (now > requestWindow.until) {
            ui.write('Controller request window is already closed.');
            return;
        }
    }

    if (controllerBalance < requiredBalance) {
        ui.write('Controller balance is too low for this loan request. Lower max loan or top up the controller first.');
        return;
    }

    const confirmed = await ui.prompt('Proceed with request_loan?');
    if (!confirmed) {
        ui.write('Aborted by user.');
        return;
    }

    await controller.sendRequestLoan(
        sender,
        minLoan,
        maxLoan,
        maxInterest,
        acceptableProfitShare,
        value,
    );
    ui.write('request_loan message sent.');
}
