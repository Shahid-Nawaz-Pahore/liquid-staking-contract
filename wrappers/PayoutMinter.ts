import { Address, beginCell, Cell, Contract, contractAddress, ContractProvider, Sender, SendMode, toNano } from 'ton-core';
import { ensureAddress } from '../contracts/utils/address';

export type PayoutMinterContent = {
    type:0|1,
    uri:string
};
export type PayoutMinterConfig = {admin: Address; content: Cell; wallet_code: Cell};

export function payoutMinterConfigToCell(config: PayoutMinterConfig): Cell {
    const adminAddress = ensureAddress(config.admin);
    if (!adminAddress) {
        throw new Error('Invalid admin address provided to payoutMinterConfigToCell');
    }
    return beginCell()
        .storeCoins(0)
        .storeAddress(adminAddress)
        .storeRef(config.content)
        .storeRef(config.wallet_code)
        .endCell();
}

export function payoutContentToCell(content:PayoutMinterContent) {
    return beginCell()
                      .storeUint(content.type, 8)
                      .storeStringTail(content.uri) //Snake logic under the hood
           .endCell();
}

// Alias for compatibility with existing tests
export const jettonContentToCell = payoutContentToCell;

export class PayoutMinter implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromAddress(address: Address) {
        return new PayoutMinter(address);
    }

    static createFromConfig(config: PayoutMinterConfig, code: Cell, workchain = 0) {
        const data = payoutMinterConfigToCell(config);
        const init = { code, data };
        return new PayoutMinter(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        });
    }

    async sendChangeAdmin(provider: ContractProvider, via: Sender, new_admin: Address) {
        await provider.internal(via, {
            value: toNano("0.1"),
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(0x4840664f, 32) // op: change_admin (same as AwaitedMinter)
                .storeUint(0, 64) // query_id
                .storeAddress(new_admin)
                .endCell(),
        });
    }

    static mintMessage(to: Address, jetton_amount: bigint, forward_ton_amount: bigint, total_ton_amount: bigint,) {
        return beginCell().storeUint(0x1674b0a0, 32).storeUint(0, 64) // op, queryId
                          .storeAddress(to).storeCoins(jetton_amount)
                          .storeCoins(forward_ton_amount).storeCoins(total_ton_amount)
               .endCell();
    }

    async sendMint(provider: ContractProvider, via: Sender, value: bigint, to: Address, jetton_amount: bigint, forward_ton_amount: bigint, total_ton_amount: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: PayoutMinter.mintMessage(to, jetton_amount, forward_ton_amount, total_ton_amount),
        });
    }

    async getWalletAddress(provider: ContractProvider, owner: Address) {
        const res = await provider.get('get_wallet_address', [
            { type: 'slice', cell: beginCell().storeAddress(owner).endCell() }
        ]);
        return res.stack.readAddress();
    }

    async getJettonData(provider: ContractProvider) {
        const res = await provider.get('get_jetton_data', []);
        return {
            totalSupply: res.stack.readBigNumber(),
            mintable: res.stack.readBoolean(),
            admin: res.stack.readAddress(),
            content: res.stack.readCell(),
            walletCode: res.stack.readCell()
        };
    }

    async getTotalSupply(provider: ContractProvider) {
        const data = await this.getJettonData(provider);
        return data.totalSupply;
    }
}
