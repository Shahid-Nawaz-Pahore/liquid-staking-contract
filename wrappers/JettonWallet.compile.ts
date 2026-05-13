import { CompilerConfig } from '@ton-community/blueprint';
import { writeFile, mkdir } from 'fs/promises';
import path from 'path';
import { compile as compileFunc } from '@ton-community/blueprint';

// Root-level shim mirroring DAO wallet pre/post hooks, path-adjusted
export const compile: CompilerConfig = {
    lang: 'func',
    preCompileHook: async () => {
        await compileFunc('VoteKeeper');
    },
    targets: [
        'contracts/jetton_dao/contracts/auto/vote-keeper-code.func',
        'contracts/jetton_dao/contracts/external_params.func',
        'contracts/jetton_dao/contracts/jetton-wallet.func'
    ],
    postCompileHook: async (code) => {
        const auto = path.join(__dirname, '..', 'contracts', 'jetton_dao', 'contracts', 'auto');
        await mkdir(auto, { recursive: true });
        await writeFile(path.join(auto, 'jetton-wallet-code.func'), `cell jetton_wallet_code() asm "<b 2 8 u, 0x${code.hash().toString('hex')} 256 u, b>spec PUSHREF";`);
    }
};


