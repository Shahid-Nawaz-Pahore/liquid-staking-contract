import { CompilerConfig } from '@ton-community/blueprint';

// Root-level shim to compile awaited_minter JettonMinter from repo root
export const compile: CompilerConfig = {
    targets: ['contracts/awaited_minter/contracts/jetton-minter.func']
};


