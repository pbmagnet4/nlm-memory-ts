const STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "dare", "ought",
  "yes", "no", "not", "please", "thank", "thanks", "ok", "okay",
  "i", "me", "my", "we", "us", "our", "you", "your", "it", "its",
  "this", "that", "these", "those", "and", "or", "but", "if", "so",
  "to", "of", "in", "on", "at", "by", "for", "from", "with", "about",
  "into", "through", "during", "before", "after", "above", "below",
  "up", "down", "out", "off", "over", "under", "again", "further",
  "then", "once", "here", "there", "when", "where", "why", "how",
  "all", "both", "each", "few", "more", "most", "other", "some", "such",
  "than", "too", "very", "just", "now", "also", "get", "let",
  "what", "which", "who", "whom", "whose", "any", "much", "many",
  "sounds", "good", "great", "sure",
  "right", "well", "done", "nice", "cool", "perfect", "exactly",
  "proceed", "continue", "go", "ahead", "next", "help",
]);

const MIN_CONTENT_WORDS = 2;
const MIN_WORD_LEN = 3;

/**
 * Extract content words from a prompt for use as an FTS5 recall query.
 * Returns null when the message is too conversational to produce a useful
 * query — the caller should skip recall entirely in that case.
 */
export function extractRecallQuery(prompt: string): string | null {
  const tokens = prompt
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/^[^\w-]+|[^\w-]+$/g, ""))
    .filter((t) => t.length >= MIN_WORD_LEN);

  const contentWords = tokens.filter((t) => !STOPWORDS.has(t.toLowerCase()));

  if (contentWords.length < MIN_CONTENT_WORDS) return null;
  return contentWords.join(" ");
}
