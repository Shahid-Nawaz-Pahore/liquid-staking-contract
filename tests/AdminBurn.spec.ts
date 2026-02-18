import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Cell, toNano, beginCell } from '@ton/core';
import { Pool, PoolConfig } from '../wrappers/Pool';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { JettonMinter as DAOJettonMinter, jettonContentToCell } from '../contracts/jetton_dao/wrappers/JettonMinter';
import { JettonWallet } from '../contracts/jetton_dao/wrappers/JettonWallet';
import { Dictionary } from '@ton/core';

describe('Admin Burn Jettons', () => {
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
        await pool.sendDeposit(userA.getSender(), toNano('100'));
        await pool.sendDeposit(userB.getSender(), toNano('50'));
    });

    it('should allow governor to burn user jettons and reduce pool supply', async () => {
        const burnAmount = toNano('10');
        const userAWalletAddress = await poolJetton.getWalletAddress(userA.address);
        const userAWallet = blockchain.openContract(JettonWallet.createFromAddress(userAWalletAddress));

        const userAJettonsBefore = await userAWallet.getJettonBalance();
        const userATonBefore = await userA.getBalance();
        const poolDataBefore = await pool.getFullData();

        const result = await pool.sendAdminBurnJettons(governor.getSender(), {
            value: toNano('1.2'),
            fromWallet: userAWalletAddress,
            jettonAmount: burnAmount,
            waitTillRoundEnd: false,
            fillOrKill: false,
        });

        expect(result.transactions).toHaveTransaction({
            from: governor.address,
            to: pool.address,
            success: true,
        });

        const userAJettonsAfter = await userAWallet.getJettonBalance();
        const userATonAfter = await userA.getBalance();
        const poolDataAfter = await pool.getFullData();

        expect(userAJettonsAfter).toEqual(userAJettonsBefore - burnAmount);
        expect(poolDataAfter.supply).toEqual(poolDataBefore.supply - burnAmount);
        expect(poolDataAfter.totalBalance < poolDataBefore.totalBalance).toBe(true);
        expect(userATonAfter > userATonBefore).toBe(true);
    });

    it('should reject admin burn from non-governor', async () => {
        const userAWalletAddress = await poolJetton.getWalletAddress(userA.address);
        const poolDataBefore = await pool.getFullData();

        const result = await pool.sendAdminBurnJettons(userA.getSender(), {
            value: toNano('1.2'),
            fromWallet: userAWalletAddress,
            jettonAmount: toNano('5'),
            waitTillRoundEnd: false,
            fillOrKill: false,
        });

        expect(result.transactions).toHaveTransaction({
            from: userA.address,
            to: pool.address,
            success: false,
        });

        const poolDataAfter = await pool.getFullData();
        expect(poolDataAfter.supply).toEqual(poolDataBefore.supply);
    });

    it('should fail if from_wallet has insufficient jettons', async () => {
        const userAWalletAddress = await poolJetton.getWalletAddress(userA.address);
        const userAWallet = blockchain.openContract(JettonWallet.createFromAddress(userAWalletAddress));
        const userABalance = await userAWallet.getJettonBalance();

        const result = await pool.sendAdminBurnJettons(governor.getSender(), {
            value: toNano('1.2'),
            fromWallet: userAWalletAddress,
            jettonAmount: userABalance + toNano('1'),
            waitTillRoundEnd: false,
            fillOrKill: false,
        });

        expect(result.transactions).toHaveTransaction({
            to: userAWalletAddress,
            success: false,
        });
    });
});
