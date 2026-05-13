import { Address, beginCell, Cell, Contract, contractAddress, ContractProvider, Sender, SendMode, toNano } from 'ton-core';
import { JettonWallet as AwaitedJettonWallet } from '../contracts/awaited_minter/wrappers/JettonWallet';

export class PoolJettonWallet extends AwaitedJettonWallet {
    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {
        super(address, init);
    }

    static createFromAddress(address: Address) {
        return new PoolJettonWallet(address);
    }

    async sendBurnWithParams(provider: ContractProvider, via: Sender, value: bigint,
                          jetton_amount: bigint,
                          responseAddress: Address,
                          waitTillRoundEnd: boolean, // opposite of request_immediate_withdrawal
                          fillOrKill: boolean) {
        // Create customPayload with the withdrawal parameters
        let customPayload = beginCell()
           .storeUint(Number(waitTillRoundEnd), 1)
           .storeUint(Number(fillOrKill), 1).endCell();
        
        // Use the awaited minter's burnMessage implementation with custom payload
        const burnBody = beginCell().storeUint(0x595f07bc, 32).storeUint(0, 64) // op, queryId
                          .storeCoins(jetton_amount).storeAddress(responseAddress)
                          .storeMaybeRef(customPayload)
               .endCell();
        
        await provider.internal(via, {
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: burnBody,
            value: value
        });
    }
}
