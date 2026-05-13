/**
 * Batch Admin Transfer Script
 * ----------------------------
 * Reads a CSV file and performs pool admin jetton transfers for each row.
 *
 * CSV FORMAT (header row required):
 *
 *   Option A — different from_owner per row:
 *     from_owner,to_owner,amount
 *
 *   Option B — same from_owner for all rows (script will ask once):
 *     to_owner,amount
 *
 *   Option C — full control with custom forward TON per row:
 *     from_owner,to_owner,amount,forward_ton
 *
 * Usage:
 *   npx blueprint run batchAdminTransfer --network mainnet
 *   (script will interactively ask for all inputs)
 */ 

import * as fs from 'fs';
import * as path from 'path';
import { Address, toNano } from '@ton/core';
import { NetworkProvider } from '@ton/blueprint';
import { Pool } from '../wrappers/Pool';
import { JettonMinter as DAOJettonMinter } from '../contracts/jetton_dao/wrappers/JettonMinter';

// ─── Types ────────────────────────────────────────────────────────────────────

interface TransferRow {
    lineNumber: number;
    fromOwner: Address;
    toOwner: Address;
    jettonAmount: bigint;
    forwardTonAmount: bigint;
}

interface TransferResult {
    lineNumber: number;
    fromOwner: string;
    toOwner: string;
    jettonAmount: string;
    status: 'success' | 'skipped' | 'failed';
    error?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function parseCsv(filePath: string, globalFrom?: Address): TransferRow[] {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 0 && !l.startsWith('#'));

    if (lines.length < 2) {
        throw new Error('CSV must have a header row and at least one data row.');
    }

    const header = lines[0].toLowerCase().split(',').map(h => h.trim());

    const fromIdx = header.indexOf('from_owner');
    const toIdx   = header.indexOf('to_owner');
    const amtIdx  = header.indexOf('amount');
    const fwdIdx  = header.indexOf('forward_ton');

    if (toIdx === -1)  throw new Error('CSV must have a "to_owner" column.');
    if (amtIdx === -1) throw new Error('CSV must have an "amount" column.');
    if (fromIdx === -1 && !globalFrom) {
        throw new Error(
            'CSV has no "from_owner" column and no global from address was provided.'
        );
    }

    const rows: TransferRow[] = [];

    for (let i = 1; i < lines.length; i++) {
        const lineNumber = i + 1;
        const cols = lines[i].split(',').map(c => c.trim());
        if (cols.length === 0 || (cols.length === 1 && cols[0] === '')) continue;

        try {
            const fromOwner = globalFrom
                ? globalFrom
                : Address.parse(cols[fromIdx]);

            const toOwner = Address.parse(cols[toIdx]);

            const rawAmount = cols[amtIdx];
            if (!rawAmount || isNaN(parseFloat(rawAmount))) {
                throw new Error(`Invalid amount: "${rawAmount}"`);
            }
            const jettonAmount = toNano(rawAmount);

            const forwardTonAmount =
                fwdIdx !== -1 && cols[fwdIdx] ? toNano(cols[fwdIdx]) : 0n;

            rows.push({ lineNumber, fromOwner, toOwner, jettonAmount, forwardTonAmount });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            throw new Error(`CSV line ${lineNumber}: ${msg}`);
        }
    }

    if (rows.length === 0) {
        throw new Error('CSV contains no valid transfer rows.');
    }

    return rows;
}

async function getPoolFullDataStack(provider: NetworkProvider, poolAddress: Address) {
    const contractProvider = provider.provider(poolAddress);
    try {
        const { stack } = await contractProvider.get('get_pool_full_data_raw', []);
        return stack;
    } catch (rawErr) {
        try {
            const { stack } = await contractProvider.get('get_pool_full_data', []);
            return stack;
        } catch (fullErr) {
            const rawMsg = rawErr instanceof Error ? rawErr.message : String(rawErr);
            const fullMsg = fullErr instanceof Error ? fullErr.message : String(fullErr);
            throw new Error(
                `Failed to read pool data using get_pool_full_data_raw (${rawMsg}) and ` +
                `get_pool_full_data (${fullMsg}). Check pool address and network.`
            );
        }
    }
}

async function getPoolGovernorAndMinter(
    provider: NetworkProvider,
    poolAddress: Address
): Promise<{ governor: Address; poolJettonMinter: Address }> {
    const stack = await getPoolFullDataStack(provider, poolAddress);
    const stackItems = stack.remaining;
    if (stackItems < 30) {
        throw new Error(`Unexpected get_pool_full_data stack layout: ${stackItems} items`);
    }
    const hasExtendedFields = stackItems >= 34;
    if (!hasExtendedFields && stackItems !== 30) {
        throw new Error(`Unsupported get_pool_full_data stack layout: ${stackItems} items`);
    }

    stack.readNumber();    // state
    stack.readBoolean();   // halted
    stack.readBigNumber(); // total_balance
    stack.readNumber();    // interest_rate
    stack.readBoolean();   // optimistic_deposit_withdrawals
    stack.readBoolean();   // deposits_open
    if (hasExtendedFields) stack.readNumber(); // instant_withdrawal_fee
    stack.readBigNumber(); // saved_validator_set_hash
    stack.readTuple();     // prev_round_borrowers
    stack.readTuple();     // current_round_borrowers
    stack.readBigNumber(); // min_loan
    stack.readBigNumber(); // max_loan
    stack.readNumber();    // governance_fee_share
    if (hasExtendedFields) {
        stack.readBigNumber(); // accrued_governance_fee
        stack.readNumber();    // disbalance_tolerance
        stack.readNumber();    // credit_start_prior_elections_end
    }

    const poolJettonMinter = stack.readAddress();
    stack.readBigNumber();   // poolJettonSupply
    stack.readAddressOpt();  // depositPayout
    stack.readBigNumber();   // requested_for_deposit
    stack.readAddressOpt();  // withdrawalPayout
    stack.readBigNumber();   // requested_for_withdrawal
    stack.readAddress();     // sudoer
    stack.readNumber();      // sudoer_set_at
    const governor = stack.readAddress();
    return { governor, poolJettonMinter };
}

// ─── Main ────────────────────────────────────────────────────────────────────

export async function run(provider: NetworkProvider) {
    const ui = provider.ui();
    const sender = provider.sender();

    if (!sender.address) {
        throw new Error('Sender address is not available. Check your wallet mnemonic/version.');
    }

    // ── Step 1: Ask for inputs interactively ─────────────────────────────────

    const poolAddress = Address.parse(await ui.input('Pool address:'));

    const csvPathRaw = await ui.input('Path to CSV file (e.g. ./transfers.csv):');
    const csvPath = path.resolve(csvPathRaw.trim());
    if (!fs.existsSync(csvPath)) {
        throw new Error(`CSV file not found: ${csvPath}`);
    }

    const globalFromInput = await ui.input(
        'Global from_owner address (leave blank if "from_owner" column is in CSV):'
    );
    const globalFrom = globalFromInput.trim() ? Address.parse(globalFromInput.trim()) : undefined;

    const valueStr = (await ui.input('TON to attach per transfer (default 0.3):')) || '0.3';
    const value = toNano(valueStr);

    const delayInput = await ui.input('Delay between transfers in ms (default 2000):');
    const delayMs = delayInput.trim() ? parseInt(delayInput.trim(), 10) : 2000;

    const dryRunInput = await ui.input('Dry run only? (yes/no, default no):');
    const dryRun = dryRunInput.trim().toLowerCase() === 'yes';

    // ── Step 2: Validate pool ─────────────────────────────────────────────────

    ui.write('\n🔍 Reading pool data...');
    const { governor, poolJettonMinter: poolJettonMinterAddress } =
        await getPoolGovernorAndMinter(provider, poolAddress);

    if (!sender.address.equals(governor)) {
        throw new Error(
            `Sender ${sender.address.toString()} is NOT the pool governor ${governor.toString()}.\n` +
            'Only the governor can call admin transfers via pool.'
        );
    }
    ui.write(`✅ Governor verified: ${governor.toString()}`);

    const poolJettonMinter = provider.open(
        DAOJettonMinter.createFromAddress(poolJettonMinterAddress)
    );
    const minterData = await poolJettonMinter.getJettonData();
    if (!minterData.adminAddress.equals(poolAddress)) {
        throw new Error(
            `Minter admin is ${minterData.adminAddress.toString()}, expected pool ${poolAddress.toString()}.\n` +
            'Set minter admin to pool first.'
        );
    }
    ui.write(`✅ Minter admin verified: ${poolJettonMinterAddress.toString()}`);

    // ── Step 3: Parse CSV ─────────────────────────────────────────────────────

    ui.write(`\n📄 Parsing CSV: ${csvPath}`);
    const rows = parseCsv(csvPath, globalFrom);
    ui.write(`   Found ${rows.length} transfer(s) to process.`);

    if (dryRun) {
        ui.write('\n🚧 DRY RUN MODE — no transactions will be sent.');
    }

    // Print preview
    ui.write('\n--- Transfer Preview ---');
    for (const row of rows) {
        ui.write(
            `  Line ${row.lineNumber}: ${row.fromOwner.toString()} → ${row.toOwner.toString()} | ${row.jettonAmount} nanoJettons`
        );
    }
    ui.write('------------------------\n');

    const confirmed = await ui.prompt(
        `Proceed with ${rows.length} admin transfer(s)? (${valueStr} TON per tx)`
    );
    if (!confirmed) {
        ui.write('Aborted by user.');
        return;
    }

    // ── Step 4: Execute transfers ─────────────────────────────────────────────

    const pool = provider.open(Pool.createFromAddress(poolAddress));
    const results: TransferResult[] = [];
    let successCount = 0;
    let failCount    = 0;
    let skipCount    = 0;

    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        ui.write(`\n[${i + 1}/${rows.length}] Line ${row.lineNumber}...`);

        let fromWallet: Address;
        let toWallet: Address;

        try {
            fromWallet = await poolJettonMinter.getWalletAddress(row.fromOwner);
            toWallet   = await poolJettonMinter.getWalletAddress(row.toOwner);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            ui.write(`  ⚠️  Failed to resolve wallets: ${msg} — skipping.`);
            results.push({
                lineNumber: row.lineNumber,
                fromOwner: row.fromOwner.toString(),
                toOwner: row.toOwner.toString(),
                jettonAmount: row.jettonAmount.toString(),
                status: 'skipped',
                error: `Wallet resolution failed: ${msg}`,
            });
            skipCount++;
            continue;
        }

        ui.write(`  From wallet : ${fromWallet.toString()}`);
        ui.write(`  To wallet   : ${toWallet.toString()}`);
        ui.write(`  Amount      : ${row.jettonAmount} nanoJettons`);

        if (dryRun) {
            ui.write('  [DRY RUN] Skipping actual send.');
            results.push({
                lineNumber: row.lineNumber,
                fromOwner: row.fromOwner.toString(),
                toOwner: row.toOwner.toString(),
                jettonAmount: row.jettonAmount.toString(),
                status: 'skipped',
                error: 'dry-run',
            });
            skipCount++;
        } else {
            try {
                await pool.sendAdminTransferJettons(sender, {
                    value,
                    fromWallet,
                    toAddress: row.toOwner,
                    jettonAmount: row.jettonAmount,
                    responseAddress: sender.address!,
                    forwardTonAmount: row.forwardTonAmount,
                });
                ui.write('  ✅ Sent successfully.');
                results.push({
                    lineNumber: row.lineNumber,
                    fromOwner: row.fromOwner.toString(),
                    toOwner: row.toOwner.toString(),
                    jettonAmount: row.jettonAmount.toString(),
                    status: 'success',
                });
                successCount++;
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                ui.write(`  ❌ Failed: ${msg} — continuing.`);
                results.push({
                    lineNumber: row.lineNumber,
                    fromOwner: row.fromOwner.toString(),
                    toOwner: row.toOwner.toString(),
                    jettonAmount: row.jettonAmount.toString(),
                    status: 'failed',
                    error: msg,
                });
                failCount++;
            }
        }

        if (i < rows.length - 1 && delayMs > 0 && !dryRun) {
            ui.write(`  ⏳ Waiting ${delayMs}ms...`);
            await sleep(delayMs);
        }
    }

    // ── Step 5: Final report ──────────────────────────────────────────────────

    ui.write('\n==============================');
    ui.write('     BATCH TRANSFER REPORT    ');
    ui.write('==============================');
    ui.write(`  Total:     ${rows.length}`);
    ui.write(`  Success:   ${successCount}`);
    ui.write(`  Failed:    ${failCount}`);
    ui.write(`  Skipped:   ${skipCount}`);
    ui.write('==============================\n');

    const logFile = path.resolve(`batch_transfer_log_${Date.now()}.json`);
    fs.writeFileSync(logFile, JSON.stringify(results, null, 2), 'utf-8');
    ui.write(`📝 Log saved to: ${logFile}`);

    if (failCount > 0) {
        ui.write(`\n⚠️  ${failCount} transfer(s) failed. Check the log for details.`);
    }
}