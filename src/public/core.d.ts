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
