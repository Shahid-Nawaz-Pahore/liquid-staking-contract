/*
 * TESTNET CHECKLIST
 * Before running: sender owns withdrawal NFTs or has a queued withdrawal in the current pool withdrawal collection
 * After running:  call get_collection_data, get_distribution_data, get_nft_data(each owned item), get_wallet_data(senderWallet), get_pool_full_data
 * Known issues:   current repo uses NFT auto-distribution; there is no explicit user-side claim op, so this script scans and optionally pokes the pool with touch
 */

import { NetworkProvider } from '@ton/blueprint';
import { Address } from '@ton/core';
import {
    confirmPrompt,
    fail,
    formatTon,
    getArgValue,
    getPoolState,
    readSenderOrFail,
    resolvePoolAddress,
    scanOwnedWithdrawalItems,
    waitForTransaction,
} from './scriptHelpers';
import { Pool } from '../wrappers/Pool';
import { JettonMinter as DAOJettonMinter } from '../contracts/jetton_dao/wrappers/JettonMinter';
import { JettonWallet as PoolJettonWallet } from '../wrappers/JettonWallet';

export async function run(provider: NetworkProvider) {
    const sender = await readSenderOrFail(provider);
    const poolAddress = await resolvePoolAddress(provider);
    const pool = provider.open(Pool.createFromAddress(poolAddress));
    const poolState = await getPoolState(provider, poolAddress);

    const collections = new Map<string, string>();
    if (poolState.withdrawalPayout) {
        collections.set(poolState.withdrawalPayout.toString(), poolState.withdrawalPayout.toString());
    }
    const extraCollections = getArgValue('--collections') ?? process.env.WITHDRAWAL_PAYOUT_COLLECTIONS;
    if (extraCollections) {
        for (const value of extraCollections.split(',').map((v) => v.trim()).filter(Boolean)) {
            collections.set(value, value);
        }
    }

    const parsedCollections = [...collections.values()].map((value) => {
        try {
            return Address.parse(value);
        } catch {
            return null;
        }
    }).filter(Boolean) as Address[];

    if (parsedCollections.length === 0) {
        fail('No withdrawal payout collection address available to scan. Use current pool queue or WITHDRAWAL_PAYOUT_COLLECTIONS');
    }

    const ownedItems = await scanOwnedWithdrawalItems(provider, sender.address!, parsedCollections);
    const minter = provider.open(DAOJettonMinter.createFromAddress(poolState.poolJettonMinter));
    const walletAddress = await minter.getWalletAddress(sender.address!);
    const wallet = provider.open(PoolJettonWallet.createFromAddress(walletAddress));
    const beforeBalance = await wallet.getJettonBalance();

    provider.ui().write(`🔎 Found ${ownedItems.length} withdrawal item(s) for ${sender.address!.toString()}`);
    for (const item of ownedItems) {
        provider.ui().write(`🧾 collection=${item.collection.toString()} index=${item.index.toString()} bill=${formatTon(item.billAmount)} active=${item.distributionActive}`);
    }

    if (ownedItems.length === 0) {
        provider.ui().write('ℹ️ No pending withdrawal NFT found for sender.');
        return;
    }

    const matured = ownedItems.filter((item) => item.distributionActive);
    if (matured.length > 0) {
        provider.ui().write('ℹ️ Matured withdrawal NFTs are already in active auto-distribution mode. No explicit user claim message exists in this NFT payout design.');
        const afterPool = await getPoolState(provider, poolAddress);
        const afterBalance = await wallet.getJettonBalance();
        provider.ui().write(`🪙 Remaining KTON balance: ${formatTon(afterBalance)} KTON`);
        provider.ui().write(`🏦 Pool totalBalance:      ${formatTon(afterPool.totalBalance)} TON`);
        return;
    }

    provider.ui().write('ℹ️ Withdrawal items exist but distribution is not active yet.');
    if (!(await confirmPrompt(provider, 'Send pool.touch to help trigger round finalization if the round is mature?'))) {
        provider.ui().write('🛑 Aborted');
        return;
    }

    const ltBefore = (await provider.provider(poolAddress).getState()).last?.lt ?? 0n;
    await pool.sendTouch(sender);
    await waitForTransaction(provider, poolAddress, ltBefore);

    const afterPool = await getPoolState(provider, poolAddress);
    const afterBalance = await wallet.getJettonBalance();
    provider.ui().write('✅ touch sent');
    provider.ui().write(`💸 Claimed TON amount:      auto-distribution only; inspect wallet/account txs`);
    provider.ui().write(`🪙 Remaining KTON balance: ${formatTon(afterBalance)} KTON`);
    provider.ui().write(`🏦 Pool totalBalance:      ${formatTon(afterPool.totalBalance)} TON`);
    provider.ui().write(`📝 KTON delta during run:  ${formatTon(afterBalance - beforeBalance)} KTON`);
}
