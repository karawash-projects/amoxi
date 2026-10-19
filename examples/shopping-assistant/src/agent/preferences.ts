import type { AgentMemory, MemoryItem } from 'amoxi/ai';

export interface PreferredSizes {
  footwear?: string;
  jackets?: string;
}

const LETTER = /\b(?:size\s+)?(XXL|XL|XS|S|M|L)\b(?!\w)/;
const WORD_SIZE: Record<string, string> = { small: 'S', medium: 'M', large: 'L', 'extra large': 'XL', 'extra-large': 'XL' };

/** Reads shoe and jacket sizes out of remembered facts ("I wear size 10 boots", "Jackets: medium"). */
export function sizesFrom(memories: readonly Pick<MemoryItem, 'text'>[]): PreferredSizes {
  const out: PreferredSizes = {};
  for (const { text } of memories) {
    const lower = text.toLowerCase();
    const shoe = lower.match(/(?:size|us)\s*(\d{1,2}(?:\.5)?)\b/);
    if (shoe && !out.footwear && Number(shoe[1]) >= 4 && Number(shoe[1]) <= 15) out.footwear = shoe[1];
    if (!out.jackets) {
      const word = Object.keys(WORD_SIZE).find((w) => lower.includes(w));
      const letter = text.match(LETTER);
      if (letter && /size|jacket|wear|shirt|top|hood|coat/i.test(text)) out.jackets = letter[1].toUpperCase();
      else if (word && /jacket|size|wear|top|coat/i.test(text)) out.jackets = WORD_SIZE[word];
    }
  }
  return out;
}

/** Everything remembered about a shopper (the hashing embedder ranks by word overlap, so ask broadly). */
export async function profile(memory: AgentMemory): Promise<MemoryItem[]> {
  return memory.recall('my size fit preference prefer wear boots shoes jacket insulation synthetic down budget trip', { limit: 8, minScore: -1 }).catch(() => []);
}
