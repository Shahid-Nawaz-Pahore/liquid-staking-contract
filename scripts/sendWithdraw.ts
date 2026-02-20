import { Address, fromNano, toNano } from '@ton/core';
import { NetworkProvider } from '@ton/blueprint';
import { JettonMinter as DAOJettonMinter } from '../contracts/jetton_dao/wrappers/JettonMinter';
import { JettonWallet as PoolJettonWallet } from '../wrappers/JettonWallet';

async function getPoolJettonMinterAddress(provider: NetworkProvider, poolAddress: Address): Promise<Address> {
    const contractProvider = provider.provider(poolAddress);
    const { stack } = await contractProvider.get('get_pool_full_data', []);
    const newContractVersion = stack.remaining === 34;

    stack.readNumber(); // state
    stack.readBoolean(); // halted
    stack.readBigNumber(); // total_balance
    stack.readNumber(); // interest_rate
    stack.readBoolean(); // optimistic_deposit_withdrawals
    stack.readBoolean(); // deposits_open
    if (newContractVersion) {
        stack.readNumber(); // instant_withdrawal_fee
    }
    stack.readBigNumber(); // saved_validator_set_hash
    stack.readTuple(); // prev_round_borrowers
    stack.readTuple(); // current_round_borrowers
    stack.readBigNumber(); // min_loan
    stack.readBigNumber(); // max_loan
    stack.readNumber(); // governance_fee_share
    if (newContractVersion) {
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
    const ownerInput = (await ui.input(`Owner address (default ${sender.address.toString()}):`)).trim();
    const ownerAddress = ownerInput ? Address.parse(ownerInput) : sender.address;

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
    const fillOrKill = immediate;

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
