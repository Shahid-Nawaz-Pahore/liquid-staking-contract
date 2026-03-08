import { Address, fromNano, toNano } from '@ton/core';
import { NetworkProvider } from '@ton/blueprint';
import { JettonMinter as DAOJettonMinter } from '../contracts/jetton_dao/wrappers/JettonMinter';
import { JettonWallet as PoolJettonWallet } from '../wrappers/JettonWallet';

async function getPoolFullDataStack(provider: NetworkProvider, poolAddress: Address) {
    const contractProvider = provider.provider(poolAddress);
    try {
        const { stack } = await contractProvider.get('get_pool_full_data_raw', []);
        return stack;
    } catch (rawErr) {
        try {
            const { stack } = await contractProvider.get('get_pool_full_data', []);
            return stack;
        } catch (fullErr) {
            const rawMsg = rawErr instanceof Error ? rawErr.message : String(rawErr);
            const fullMsg = fullErr instanceof Error ? fullErr.message : String(fullErr);
            throw new Error(
                `Failed to read pool data using get_pool_full_data_raw (${rawMsg}) and ` +
                `get_pool_full_data (${fullMsg}). Check pool address and network.`
            );
        }
    }
}

async function getPoolJettonMinterAddress(provider: NetworkProvider, poolAddress: Address): Promise<Address> {
    const stack = await getPoolFullDataStack(provider, poolAddress);
    const stackItems = stack.remaining;
    if (stackItems < 30) {
        throw new Error(`Unexpected get_pool_full_data stack layout: ${stackItems} items`);
    }
    const hasExtendedFields = stackItems >= 34;
    if (!hasExtendedFields && stackItems !== 30) {
        throw new Error(`Unsupported get_pool_full_data stack layout: ${stackItems} items`);
    }

    stack.readNumber(); // state
    stack.readBoolean(); // halted
    stack.readBigNumber(); // total_balance
    stack.readNumber(); // interest_rate
    stack.readBoolean(); // optimistic_deposit_withdrawals
    stack.readBoolean(); // deposits_open
    if (hasExtendedFields) {
        stack.readNumber(); // instant_withdrawal_fee
    }
    stack.readBigNumber(); // saved_validator_set_hash
    stack.readTuple(); // prev_round_borrowers
    stack.readTuple(); // current_round_borrowers
    stack.readBigNumber(); // min_loan
    stack.readBigNumber(); // max_loan
    stack.readNumber(); // governance_fee_share
    if (hasExtendedFields) {
        stack.readBigNumber(); // accrued_governance_fee
        stack.readNumber(); // disbalance_tolerance
        stack.readNumber(); // credit_start_prior_elections_end
    }

    return stack.readAddress(); // jetton_minter
}

export async function run(provider: NetworkProvider) {
    const ui = provider.ui();
    const sender = provider.sender();

    if (!sender.address) {
        throw new Error('Sender address is not available');
    }

    const poolAddress = Address.parse(await ui.input('Pool address:'));
    const ownerInput = (await ui.input(`Owner address (must match sender, default ${sender.address.toString()}):`)).trim();
    const ownerAddress = ownerInput ? Address.parse(ownerInput) : sender.address;
    if (!ownerAddress.equals(sender.address)) {
        throw new Error(
            `Sender ${sender.address.toString()} does not match owner ${ownerAddress.toString()}. ` +
            'Jetton burn must be sent by the wallet owner.'
        );
    }

    const poolJettonMinterAddress = await getPoolJettonMinterAddress(provider, poolAddress);
    const poolJettonMinter = provider.open(DAOJettonMinter.createFromAddress(poolJettonMinterAddress));
    const jettonWalletAddress = await poolJettonMinter.getWalletAddress(ownerAddress);
    const jettonWallet = provider.open(PoolJettonWallet.createFromAddress(jettonWalletAddress));

    const availableStake = await jettonWallet.getJettonBalance();
    const totalStake = await jettonWallet.getTotalBalance();
    const lockedStake = totalStake - availableStake;

    ui.write(`Pool jetton minter: ${poolJettonMinterAddress.toString()}`);
    ui.write(`Owner jetton wallet: ${jettonWalletAddress.toString()}`);
    ui.write(`Available stake: ${fromNano(availableStake)} jettons`);
    ui.write(`Locked stake: ${fromNano(lockedStake)} jettons`);

    if (availableStake <= 0n) {
        ui.write('No available stake to withdraw.');
        return;
    }

    const defaultAmount = fromNano(availableStake);
    const amountInput = (await ui.input(`Jetton amount to withdraw (default ${defaultAmount}):`)).trim();
    const jettonAmount = amountInput === '' ? availableStake : toNano(amountInput);
    if (jettonAmount <= 0n) {
        throw new Error('Withdraw amount must be positive');
    }
    if (jettonAmount > availableStake) {
        throw new Error('Withdraw amount exceeds available stake');
    }

    const immediateInput = (await ui.input('Immediate withdraw? (Y/n):')).trim().toLowerCase();
    const immediate = immediateInput !== 'n';
    const waitTillRoundEnd = !immediate;
    let fillOrKill = false;
    if (immediate) {
        const fallbackInput = (await ui.input('If immediate is unavailable, fallback to round-end withdraw? (Y/n):')).trim().toLowerCase();
        const fallbackToRoundEnd = fallbackInput !== 'n';
        fillOrKill = !fallbackToRoundEnd;
    }

    const responseInput = (await ui.input(`Response address (default ${ownerAddress.toString()}):`)).trim();
    const responseAddress = responseInput ? Address.parse(responseInput) : ownerAddress;

    const valueInput = (await ui.input('TON to attach for burn tx (default 1):')).trim();
    const value = toNano(valueInput || '1');

    ui.write(`\nSummary:
  Pool:        ${poolAddress}
  Owner:       ${ownerAddress}
  Wallet:      ${jettonWalletAddress}
  Amount:      ${fromNano(jettonAmount)} jettons
  Value:       ${value} nanoTON
  Wait end:    ${waitTillRoundEnd}
  Fill/Kill:   ${fillOrKill}
  Response:    ${responseAddress}\n`);

    const confirmed = await ui.prompt('Proceed with withdraw?');
    if (!confirmed) {
        ui.write('Aborted by user.');
        return;
    }

    await jettonWallet.sendBurnWithParams(
        sender,
        value,
        jettonAmount,
        responseAddress,
        waitTillRoundEnd,
        fillOrKill,
    );

    ui.write('Withdraw (burn) message sent.');
}
