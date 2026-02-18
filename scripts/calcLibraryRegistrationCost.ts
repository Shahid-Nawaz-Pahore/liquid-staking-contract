import { Cell, fromNano, toNano } from '@ton/core';
import { compile, NetworkProvider } from '@ton/blueprint';
import { configParse18, loadConfigParamById } from '@ton/ton';

const DEFAULT_PAYMENT_PERIOD = 10n * 365n * 24n * 3600n;
const DEFAULT_MAX_CELLS = 2000;
const DEFAULT_CONTRACT = 'DAOJettonWallet';

type MaybeCell = Cell | null;

function computeDataSize(root: Cell, maxCells: number) {
    const visited = new Set<string>();
    const stack: Cell[] = [root];

    let bits = 0n;
    let cells = 0n;

    while (stack.length > 0) {
        const current = stack.pop()!;
        const hash = current.hash().toString('hex');
        if (visited.has(hash)) {
            continue;
        }

        visited.add(hash);
        cells += 1n;
        bits += BigInt(current.bits.length);

        if (cells > BigInt(maxCells)) {
            throw new Error(`Cell tree exceeds max_cells=${maxCells}. Increase max_cells.`);
        }

        for (const ref of current.refs) {
            stack.push(ref);
        }
    }

    return { cells, bits };
}

function pickLatestStoragePrice(prices: ReturnType<typeof configParse18>) {
    if (prices.length === 0) {
        throw new Error('Config param 18 returned no storage prices');
    }
    return prices.reduce((latest, current) => {
        return current.utime_since > latest.utime_since ? current : latest;
    });
}

async function fetchConfigParamFromJsonRpc(
    endpoint: string,
    configId: number,
    apiKey?: string,
): Promise<MaybeCell> {
    const body = {
        id: '1',
        jsonrpc: '2.0',
        method: 'getConfigParam',
        params: { config_id: configId },
    };

    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
    };
    if (apiKey) {
        headers['X-API-Key'] = apiKey;
    }

    const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
    });
    if (!response.ok) {
        throw new Error(`RPC getConfigParam(${configId}) failed with HTTP ${response.status}`);
    }

    const json = await response.json() as {
        ok?: boolean;
        result?: { config?: { bytes?: string } };
        error?: unknown;
    };

    if (!json.ok) {
        throw new Error(`RPC getConfigParam(${configId}) returned error: ${JSON.stringify(json.error)}`);
    }

    const bytes = json.result?.config?.bytes ?? '';
    if (!bytes) {
        return null;
    }
    return Cell.fromBase64(bytes);
}

async function loadConfigCellsFromProvider(api: any): Promise<{ cfg18: Cell; cfg75: MaybeCell; source: string }> {
    // TonClient4 path
    if (typeof api.getLastBlock === 'function' && typeof api.getConfig === 'function') {
        const lastBlock = await api.getLastBlock();
        const cfg = await api.getConfig(lastBlock.last.seqno);

        const cfg18 = loadConfigParamById(cfg.config.cell, 18);
        if (!cfg18) {
            throw new Error('Config param 18 not found');
        }
        const cfg75 = loadConfigParamById(cfg.config.cell, 75) ?? loadConfigParamById(cfg.config.cell, -75) ?? null;
        return { cfg18, cfg75, source: `TonClient4 seqno=${lastBlock.last.seqno}` };
    }

    // TonClient (toncenter jsonRPC) path
    const endpoint: string | undefined = api?.parameters?.endpoint;
    if (typeof endpoint === 'string' && endpoint.length > 0) {
        const apiKey: string | undefined = api?.api?.parameters?.apiKey;
        const cfg18 = await fetchConfigParamFromJsonRpc(endpoint, 18, apiKey);
        if (!cfg18) {
            throw new Error('Config param 18 returned empty cell');
        }

        // param 75 may be absent on some chains; default period must be used in that case
        let cfg75: MaybeCell = null;
        try {
            cfg75 = await fetchConfigParamFromJsonRpc(endpoint, 75, apiKey);
        } catch {
            cfg75 = null;
        }

        return { cfg18, cfg75, source: `TonClient jsonRPC (${endpoint})` };
    }

    throw new Error('Unsupported provider API type: cannot read config params 18/75');
}

export async function run(provider: NetworkProvider) {
    const ui = provider.ui();

    const contractInput = (await ui.input(`Contract name (default ${DEFAULT_CONTRACT}):`)).trim();
    const contractName = contractInput || DEFAULT_CONTRACT;

    const maxCellsInput = (await ui.input(`max_cells (default ${DEFAULT_MAX_CELLS}):`)).trim();
    const maxCells = maxCellsInput ? Number(maxCellsInput) : DEFAULT_MAX_CELLS;
    if (!Number.isInteger(maxCells) || maxCells <= 0) {
        throw new Error('max_cells must be a positive integer');
    }

    ui.write(`Compiling ${contractName}...`);
    const code = await compile(contractName);
    const { cells, bits } = computeDataSize(code, maxCells);

    const api = provider.api() as any;
    const { cfg18, cfg75, source } = await loadConfigCellsFromProvider(api);
    const latestStoragePrice = pickLatestStoragePrice(configParse18(cfg18.beginParse()));

    const paymentPeriod = cfg75 ? cfg75.beginParse().loadUintBig(64) : DEFAULT_PAYMENT_PERIOD;

    const bitPrice = latestStoragePrice.mc_bit_price_ps;
    const cellPrice = latestStoragePrice.mc_cell_price_ps;

    const minPayment = ((bitPrice * bits) + (cellPrice * cells)) * paymentPeriod >> 16n;
    const gasMargin = toNano('0.05');
    const recommended = minPayment + gasMargin;

    ui.write('');
    ui.write(`Contract: ${contractName}`);
    ui.write(`Code cells: ${cells.toString()}`);
    ui.write(`Code bits: ${bits.toString()}`);
    ui.write(`Storage price since: ${latestStoragePrice.utime_since}`);
    ui.write(`Config source: ${source}`);
    ui.write(`mc_bit_price_ps: ${bitPrice.toString()}`);
    ui.write(`mc_cell_price_ps: ${cellPrice.toString()}`);
    ui.write(`payment_period: ${paymentPeriod.toString()} sec`);
    ui.write('');
    ui.write(`Minimum required for register_library: ${minPayment} nanoTON (~${fromNano(minPayment)} TON)`);
    ui.write(`Recommended send (with gas margin): ${recommended} nanoTON (~${fromNano(recommended)} TON)`);
}
