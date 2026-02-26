import { Address, toNano } from '@ton/core';
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

async function getPoolGovernorAndMinter(
    provider: NetworkProvider,
    poolAddress: Address
): Promise<{ governor: Address; poolJettonMinter: Address }> {
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

    const poolJettonMinter = stack.readAddress();
    stack.readBigNumber(); // poolJettonSupply
    stack.readAddressOpt(); // depositPayout
    stack.readBigNumber(); // requested_for_deposit
    stack.readAddressOpt(); // withdrawalPayout
    stack.readBigNumber(); // requested_for_withdrawal
    stack.readAddress(); // sudoer
    stack.readNumber(); // sudoer_set_at
    const governor = stack.readAddress();

    return { governor, poolJettonMinter };
}

export async function run(provider: NetworkProvider) {
    const ui = provider.ui();
    const sender = provider.sender();
    if (!sender.address) {
        throw new Error('Sender address is not available');
    }

    const poolAddress = Address.parse(await ui.input('Pool address:'));
    const pool = provider.open(Pool.createFromAddress(poolAddress));
    const { governor, poolJettonMinter: minterAddress } = await getPoolGovernorAndMinter(provider, poolAddress);

    if (!sender.address.equals(governor)) {
        throw new Error(
            `Sender ${sender.address.toString()} is not governor ${governor.toString()}. ` +
            'Only governor can call admin unfreeze via pool.'
        );
    }

    const minter = provider.open(DAOJettonMinter.createFromAddress(minterAddress));
    const minterData = await minter.getJettonData();
    if (!minterData.adminAddress.equals(poolAddress)) {
        throw new Error(
            `Minter admin is ${minterData.adminAddress.toString()}, expected pool ${poolAddress.toString()}. ` +
            'Set minter admin to pool first, otherwise pool->minter admin ops are rejected.'
        );
    }

    const ownerInput = (await ui.input('Owner address to unfreeze (leave empty to enter wallet directly):')).trim();
    let walletAddress: Address;
    if (ownerInput) {
        const ownerAddress = Address.parse(ownerInput);
        walletAddress = await minter.getWalletAddress(ownerAddress);
        ui.write(`Computed jetton wallet: ${walletAddress.toString()}`);
    } else {
        walletAddress = Address.parse(await ui.input('Jetton wallet address to unfreeze:'));
    }

    const wallet = provider.open(PoolJettonWallet.createFromAddress(walletAddress));
    const walletData = await wallet.getDaoData();
    if (!walletData.masterAdderss.equals(minterAddress)) {
        throw new Error(
            `Wallet minter mismatch. Wallet belongs to ${walletData.masterAdderss.toString()}, ` +
            `but pool minter is ${minterAddress.toString()}.`
        );
    }

    const value = toNano((await ui.input('TON to attach for fees (default 0.3):')) || '0.3');

    ui.write(`\nSummary:
  Pool:   ${poolAddress}
  Minter: ${minterAddress}
  Minter admin: ${minterData.adminAddress}
  Wallet: ${walletAddress}
  Frozen manually_unfrozen now: ${walletData.manuallyUnfrozen}
  Value:  ${value} nanoTON\n`);

    const confirmed = await ui.prompt('Proceed with admin unfreeze?');
    if (!confirmed) {
        ui.write('Aborted by user.');
        return;
    }

    await pool.sendAdminUnfreezeJettonWallet(sender, {
        value,
        walletAddress,
    });

    ui.write('Admin unfreeze message sent.');
}
