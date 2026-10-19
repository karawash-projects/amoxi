// Pure helpers shared by pages and islands (no Node APIs here: islands run in the browser).

export type Currency = 'CAD' | 'USD';

/** 123456 -> "$1,234.56"; USD amounts get a "US" prefix so the two currencies never blur. */
export function money(cents: number, currency: Currency = 'CAD', options: { sign?: boolean } = {}): string {
  const negative = cents < 0;
  const abs = Math.abs(Math.round(cents));
  const dollars = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const body = `${currency === 'USD' ? 'US$' : '$'}${dollars}.${String(abs % 100).padStart(2, '0')}`;
  if (negative) return `−${body}`;
  return options.sign && cents > 0 ? `+${body}` : body;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const LONG_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "2026-10-04" -> "Oct 4" (or "Oct 4, 2026" with the year). Timezone-proof: parses the string. */
export function shortDate(iso: string, withYear = false): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return iso;
  return `${MONTHS[m - 1]} ${d}${withYear ? `, ${y}` : ''}`;
}

/** "2026-10" -> "October 2026". */
export function monthLabel(yyyyMm: string): string {
  const [y, m] = yyyyMm.split('-').map(Number);
  return m ? `${LONG_MONTHS[m - 1]} ${y}` : yyyyMm;
}

/** "2026-10-18T14:03:22.120Z" -> "Oct 18, 14:03 UTC". */
export function stamp(iso: string): string {
  return `${shortDate(iso)}, ${iso.slice(11, 16)} UTC`;
}

export const CATEGORY_LABELS: Record<string, string> = {
  groceries: 'Groceries',
  dining: 'Dining',
  transport: 'Transport',
  housing: 'Housing',
  utilities: 'Utilities',
  shopping: 'Shopping',
  subscriptions: 'Subscriptions',
  travel: 'Travel',
  income: 'Income',
  transfers: 'Transfers',
};

export const categoryLabel = (c: string): string => CATEGORY_LABELS[c] ?? c;

/** Tool names as the customer reads them in the conversation. */
export const TOOL_LABELS: Record<string, [running: string, done: string, failed: string]> = {
  list_accounts: ['Reading your accounts', 'Read your accounts', 'Could not read your accounts'],
  recent_activity: ['Looking through your transactions', 'Looked through your transactions', 'Could not list transactions'],
  spending_by_category: ['Adding up your spending', 'Added up your spending', 'Could not add up spending'],
  transfer_between_accounts: ['Moving the money', 'Transfer posted', 'Transfer not made'],
  freeze_card: ['Freezing the card', 'Card frozen', 'Card not frozen'],
  unfreeze_card: ['Unfreezing the card', 'Card unfrozen', 'Card not unfrozen'],
  quote_exchange_rate: ['Getting an exchange quote', 'Got an exchange quote', 'No exchange quote'],
  search_knowledge: ['Searching Demo Bank policies', 'Searched Demo Bank policies', 'Policy search failed'],
  remember: ['Saving a note for next time', 'Saved a note for next time', 'Note not saved'],
};

/** Window event: balances or cards changed (the accounts panel refreshes). */
export const ACCOUNTS_CHANGED = 'demo-bank:accounts-changed';
