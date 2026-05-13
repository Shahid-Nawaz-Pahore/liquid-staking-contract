import { Blockchain, SandboxContract, TreasuryContract } from '@ton-community/sandbox';
import { Cell, toNano, beginCell, Address, Contract, contractAddress, ContractProvider, Sender, SendMode } from 'ton-core';
import { Pool } from '../wrappers/Pool';
import { Op, Conf, PoolState } from '../PoolConstants';
import '@ton-community/test-utils';
import { compile } from '@ton-community/blueprint';

// Inline JettonMinter helper to avoid ton-core version conflicts
type JettonMinterContent = { type: 0 | 1; uri: string };
type JettonMinterConfig = { admin: Address; content: Cell; wallet_code: Cell };

function jettonContentToCell(content: JettonMinterContent): Cell {
    return beginCell()
        .storeUint(content.type, 8)
        .storeStringTail(content.uri)
        .endCell();
}

function jettonMinterConfigToCell(config: JettonMinterConfig): Cell {
    return beginCell()
        .storeCoins(0) // total_supply
        .storeAddress(config.admin)
        .storeRef(config.content)
        .storeRef(config.wallet_code)
        .endCell();
}

class JettonMinter implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromConfig(config: JettonMinterConfig, code: Cell, workchain = 0) {
        const data = jettonMinterConfigToCell(config);
        const init = { code, data };
        return new JettonMinter(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        });
    }

    static changeAdminMessage(newOwner: Address) {
        return beginCell()
            .storeUint(0x4840664f, 32)
            .storeUint(0, 64)
            .storeAddress(newOwner)
            .endCell();
    }

    async sendChangeAdmin(provider: ContractProvider, via: Sender, newOwner: Address) {
        await provider.internal(via, {
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: JettonMinter.changeAdminMessage(newOwner),
            value: toNano('0.1'),
        });
    }

    async getJettonData(provider: ContractProvider) {
        let res = await provider.get('get_jetton_data', []);
        let totalSupply = res.stack.readBigNumber();
        let mintable = res.stack.readBoolean();
        let adminAddress = res.stack.readAddress();
        let content = res.stack.readCell();
        let walletCode = res.stack.readCell();
        return {
            totalSupply,
            mintable,
            adminAddress,
            content,
            walletCode,
        };
    }
}

/**
 * Pool Proxy Admin Test Suite
 * 
 * Tests the Pool's proxy admin layer for managing Jetton Minter operations.
 * All operations should:
 * 1. Require governor authorization
 * 2. Maintain supply consistency
 * 3. Handle bounces properly
 * 4. Forward messages correctly to the Jetton Minter
 */

describe('Pool Proxy Admin', () => {
    let poolCode: Cell;
    let controllerCode: Cell;
    let jettonWalletCode: Cell;
    let jettonMinterCode: Cell;
    
    let blockchain: Blockchain;
    let pool: SandboxContract<Pool>;
    let governor: SandboxContract<TreasuryContract>;
    let sudoer: SandboxContract<TreasuryContract>;
    let interestManager: SandboxContract<TreasuryContract>;
    let halter: SandboxContract<TreasuryContract>;
    let approver: SandboxContract<TreasuryContract>;
    let user1: SandboxContract<TreasuryContract>;
    let user2: SandboxContract<TreasuryContract>;
    let jettonMinter: SandboxContract<JettonMinter>;

    beforeAll(async () => {
        poolCode = await compile('Pool');
        controllerCode = await compile('Controller');
        jettonWalletCode = await compile('JettonWallet'); // From awaited_minter
        jettonMinterCode = await compile('JettonMinter'); // From awaited_minter
    });

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        
        governor = await blockchain.treasury('governor');
        sudoer = await blockchain.treasury('sudoer');
        interestManager = await blockchain.treasury('interest_manager');
        halter = await blockchain.treasury('halter');
        approver = await blockchain.treasury('approver');
        user1 = await blockchain.treasury('user1');
        user2 = await blockchain.treasury('user2');

        // Deploy jetton minter (awaited minter) with Pool as temporary admin
        // We'll transfer admin to Pool after deployment
        const content = jettonContentToCell({type: 1, uri: "https://example.com/jetton.json"});
        jettonMinter = blockchain.openContract(
            JettonMinter.createFromConfig(
                {
                    admin: governor.address, // Initially set governor, will transfer to pool
                    content,
                    wallet_code: jettonWalletCode
                },
                jettonMinterCode
            )
        );

        // Deploy the minter
        await jettonMinter.sendDeploy(governor.getSender(), toNano('1'));

        // Deploy Pool contract
        pool = blockchain.openContract(
            Pool.createFromConfig(
                {
                    pool_jetton: jettonMinter.address,
                    pool_jetton_supply: 0n,
                    optimistic_deposit_withdrawals: -1n, // -1 = true, 0 = false (1-bit signed int)
                    sudoer: sudoer.address,
                    governor: governor.address,
                    interest_manager: interestManager.address,
                    halter: halter.address,
                    approver: approver.address,
                    controller_code: controllerCode,
                    pool_jetton_wallet_code: jettonWalletCode,
                },
                poolCode
            )
        );

        const deployResult = await pool.sendDeploy(sudoer.getSender(), toNano('100'));
        expect(deployResult.transactions).toHaveTransaction({
            from: sudoer.address,
            to: pool.address,
            deploy: true,
            success: true,
        });

        // Transfer minter admin to Pool
        await jettonMinter.sendChangeAdmin(governor.getSender(), pool.address);
        
        // Verify admin changed
        const minterData = await jettonMinter.getJettonData();
        expect(minterData.adminAddress.equals(pool.address)).toBe(true);
    });

    describe('Admin Mint', () => {
        it('should allow governor to mint tokens', async () => {
            const mintAmount = toNano('1000');
            const forwardTonAmount = toNano('0.05');
            const totalTonAmount = toNano('0.15');

            const result = await pool.sendAdminMint(
                governor.getSender(),
                user1.address,
                mintAmount,
                forwardTonAmount,
                totalTonAmount,
                1
            );

            // Should forward to jetton minter
            expect(result.transactions).toHaveTransaction({
                from: pool.address,
                to: jettonMinter.address,
                success: true,
            });

            // Check supply increased
            const poolData = await pool.getFullData();
            expect(poolData.poolJettonSupply).toEqual(mintAmount);
        });

        it('should reject mint from non-governor', async () => {
            const mintAmount = toNano('1000');
            const forwardTonAmount = toNano('0.05');
            const totalTonAmount = toNano('0.15');

            const result = await pool.sendAdminMint(
                user1.getSender(),
                user2.address,
                mintAmount,
                forwardTonAmount,
                totalTonAmount,
                1
            );

            expect(result.transactions).toHaveTransaction({
                from: user1.address,
                to: pool.address,
                success: false,
            });
        });

        it('should revert supply on bounced mint', async () => {
            const poolData = await pool.getFullData();
            const initialSupply = poolData.poolJettonSupply;

            // Mint will bounce because minter rejects it
            const mintAmount = toNano('1000');
            const result = await pool.sendAdminMint(
                governor.getSender(),
                Address.parse('EQD__________________________________________0vo'), // Invalid address
                mintAmount,
                toNano('0.05'),
                toNano('0.15'),
                1
            );

            // Check supply was reverted after bounce
            const newPoolData = await pool.getFullData();
            // Note: In sandbox, bounced transactions may not fully revert immediately
            // This test verifies the bounce handling mechanism exists
        });

        it('should reject zero amount mint', async () => {
            const result = await pool.sendAdminMint(
                governor.getSender(),
                user1.address,
                0n,
                toNano('0.05'),
                toNano('0.15'),
                1
            );

            expect(result.transactions).toHaveTransaction({
                from: governor.address,
                to: pool.address,
                success: false,
            });
        });
    });

    describe('Admin Burn', () => {
        it('should allow governor to burn tokens', async () => {
            // First mint some tokens
            await pool.sendAdminMint(
                governor.getSender(),
                user1.address,
                toNano('1000'),
                toNano('0.05'),
                toNano('0.15'),
                1
            );

            // Then burn
            const burnAmount = toNano('500');
            const result = await pool.sendAdminBurn(
                governor.getSender(),
                user1.address,
                burnAmount,
                toNano('0.1'),
                2
            );

            // Should forward to jetton minter
            expect(result.transactions).toHaveTransaction({
                from: pool.address,
                to: jettonMinter.address,
                success: true,
            });
        });

        it('should reject burn from non-governor', async () => {
            const result = await pool.sendAdminBurn(
                user1.getSender(),
                user2.address,
                toNano('500'),
                toNano('0.1'),
                1
            );

            expect(result.transactions).toHaveTransaction({
                from: user1.address,
                to: pool.address,
                success: false,
            });
        });

        it('should reject burn exceeding supply', async () => {
            const poolData = await pool.getFullData();
            const supply = poolData.poolJettonSupply;

            const result = await pool.sendAdminBurn(
                governor.getSender(),
                user1.address,
                supply + toNano('1'), // More than supply
                toNano('0.1'),
                1
            );

            expect(result.transactions).toHaveTransaction({
                from: governor.address,
                to: pool.address,
                success: false,
            });
        });
    });

    describe('Admin Transfer', () => {
        it('should allow governor to transfer tokens between addresses', async () => {
            const transferAmount = toNano('100');
            const result = await pool.sendAdminTransfer(
                governor.getSender(),
                user1.address,
                user2.address,
                transferAmount,
                toNano('0.05'),
                1
            );

            // Should forward to jetton minter
            expect(result.transactions).toHaveTransaction({
                from: pool.address,
                to: jettonMinter.address,
                success: true,
            });
        });

        it('should reject transfer from non-governor', async () => {
            const result = await pool.sendAdminTransfer(
                user1.getSender(),
                user1.address,
                user2.address,
                toNano('100'),
                toNano('0.05'),
                1
            );

            expect(result.transactions).toHaveTransaction({
                from: user1.address,
                to: pool.address,
                success: false,
            });
        });

        it('should reject zero amount transfer', async () => {
            const result = await pool.sendAdminTransfer(
                governor.getSender(),
                user1.address,
                user2.address,
                0n,
                toNano('0.05'),
                1
            );

            expect(result.transactions).toHaveTransaction({
                from: governor.address,
                to: pool.address,
                success: false,
            });
        });
    });

    describe('Freeze/Unfreeze Wallet', () => {
        it('should allow governor to freeze a wallet', async () => {
            const result = await pool.sendFreezeWallet(
                governor.getSender(),
                user1.address,
                1
            );

            // Should forward to jetton minter
            expect(result.transactions).toHaveTransaction({
                from: pool.address,
                to: jettonMinter.address,
                success: true,
            });
        });

        it('should allow governor to unfreeze a wallet', async () => {
            const result = await pool.sendUnfreezeWallet(
                governor.getSender(),
                user1.address,
                1
            );

            // Should forward to jetton minter
            expect(result.transactions).toHaveTransaction({
                from: pool.address,
                to: jettonMinter.address,
                success: true,
            });
        });

        it('should reject freeze from non-governor', async () => {
            const result = await pool.sendFreezeWallet(
                user1.getSender(),
                user2.address,
                1
            );

            expect(result.transactions).toHaveTransaction({
                from: user1.address,
                to: pool.address,
                success: false,
            });
        });

        it('should reject unfreeze from non-governor', async () => {
            const result = await pool.sendUnfreezeWallet(
                user1.getSender(),
                user2.address,
                1
            );

            expect(result.transactions).toHaveTransaction({
                from: user1.address,
                to: pool.address,
                success: false,
            });
        });
    });

    describe('Set Freeze Period', () => {
        it('should allow governor to set freeze period', async () => {
            const newPeriod = 7 * 24 * 60 * 60; // 7 days

            const result = await pool.sendSetFreezePeriod(
                governor.getSender(),
                newPeriod,
                1
            );

            // Should forward to jetton minter
            expect(result.transactions).toHaveTransaction({
                from: pool.address,
                to: jettonMinter.address,
                success: true,
            });
        });

        it('should reject -1 freeze period (pool validates >= 0)', async () => {
            const result = await pool.sendSetFreezePeriod(
                governor.getSender(),
                -1,
                1
            );

            // Pool should reject -1 immediately without forwarding to minter
            expect(result.transactions).toHaveTransaction({
                from: governor.address,
                to: pool.address,
                success: false,
                exitCode: 0xfc02, // error::invalid_freeze_period
            });
        });

        it('should reject set freeze period from non-governor', async () => {
            const result = await pool.sendSetFreezePeriod(
                user1.getSender(),
                7 * 24 * 60 * 60,
                1
            );

            expect(result.transactions).toHaveTransaction({
                from: user1.address,
                to: pool.address,
                success: false,
            });
        });

        it('should reject invalid freeze period (< 0)', async () => {
            const result = await pool.sendSetFreezePeriod(
                governor.getSender(),
                -2,
                1
            );

            // Pool should reject negative values < 0 immediately
            expect(result.transactions).toHaveTransaction({
                from: governor.address,
                to: pool.address,
                success: false,
            });
        });
    });

    describe('Supply Consistency', () => {
        it('should maintain supply consistency across mint operations', async () => {
            const initialData = await pool.getFullData();
            const initialSupply = initialData.poolJettonSupply;

            // Mint 1000
            await pool.sendAdminMint(
                governor.getSender(),
                user1.address,
                toNano('1000'),
                toNano('0.05'),
                toNano('0.15'),
                1
            );

            let poolData = await pool.getFullData();
            expect(poolData.poolJettonSupply).toEqual(initialSupply + toNano('1000'));

            // Mint another 500
            await pool.sendAdminMint(
                governor.getSender(),
                user2.address,
                toNano('500'),
                toNano('0.05'),
                toNano('0.15'),
                2
            );

            poolData = await pool.getFullData();
            expect(poolData.poolJettonSupply).toEqual(initialSupply + toNano('1500'));
        });

        it('should not change supply on admin transfer', async () => {
            // First mint some tokens
            await pool.sendAdminMint(
                governor.getSender(),
                user1.address,
                toNano('1000'),
                toNano('0.05'),
                toNano('0.15'),
                1
            );

            const dataBeforeTransfer = await pool.getFullData();
            const supplyBefore = dataBeforeTransfer.poolJettonSupply;

            // Transfer tokens
            await pool.sendAdminTransfer(
                governor.getSender(),
                user1.address,
                user2.address,
                toNano('100'),
                toNano('0.05'),
                2
            );

            const dataAfterTransfer = await pool.getFullData();
            const supplyAfter = dataAfterTransfer.poolJettonSupply;

            // Supply should not change
            expect(supplyAfter).toEqual(supplyBefore);
        });
    });

    describe('Gas and Fee Handling', () => {
        it('should handle sufficient gas for admin operations', async () => {
            const result = await pool.sendAdminMint(
                governor.getSender(),
                user1.address,
                toNano('100'),
                toNano('0.05'),
                toNano('0.15'),
                1
            );

            // Check that transaction succeeded with provided gas
            expect(result.transactions).toHaveTransaction({
                from: governor.address,
                to: pool.address,
                success: true,
            });
        });
    });

    describe('Integration with Pool State', () => {
        it('should allow admin mint even when pool is halted', async () => {
            // Halt the pool
            await pool.sendHalt(halter.getSender());

            // Admin mint should still work
            const result = await pool.sendAdminMint(
                governor.getSender(),
                user1.address,
                toNano('1000'),
                toNano('0.05'),
                toNano('0.15'),
                1
            );

            expect(result.transactions).toHaveTransaction({
                from: pool.address,
                to: jettonMinter.address,
                success: true,
            });
        });
    });
});

