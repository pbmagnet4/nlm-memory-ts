/**
 * Detects which surfaced recall IDs an assistant response cited.
 *
 * Substring match. Real session IDs (`cc_sub_a139f4ab...`, `cc_<uuid>`,
 * `hm_20260427_6ff562`) are unique enough that false positives from generic
 * text are not a concern at expected ID shapes. Short or generic IDs would
 * need a stricter regex; if those become common, add a length floor here.
 *
 * This is the training-data substrate for a future learned reranker:
 * every recall has a binary outcome (was_cited true/false). The signal is
 * unique to NLM's operator-as-user framing — competitors don't have it.
 */
export declare function detectCitedIds(responseText: string, surfacedIds: Iterable<string>): string[];
