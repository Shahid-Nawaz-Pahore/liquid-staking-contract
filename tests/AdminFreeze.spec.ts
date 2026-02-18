import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Cell, toNano, beginCell } from '@ton/core';
import { Pool, PoolConfig } from '../wrappers/Pool';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { JettonMinter as DAOJettonMinter, jettonContentToCell } from '../contracts/jetton_dao/wrappers/JettonMinter';
import { JettonWallet } from '../contracts/jetton_dao/wrappers/JettonWallet';
import { Dictionary } from '@ton/core';

describe('Admin Freeze/Unfreeze Jetton Wallet', () => {
    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let governor: SandboxContract<TreasuryContract>;
    let userA: SandboxContract<TreasuryContract>;
    let userB: SandboxContract<TreasuryContract>;
    let pool: SandboxContract<Pool>;
    let poolJetton: SandboxContract<DAOJettonMinter>;

    let controller_code: Cell;
    let dao_minter_code: Cell;
    let dao_wallet_code: Cell;
    let pool_code: Cell;
    let payout_code: Cell;
    let dao_vote_keeper_code: Cell;
    let dao_voting_code: Cell;

    const DAY = 86400;
    const freezePeriod14d = 14 * DAY;
    const freezePeriod30d = 30 * DAY;

    beforeAll(async () => {
        blockchain = await Blockchain.create();
        deployer = await blockchain.treasury('deployer');
        governor = await blockchain.treasury('governor');
        userA = await blockchain.treasury('userA');
        userB = await blockchain.treasury('userB');

        controller_code = await compile('Controller');
        dao_minter_code = await compile('DAOJettonMinter');
        const dao_wallet_code_raw = await compile('DAOJettonWallet');
        pool_code = await compile('Pool');
        payout_code = await compile('PayoutMinter');
        dao_vote_keeper_code = await compile('DAOVoteKeeper');
        dao_voting_code = await compile('DAOVoting');

        const libs = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());
        libs.set(BigInt(`0x${dao_wallet_code_raw.hash().toString('hex')}`), dao_wallet_code_raw);
        blockchain.libs = beginCell().storeDictDirect(libs).endCell();
        const libPrep = beginCell().storeUint(2, 8).storeBuffer(dao_wallet_code_raw.hash()).endCell();
        dao_wallet_code = new Cell({ exotic: true, bits: libPrep.bits, refs: libPrep.refs });
    });

    beforeEach(async () => {
        const content = jettonContentToCell({ type: 1, uri: 'https://example.com/1.json' });
        poolJetton = blockchain.openContract(DAOJettonMinter.createFromConfig({
            admin: deployer.address,
            content,
            voting_code: dao_voting_code,
        }, dao_minter_code));
        await poolJetton.sendDeploy(deployer.getSender(), toNano('1'));

        const poolConfig: PoolConfig = {
            pool_jetton: poolJetton.address,
            pool_jetton_supply: 0n,
            optimistic_deposit_withdrawals: -1n,
            sudoer: deployer.address,
            governor: governor.address,
            interest_manager: deployer.address,
            halter: deployer.address,
            approver: deployer.address,
            controller_code,
            pool_jetton_wallet_code: dao_wallet_code,
            payout_minter_code: payout_code,
            vote_keeper_code: dao_vote_keeper_code,
        };

        pool = blockchain.openContract(Pool.createFromConfig(poolConfig, pool_code));
        await pool.sendDeploy(deployer.getSender(), toNano('10'));

        await poolJetton.sendChangeAdmin(deployer.getSender(), pool.address);
        await pool.sendSetDepositSettings(governor.getSender(), toNano('1'), true, true, 0);
    });

    it('should auto-freeze after period and allow manual unfreeze', async () => {
        await pool.sendSetWalletFreezePeriod(governor.getSender(), {
            value: toNano('0.3'),
            freezePeriod: freezePeriod14d,
        });

        await pool.sendDeposit(userA.getSender(), toNano('100'));
        await pool.sendDeposit(userB.getSender(), toNano('50'));

        const userAWalletAddress = await poolJetton.getWalletAddress(userA.address);
        const userBWalletAddress = await poolJetton.getWalletAddress(userB.address);
        const userAWallet = blockchain.openContract(JettonWallet.createFromAddress(userAWalletAddress));

        const beforeFreezeTransfer = await userAWallet.sendTransfer(
            userA.getSender(),
            toNano('0.4'),
            toNano('1'),
            userB.address,
            userA.address,
            null,
            0n,
            null
        );
        expect(beforeFreezeTransfer.transactions).toHaveTransaction({
            to: userAWalletAddress,
            success: true,
        });

        blockchain.now = (blockchain.now ?? Math.floor(Date.now() / 1000)) + freezePeriod14d + 1;
        const frozenTransfer = await userAWallet.sendTransfer(
            userA.getSender(),
            toNano('0.4'),
            toNano('1'),
            userB.address,
            userA.address,
            null,
            0n,
            null
        );
        expect(frozenTransfer.transactions).toHaveTransaction({
            to: userAWalletAddress,
            success: false,
        });

        await pool.sendAdminUnfreezeJettonWallet(governor.getSender(), {
            value: toNano('0.3'),
            walletAddress: userAWalletAddress,
        });

        const afterUnfreezeTransfer = await userAWallet.sendTransfer(
            userA.getSender(),
            toNano('0.4'),
            toNano('1'),
            userB.address,
            userA.address,
            null,
            0n,
            null
        );
        expect(afterUnfreezeTransfer.transactions).toHaveTransaction({
            to: userAWalletAddress,
            success: true,
        });
    });

    it('period changes should affect only future timer resets (Model A)', async () => {
        await pool.sendSetWalletFreezePeriod(governor.getSender(), {
            value: toNano('0.3'),
            freezePeriod: freezePeriod14d,
        });
        await pool.sendDeposit(userA.getSender(), toNano('100'));
        await pool.sendDeposit(userB.getSender(), toNano('50'));

        const userAWalletAddress = await poolJetton.getWalletAddress(userA.address);
        const userAWallet = blockchain.openContract(JettonWallet.createFromAddress(userAWalletAddress));

        blockchain.now = (blockchain.now ?? Math.floor(Date.now() / 1000)) + 10 * DAY;
        await pool.sendSetWalletFreezePeriod(governor.getSender(), {
            value: toNano('0.3'),
            freezePeriod: freezePeriod30d,
        });

        expect(await poolJetton.getWalletFreezePeriod()).toEqual(BigInt(freezePeriod30d));

        blockchain.now = (blockchain.now ?? Math.floor(Date.now() / 1000)) + 5 * DAY + 1;
        const oldDeadlineTransfer = await userAWallet.sendTransfer(
            userA.getSender(),
            toNano('0.4'),
            toNano('1'),
            userB.address,
            userA.address,
            null,
            0n,
            null
        );
        expect(oldDeadlineTransfer.transactions).toHaveTransaction({
            to: userAWalletAddress,
            success: false,
        });

        await pool.sendAdminUnfreezeJettonWallet(governor.getSender(), {
            value: toNano('0.3'),
            walletAddress: userAWalletAddress,
        });
        await pool.sendAdminMintJettons(governor.getSender(), {
            value: toNano('0.5'),
            toAddress: userA.address,
            jettonAmount: toNano('1'),
        });

        blockchain.now = (blockchain.now ?? Math.floor(Date.now() / 1000)) + 20 * DAY;
        const transferWithinNewPeriod = await userAWallet.sendTransfer(
            userA.getSender(),
            toNano('0.4'),
            toNano('1'),
            userB.address,
            userA.address,
            null,
            0n,
            null
        );
        expect(transferWithinNewPeriod.transactions).toHaveTransaction({
            to: userAWalletAddress,
            success: true,
        });

        blockchain.now = (blockchain.now ?? Math.floor(Date.now() / 1000)) + 11 * DAY;
        const transferAfterNewPeriod = await userAWallet.sendTransfer(
            userA.getSender(),
            toNano('0.4'),
            toNano('1'),
            userB.address,
            userA.address,
            null,
            0n,
            null
        );
        expect(transferAfterNewPeriod.transactions).toHaveTransaction({
            to: userAWalletAddress,
            success: false,
        });
    });

    it('should reject freeze-period updates from non-governor', async () => {
        const result = await pool.sendSetWalletFreezePeriod(userA.getSender(), {
            value: toNano('0.3'),
            freezePeriod: freezePeriod14d,
        });

        expect(result.transactions).toHaveTransaction({
            from: userA.address,
            to: pool.address,
            success: false,
        });
    });
});
