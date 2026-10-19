// DECLARATIONS FOR THE `./core` ENTRY.
//
// src/public/core.mjs only NAMES what the engine already offers; these declarations NAME the same thing for a
// TypeScript consumer. Every signature is copied from the engine module the barrel re-exports
// (`../../engine/core/format.js`), and a symbol the barrel does not re-export is not declared here.

/**
 * The number a person entered, in units, or null when the text carries no number.
 *
 * A comma without a dot is the decimal separator ("0,05" is 0.05) and a comma beside a dot separates thousands
 * ("1,234.5" is 1234.5), so what the field shows and what the rest of the code computes cannot diverge.
 */
export declare function parseAmount(raw: string | number | null | undefined): number | null;

/**
 * ATOMIC UNITS -> A DECIMAL STRING. One XMR is 10^12 atomic units; the conversion uses BigInt, so a value above
 * 2^53 (about 9007 XMR in piconero) is not rounded. Dust does not vanish: 1 unit is "0.000000000001". `trim`
 * drops trailing zeros in the fraction; the result is always a plain decimal, never grouped.
 *
 * Throws a RangeError when the input is not a whole number of atomic units.
 */
export declare function formatXmr(atomic: bigint | number | string, options?: { readonly trim?: boolean }): string;

/**
 * A DECIMAL AMOUNT TYPED BY A PERSON -> ATOMIC UNITS, or null when the text is not an amount. A comma without a
 * dot is the decimal separator ("0,05"). More than twelve decimals is null: rounding an amount is a wrong payment
 * that looks successful.
 */
export declare function parseXmr(text: string | number | null | undefined): bigint | null;
