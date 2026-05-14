import { CompilerConfig, compile as compileFunc } from '@ton/blueprint';
import path from 'path';
import fs from 'fs';

// Root-level shim to compile awaited_minter JettonMinter from repo root.
// Mirrors PayoutMinter.compile.ts so `compile('JettonMinter')` returns the
// awaited-minter binary (used by tests/PoolProxyAdmin.spec.ts).
export const compile: CompilerConfig = {
    lang: 'func',
    preCompileHook: async () => {
        await compileFunc('PayoutWallet');
        const consigliere_address = path.join(__dirname, '..', 'contracts', 'auto', 'consigliere_address.func');
        if (!fs.existsSync(consigliere_address)) {
            throw new Error('Consigliere address not defined in contracts/auto/consigliere_address.func, use setConsigliere');
        }
    },
    targets: ['contracts/auto/consigliere_address.func',
              'contracts/auto/payout-jetton-wallet-code.func',
              'contracts/awaited_minter/contracts/jetton-minter.func'],
};
