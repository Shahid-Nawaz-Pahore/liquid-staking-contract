/*
 * TESTNET CHECKLIST
 * Before running: CONTROLLER_ADDRESS set or passed
 * After running:  compare with get_validator_controller_data, get_max_stake_value, request_window_time
 * Known issues:   warns about the known get_max_stake_value inversion bug when the staking window looks valid
 */

import { NetworkProvider } from '@ton/blueprint';
import {
    getControllerState,
    isLikelyValidStakingWindow,
    nowSeconds,
    printControllerSnapshot,
    resolveControllerAddress,
    warnIfKnownBug,
} from './scriptHelpers';

export async function run(provider: NetworkProvider) {
    const controllerAddress = await resolveControllerAddress(provider);
    const controller = await getControllerState(provider, controllerAddress);

    provider.ui().write(`🧭 Controller: ${controllerAddress.toString()}`);
    printControllerSnapshot(provider, controller);
    if (controller.requestWindow) {
        provider.ui().write(`🕒 Request window: since=${controller.requestWindow.since} until=${controller.requestWindow.until}`);
    }

    warnIfKnownBug(
        provider,
        controller.maxStakeValue === -1n && isLikelyValidStakingWindow(controller, nowSeconds()),
        '⚠️  KNOWN BUG: get_max_stake_value returned -1, this may be a getter inversion bug. Proceeding anyway — verify borrowing_time and utime_since manually before continuing.',
    );
}
