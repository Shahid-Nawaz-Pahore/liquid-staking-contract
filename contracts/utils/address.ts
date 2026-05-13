import { Address } from 'ton-core';

/**
 * Ensures that the input is properly parsed as an Address object
 * @param a - Address, string, or null input
 * @returns Address object or null
 */
export function ensureAddress(a: Address | string | null): Address | null {
    if (a === null) return null;
    if (typeof a === 'string') return Address.parse(a);
    return a;
}

/**
 * Safely parses an address string, returns null if invalid
 * @param addressStr - String representation of address
 * @returns Address object or null if invalid
 */
export function safeParseAddress(addressStr: string): Address | null {
    try {
        return Address.parse(addressStr);
    } catch (error) {
        console.warn(`Failed to parse address: ${addressStr}`, error);
        return null;
    }
}
