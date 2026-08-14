const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for", "of", "with",
  "by", "from", "is", "are", "was", "were", "be", "been", "being", "have", "has", "had",
  "do", "does", "did", "will", "would", "could", "should", "may", "might", "can",
  "this", "that", "these", "those", "it", "its", "i", "you", "he", "she", "we", "they",
  "what", "which", "who", "whom", "where", "when", "why", "how",
  "расскажи", "рассказать", "про", "что", "как", "где", "когда", "можешь", "можете",
  "проверь", "проверить", "документ", "найди", "найти", "покажи", "показать",
  "об", "обо", "это", "этот", "эта", "эти", "мне", "меня", "тебе", "нас", "вас",
  "ли", "же", "бы", "not", "no", "yes", "please", "about", "tell", "show", "find",
  "check", "document", "file", "doc",
]);

export function normalizeSearchQuery(query: string): string {
  return query.trim().slice(0, 500);
}

export function extractSearchTerms(query: string): string[] {
  const normalized = normalizeSearchQuery(query).toLowerCase();
  const rawTerms = normalized.split(/[^a-zA-Z0-9\u0400-\u04FF]+/).filter(Boolean);
  const terms = rawTerms.filter((term) => term.length > 1 && !STOP_WORDS.has(term));

  const quoted = normalized.match(/"([^"]+)"/g)?.map((q) => q.replace(/"/g, "")) ?? [];
  const combined = [...quoted, ...terms];
  return [...new Set(combined)].slice(0, 12);
}

export function scoreChunkContent(content: string, query: string, terms: string[]): number {
  const hay = content.toLowerCase();
  const queryLower = query.toLowerCase();

  if (hay.includes(queryLower)) return 1;

  if (!terms.length) return hay.includes(queryLower) ? 0.5 : 0;

  let hits = 0;
  for (const term of terms) {
    if (hay.includes(term)) hits += 1;
  }
  return hits / terms.length;
}

export function scoreFilename(filename: string, query: string, terms: string[]): number {
  const name = filename.toLowerCase();
  const queryLower = query.toLowerCase();

  if (name === queryLower) return 1;
  if (name.includes(queryLower)) return 0.85;

  if (!terms.length) return 0;

  let hits = 0;
  for (const term of terms) {
    if (name.includes(term)) hits += 1;
  }
  return (hits / terms.length) * 0.7;
}

export function combineRankScore(input: {
  ftsRank: number;
  filenameScore: number;
  contentScore: number;
  isProjectScoped?: boolean;
}): number {
  let score = input.ftsRank * 0.5 + input.filenameScore * 0.35 + input.contentScore * 0.25;
  if (input.isProjectScoped) score += 0.05;
  return score;
}
