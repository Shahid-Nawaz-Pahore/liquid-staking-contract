import type { Config } from 'jest';

const config: Config = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    maxWorkers: 1,
    testTimeout: 150000,
    testPathIgnorePatterns: [
        '/contracts/awaited_minter/tests/',
        '/contracts/jetton_dao/tests/'
    ],
    reporters: [
        'default'
    ],
    transform: {
        '^.+\\.(ts|tsx)$': [
            'ts-jest',
            {
                tsconfig: {
                    target: 'es2020' // allow BigInt in transpiled output
                },
                diagnostics: false
            }
        ]
    }
};

export default config;
