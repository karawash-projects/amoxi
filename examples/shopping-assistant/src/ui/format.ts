/** Pure formatting helpers shared by pages and islands (browser-safe). */

/** 42900 -> "$429.00" (Canadian dollars). */
export function money(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.round(cents));
  const dollars = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}$${dollars}.${String(abs % 100).padStart(2, '0')}`;
}

/** 1620 -> "1.62 kg", 360 -> "360 g". */
export function weight(grams: number): string {
  return grams >= 1000 ? `${(grams / 1000).toFixed(2)} kg` : `${grams} g`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-10-18..." -> "18 Oct 2026" (UTC, so server and browser agree). */
export function day(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export function stockText(stock: number): string {
  if (stock <= 0) return 'Out of stock';
  if (stock <= 3) return `Only ${stock} left`;
  return 'In stock';
}

export const CATEGORY_NAMES: Record<string, string> = {
  tents: 'Tents',
  'sleeping-bags': 'Sleeping bags',
  jackets: 'Jackets',
  footwear: 'Footwear',
};
