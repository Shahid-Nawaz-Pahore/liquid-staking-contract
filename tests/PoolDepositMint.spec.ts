import { Blockchain, SandboxContract, TreasuryContract } from '@ton-community/sandbox';
import { Address, beginCell, toNano, Dictionary, Cell } from 'ton-core';
import { Pool } from '../wrappers/Pool';
import { PayoutMinter, payoutContentToCell } from '../wrappers/PayoutMinter';
import { JettonWallet as DAOWallet } from '../wrappers/JettonWallet';
import { compile } from '@ton-community/blueprint';
import { Conf, Op } from '../PoolConstants';
import '@ton-community/test-utils';

describe('PoolDepositMint regression', () => {
    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let pool: SandboxContract<Pool>;
    let poolJetton: SandboxContract<PayoutMinter>;
    let pool_code: Cell;
    let controller_code: Cell;
    let dao_minter_code: Cell;
    let dao_wallet_code: Cell;

    beforeAll(async () => {
        blockchain = await Blockchain.create();
        deployer = await blockchain.treasury('deployer');

        pool_code = await compile('Pool');
        controller_code = await compile('Controller');
        dao_minter_code = await compile('PayoutMinter');
        const dao_wallet_code_raw = await compile('PayoutWallet');

        // Setup library for dao_wallet
        const _libs = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());
        _libs.set(BigInt(`0x${dao_wallet_code_raw.hash().toString('hex')}`), dao_wallet_code_raw);
        blockchain.libs = beginCell().storeDictDirect(_libs).endCell();
        let lib_prep = beginCell().storeUint(2, 8).storeBuffer(dao_wallet_code_raw.hash()).endCell();
        dao_wallet_code = new Cell({ exotic: true, bits: lib_prep.bits, refs: lib_prep.refs });

        const content = payoutContentToCell({ type: 1, uri: "https://example.com/1.json" });
        poolJetton = blockchain.openContract(PayoutMinter.createFromConfig({
            admin: deployer.address,
            content,
            wallet_code: dao_wallet_code
        }, dao_minter_code));

        await poolJetton.sendDeploy(deployer.getSender(), toNano('0.1'));

        pool = blockchain.openContract(Pool.createFromConfig({
            pool_jetton: poolJetton.address,
            pool_jetton_supply: 0n,
            optimistic_deposit_withdrawals: -1n,
            sudoer: deployer.address,
            governor: deployer.address,
            interest_manager: deployer.address,
            halter: deployer.address,
            approver: deployer.address,
            controller_code: controller_code,
            pool_jetton_wallet_code: dao_wallet_code,
        }, pool_code));

        await pool.sendDeploy(deployer.getSender(), toNano('1'));
        await poolJetton.sendChangeAdmin(deployer.getSender(), pool.address);
    });

    it('should complete pool deposit -> mint -> internal_transfer flow without exitCode 9', async () => {
        const user = await blockchain.treasury('user');
        const depositAmount = toNano('100');

        const res = await pool.sendDeposit(user.getSender(), depositAmount);

        // 1. Verify deposit reached pool
        expect(res.transactions).toHaveTransaction({
            from: user.address,
            to: pool.address,
            op: Op.pool.deposit,
            success: true
        });

        // 2. Verify pool initiated mint (0x1674b0a0)
        expect(res.transactions).toHaveTransaction({
            from: pool.address,
            to: poolJetton.address,
            op: Op.payout.mint,
            success: true
        });

        // 3. Verify internal_transfer (0x178d4519) to user's jetton wallet
        const userJettonWalletAddr = await poolJetton.getWalletAddress(user.address);
        expect(res.transactions).toHaveTransaction({
            from: poolJetton.address,
            to: userJettonWalletAddr,
            op: Op.jetton.internal_transfer,
            success: true
        });

        // Check for exitCode 9 (cell underflow) in any transaction in the chain
        for (const tx of res.transactions) {
            if (tx.description.type === 'generic' && tx.description.computePhase.type === 'vm') {
                expect(tx.description.computePhase.exitCode).not.toBe(9);
            }
        }

        const userJettonWallet = blockchain.openContract(DAOWallet.createFromAddress(userJettonWalletAddr));
        const balance = await userJettonWallet.getJettonBalance();
        expect(balance).toBeGreaterThan(0n);
    });
});
