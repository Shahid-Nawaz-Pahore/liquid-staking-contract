import { Address, fromNano, toNano } from '@ton/core';
import { NetworkProvider } from '@ton/blueprint';
import { Pool } from '../wrappers/Pool';
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
    const ownerAddress = Address.parse(await ui.input('Owner wallet address to burn from:'));
    const poolJettonMinterAddress = await getPoolJettonMinterAddress(provider, poolAddress);
    const poolJettonMinter = provider.open(DAOJettonMinter.createFromAddress(poolJettonMinterAddress));
    const fromWallet = await poolJettonMinter.getWalletAddress(ownerAddress);
    const wallet = provider.open(PoolJettonWallet.createFromAddress(fromWallet));
    const walletData = await wallet.getDaoData();

    if (!walletData.masterAdderss.equals(poolJettonMinterAddress)) {
        throw new Error(
            `Wallet minter mismatch. Wallet belongs to ${walletData.masterAdderss.toString()}, ` +
            `but pool minter is ${poolJettonMinterAddress.toString()}.`
        );
    }

    const availableJettons = walletData.balance;
    const totalJettons = walletData.balance + walletData.locked;
    ui.write(`Computed owner jetton wallet: ${fromWallet.toString()}`);
    ui.write(`Available jettons: ${fromNano(availableJettons)}`);
    ui.write(`Locked jettons: ${fromNano(walletData.locked)}`);

    if (availableJettons <= 0n) {
        ui.write('No available jettons to burn from this wallet.');
        return;
    }

    const amountInput = (await ui.input(`Jetton amount to burn (default ${fromNano(availableJettons)}):`)).trim();
    const jettonAmount = amountInput === '' ? availableJettons : toNano(amountInput);
    if (jettonAmount <= 0n) {
        throw new Error('Burn amount must be positive');
    }
    if (jettonAmount > availableJettons) {
        throw new Error('Burn amount exceeds available jetton balance');
    }

    const immediateInput = (await ui.input('Immediate withdraw payout if possible? (Y/n):')).trim().toLowerCase();
    const immediate = immediateInput !== 'n';
    const waitTillRoundEnd = !immediate;
    const fillOrKill = immediate;

    const value = toNano((await ui.input('TON to attach for burn tx (default 1.2):')).trim() || '1.2');

    ui.write(`\nSummary:
  Pool:      ${poolAddress}
  Minter:    ${poolJettonMinterAddress}
  Owner:     ${ownerAddress}
  From wal:  ${fromWallet}
  Available: ${fromNano(availableJettons)} jettons
  Total:     ${fromNano(totalJettons)} jettons
  Amount:    ${fromNano(jettonAmount)} jettons
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
