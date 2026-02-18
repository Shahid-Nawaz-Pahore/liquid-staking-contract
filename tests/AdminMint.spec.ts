import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Cell, toNano, beginCell } from '@ton/core';
import { Pool, PoolConfig } from '../wrappers/Pool';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { JettonMinter as DAOJettonMinter, jettonContentToCell } from '../contracts/jetton_dao/wrappers/JettonMinter';
import { JettonWallet } from '../contracts/jetton_dao/wrappers/JettonWallet';
import { Dictionary } from '@ton/core';

describe('Admin Mint Jettons', () => {
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
    });

    it('should allow governor to mint jettons and dilute conversion ratio', async () => {
        const mintAmount = toNano('10');
        const userBWalletAddress = await poolJetton.getWalletAddress(userB.address);
        const userBWallet = blockchain.openContract(JettonWallet.createFromAddress(userBWalletAddress));

        const walletBalanceBefore = await userBWallet.getJettonBalance();
        const poolDataBefore = await pool.getFullData();
        const totalSupplyBefore = await poolJetton.getTotalSupply();

        const result = await pool.sendAdminMintJettons(governor.getSender(), {
            value: toNano('0.5'),
            toAddress: userB.address,
            jettonAmount: mintAmount,
        });

        expect(result.transactions).toHaveTransaction({
            from: governor.address,
            to: pool.address,
            success: true,
        });

        const walletBalanceAfter = await userBWallet.getJettonBalance();
        const poolDataAfter = await pool.getFullData();
        const totalSupplyAfter = await poolJetton.getTotalSupply();

        expect(walletBalanceAfter).toEqual(walletBalanceBefore + mintAmount);
        expect(poolDataAfter.totalBalance).toEqual(poolDataBefore.totalBalance);
        expect(poolDataAfter.supply).toEqual(poolDataBefore.supply + mintAmount);
        expect(totalSupplyAfter).toEqual(totalSupplyBefore + mintAmount);

        const beforeLeft = poolDataAfter.projectedTotalBalance * poolDataBefore.projectedPoolSupply;
        const afterRight = poolDataBefore.projectedTotalBalance * poolDataAfter.projectedPoolSupply;
        expect(beforeLeft < afterRight).toBe(true);
    });

    it('should reject admin mint from non-governor', async () => {
        const poolDataBefore = await pool.getFullData();

        const result = await pool.sendAdminMintJettons(userA.getSender(), {
            value: toNano('0.5'),
            toAddress: userB.address,
            jettonAmount: toNano('5'),
        });

        expect(result.transactions).toHaveTransaction({
            from: userA.address,
            to: pool.address,
            success: false,
        });

        const poolDataAfter = await pool.getFullData();
        expect(poolDataAfter.supply).toEqual(poolDataBefore.supply);
    });

    it('should reject zero-amount admin mint', async () => {
        const result = await pool.sendAdminMintJettons(governor.getSender(), {
            value: toNano('0.5'),
            toAddress: userB.address,
            jettonAmount: 0n,
        });

        expect(result.transactions).toHaveTransaction({
            from: governor.address,
            to: pool.address,
            success: false,
        });
    });
});
