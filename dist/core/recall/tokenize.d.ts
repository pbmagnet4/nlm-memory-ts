/**
 * Tokenizer mirrors recall.py:_TOKEN_RE. Identical regex, lowercase normalize.
 * Pure function. The keyword scorer's parity with the Python implementation
 * starts here.
 */
export declare function tokenize(text: string | null | undefined): ReadonlyArray<string>;
export declare function tokenSet(text: string | null | undefined): Set<string>;
