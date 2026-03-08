import { Blockchain, SandboxContract, TreasuryContract, printTransactionFees } from '@ton/sandbox';
import { Cell, toNano, beginCell, Address } from '@ton/core';
import { Pool, PoolConfig, poolConfigToCell } from '../wrappers/Pool';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { JettonMinter as DAOJettonMinter, jettonContentToCell } from '../contracts/jetton_dao/wrappers/JettonMinter';
import { JettonWallet } from '../wrappers/JettonWallet';
import { Op, Conf } from '../PoolConstants';
import { Dictionary } from '@ton/core';

describe('Admin Transfer Jettons', () => {
    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let governor: SandboxContract<TreasuryContract>;
    let userA: SandboxContract<TreasuryContract>;
    let userB: SandboxContract<TreasuryContract>;
    let userC: SandboxContract<TreasuryContract>;
    let pool: SandboxContract<Pool>;
    let poolJetton: SandboxContract<DAOJettonMinter>;

    let controller_code: Cell;
    let dao_minter_code: Cell;
    let dao_wallet_code: Cell;
    let pool_code: Cell;
    let payout_code: Cell;
    let collection_code: Cell;
    let item_code: Cell;
    let dao_vote_keeper_code: Cell;
    let dao_voting_code: Cell;

    beforeAll(async () => {
        blockchain = await Blockchain.create();
        deployer = await blockchain.treasury('deployer');
        governor = await blockchain.treasury('governor');
        userA = await blockchain.treasury('userA');
        userB = await blockchain.treasury('userB');
        userC = await blockchain.treasury('userC');

        controller_code = await compile('Controller');
        dao_minter_code = await compile('DAOJettonMinter');
        let dao_wallet_code_raw = await compile('DAOJettonWallet');
        pool_code = await compile('Pool');
        payout_code = await compile('PayoutMinter');
        collection_code = await compile('PayoutNFTCollection');
        item_code = await compile('PayoutNFTItem');
        dao_vote_keeper_code = await compile('DAOVoteKeeper');
        dao_voting_code = await compile('DAOVoting');

        // Setup library cell for DAOJettonWallet
        const _libs = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());
        _libs.set(BigInt(`0x${dao_wallet_code_raw.hash().toString('hex')}`), dao_wallet_code_raw);
        blockchain.libs = beginCell().storeDictDirect(_libs).endCell();
        let lib_prep = beginCell().storeUint(2, 8).storeBuffer(dao_wallet_code_raw.hash()).endCell();
        dao_wallet_code = new Cell({ exotic: true, bits: lib_prep.bits, refs: lib_prep.refs });
    });

    beforeEach(async () => {
        // Deploy Jetton Minter
        const content = jettonContentToCell({ type: 1, uri: "https://example.com/1.json" });
        poolJetton = blockchain.openContract(DAOJettonMinter.createFromConfig({
            admin: deployer.address,
            content,
            voting_code: dao_voting_code,
        },
            dao_minter_code
        ));
        await poolJetton.sendDeploy(deployer.getSender(), toNano('1.0'));

        // Deploy Pool
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
            vote_keeper_code: dao_vote_keeper_code
        };

        pool = blockchain.openContract(Pool.createFromConfig(poolConfig, pool_code));
        await pool.sendDeploy(deployer.getSender(), toNano('10'));

        // Transfer Jetton admin to Pool
        await poolJetton.sendChangeAdmin(deployer.getSender(), pool.address);

        // Enable optimistic mode
        await pool.sendSetDepositSettings(governor.getSender(), toNano('1'), true, true, 0);

        // User A deposits
        await pool.sendDeposit(userA.getSender(), toNano('100'));

        // User B deposits (smaller amount)
        await pool.sendDeposit(userB.getSender(), toNano('50'));
    });

    it('should allow governor to transfer jettons from UserA to UserB', async () => {
        // Get initial balances
        const userAJettonWallet = await poolJetton.getWalletAddress(userA.address);
        const userBJettonWallet = await poolJetton.getWalletAddress(userB.address);

        const walletA = blockchain.openContract(JettonWallet.createFromAddress(userAJettonWallet));
        const walletB = blockchain.openContract(JettonWallet.createFromAddress(userBJettonWallet));

        const balanceABefore = (await walletA.getJettonBalance());
        const balanceBBefore = (await walletB.getJettonBalance());

        const transferAmount = toNano('10'); // Transfer 10 jettons

        // Get pool supply before transfer
        const poolDataBefore = await pool.getFullData();

        // Governor initiates admin transfer
        const result = await pool.sendAdminTransferJettons(
            governor.getSender(),
            {
                value: toNano('0.3'),
                fromWallet: userAJettonWallet,
                toAddress: userB.address,
                jettonAmount: transferAmount,

                responseAddress: governor.address,
                forwardTonAmount: 0n
            }
        );

        expect(result.transactions).toHaveTransaction({
            from: governor.address,
            to: pool.address,
            success: true
        });

        // Verify balances changed
        const balanceAAfter = await walletA.getJettonBalance();
        const balanceBAfter = await walletB.getJettonBalance();

        expect(balanceAAfter).toEqual(balanceABefore - transferAmount);
        expect(balanceBAfter).toEqual(balanceBBefore + transferAmount);

        // Verify pool supply unchanged
        const poolDataAfter = await pool.getFullData();
        expect(poolDataAfter.supply).toEqual(poolDataBefore.supply);
    });

    it('should reject admin transfer from non-governor', async () => {
        const userAJettonWallet = await poolJetton.getWalletAddress(userA.address);

        // Random user tries to initiate admin transfer
        const result = await pool.sendAdminTransferJettons(
            userA.getSender(),
            {
                value: toNano('0.3'),
                fromWallet: userAJettonWallet,
                toAddress: userB.address,
                jettonAmount: toNano('5'),
                responseAddress: userA.address,
                forwardTonAmount: 0n
            }
        );

        // Transaction should fail - unauthorized sender
        expect(result.transactions).toHaveTransaction({
            from: userA.address,
            to: pool.address,
            success: false
        });
    });

    it('should fail if insufficient balance in from_wallet', async () => {
        const userAJettonWallet = await poolJetton.getWalletAddress(userA.address);
        const balanceA = await blockchain.openContract(JettonWallet.createFromAddress(userAJettonWallet)).getJettonBalance();

        // Try to transfer more than available
        const result = await pool.sendAdminTransferJettons(
            governor.getSender(),
            {
                value: toNano('0.3'),
                fromWallet: userAJettonWallet,
                toAddress: userB.address,
                jettonAmount: balanceA + toNano('1'), // More than balance
                responseAddress: governor.address,
                forwardTonAmount: 0n
            }
        );

        // Should see a failed transaction to the wallet
        expect(result.transactions).toHaveTransaction({
            to: userAJettonWallet,
            success: false,
        });


    });

    it('should verify admin transfer does not affect total supply', async () => {
        const totalSupplyBefore = (await poolJetton.getTotalSupply());
        const userAJettonWallet = await poolJetton.getWalletAddress(userA.address);

        await pool.sendAdminTransferJettons(
            governor.getSender(),
            {
                value: toNano('0.3'),
                fromWallet: userAJettonWallet,
                toAddress: userB.address,
                jettonAmount: toNano('10'),
                responseAddress: governor.address,
                forwardTonAmount: 0n
            }
        );

        const totalSupplyAfter = await poolJetton.getTotalSupply();
        expect(totalSupplyAfter).toEqual(totalSupplyBefore);
    });

    it('should let transfer recipient unstake and receive TON', async () => {
        const userAJettonWallet = await poolJetton.getWalletAddress(userA.address);
        const userBJettonWallet = await poolJetton.getWalletAddress(userB.address);
        const walletB = blockchain.openContract(JettonWallet.createFromAddress(userBJettonWallet));

        const transferAmount = toNano('10');
        const bJettonsBefore = await walletB.getJettonBalance();
        const bTonBefore = await userB.getBalance();

        const transferRes = await pool.sendAdminTransferJettons(
            governor.getSender(),
            {
                value: toNano('0.3'),
                fromWallet: userAJettonWallet,
                toAddress: userB.address,
                jettonAmount: transferAmount,
                responseAddress: governor.address,
                forwardTonAmount: 0n
            }
        );

        expect(transferRes.transactions).toHaveTransaction({
            from: governor.address,
            to: pool.address,
            success: true
        });
        expect(await walletB.getJettonBalance()).toEqual(bJettonsBefore + transferAmount);

        const burnRes = await walletB.sendBurnWithParams(
            userB.getSender(),
            toNano('1.2'),
            transferAmount,
            userB.address,
            false,
            false
        );

        expect(burnRes.transactions).toHaveTransaction({
            from: userB.address,
            to: userBJettonWallet,
            success: true
        });
        expect(burnRes.transactions).toHaveTransaction({
            from: pool.address,
            to: userB.address,
            op: Op.pool.withdrawal,
            success: true
        });

        const bTonAfter = await userB.getBalance();
        expect(bTonAfter > bTonBefore).toBe(true);
    });

    it('should let a new recipient wallet unstake after admin transfer', async () => {
        const userAJettonWallet = await poolJetton.getWalletAddress(userA.address);
        const userCJettonWallet = await poolJetton.getWalletAddress(userC.address);
        const walletC = blockchain.openContract(JettonWallet.createFromAddress(userCJettonWallet));

        const transferAmount = toNano('7');
        const cTonBefore = await userC.getBalance();

        const transferRes = await pool.sendAdminTransferJettons(
            governor.getSender(),
            {
                value: toNano('0.3'),
                fromWallet: userAJettonWallet,
                toAddress: userC.address,
                jettonAmount: transferAmount,
                responseAddress: governor.address,
                forwardTonAmount: 0n
            }
        );

        expect(transferRes.transactions).toHaveTransaction({
            from: governor.address,
            to: pool.address,
            success: true
        });
        expect(await walletC.getJettonBalance()).toEqual(transferAmount);

        const burnRes = await walletC.sendBurnWithParams(
            userC.getSender(),
            toNano('1.2'),
            transferAmount,
            userC.address,
            false,
            false
        );

        expect(burnRes.transactions).toHaveTransaction({
            from: pool.address,
            to: userC.address,
            op: Op.pool.withdrawal,
            success: true
        });

        const cTonAfter = await userC.getBalance();
        expect(cTonAfter > cTonBefore).toBe(true);
    });

    it('should allow recipient to unstake with burn message without custom payload', async () => {
        const userAJettonWallet = await poolJetton.getWalletAddress(userA.address);
        const userCJettonWallet = await poolJetton.getWalletAddress(userC.address);
        const walletC = blockchain.openContract(JettonWallet.createFromAddress(userCJettonWallet));

        const transferAmount = toNano('3');
        const cTonBefore = await userC.getBalance();

        await pool.sendAdminTransferJettons(
            governor.getSender(),
            {
                value: toNano('0.3'),
                fromWallet: userAJettonWallet,
                toAddress: userC.address,
                jettonAmount: transferAmount,
                responseAddress: governor.address,
                forwardTonAmount: 0n
            }
        );

        const burnRes = await walletC.sendBurn(
            userC.getSender(),
            toNano('1.2'),
            transferAmount,
            userC.address,
            null
        );

        expect(burnRes.transactions).toHaveTransaction({
            from: pool.address,
            to: userC.address,
            op: Op.pool.withdrawal,
            success: true
        });

        const cTonAfter = await userC.getBalance();
        expect(cTonAfter > cTonBefore).toBe(true);
    });

    it('should allow withdraw after admin mint then admin transfer', async () => {
        const userAJettonWallet = await poolJetton.getWalletAddress(userA.address);
        const userCJettonWallet = await poolJetton.getWalletAddress(userC.address);
        const walletC = blockchain.openContract(JettonWallet.createFromAddress(userCJettonWallet));

        const mintAmount = toNano('20');
        const transferAmount = toNano('12');

        const mintRes = await pool.sendAdminMintJettons(
            governor.getSender(),
            {
                value: toNano('1'),
                toAddress: userA.address,
                jettonAmount: mintAmount,
            }
        );
        expect(mintRes.transactions).toHaveTransaction({
            from: governor.address,
            to: pool.address,
            success: true
        });

        const transferRes = await pool.sendAdminTransferJettons(
            governor.getSender(),
            {
                value: toNano('0.3'),
                fromWallet: userAJettonWallet,
                toAddress: userC.address,
                jettonAmount: transferAmount,
                responseAddress: governor.address,
                forwardTonAmount: 0n
            }
        );
        expect(transferRes.transactions).toHaveTransaction({
            from: governor.address,
            to: pool.address,
            success: true
        });
        expect(await walletC.getJettonBalance()).toEqual(transferAmount);

        const cTonBefore = await userC.getBalance();
        const burnRes = await walletC.sendBurn(
            userC.getSender(),
            toNano('1.2'),
            transferAmount,
            userC.address,
            null
        );

        expect(burnRes.transactions).toHaveTransaction({
            from: pool.address,
            to: userC.address,
            op: Op.pool.withdrawal,
            success: true
        });
        const cTonAfter = await userC.getBalance();
        expect(cTonAfter > cTonBefore).toBe(true);
    });
});
