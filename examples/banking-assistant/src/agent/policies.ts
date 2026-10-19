import type { KnowledgeDocument } from 'amoxi/ai';

/**
 * Demo Bank's customer policies (fictional). Ingested into the 'fees' knowledge base at
 * startup; the assistant searches them instead of making up fees or rules.
 */
export const POLICIES: KnowledgeDocument[] = [
  {
    id: 'fee-schedule',
    title: 'Everyday banking fee schedule',
    url: '/rates#policy-fee-schedule',
    text: `Everyday banking fee schedule (effective 2026-01-01).
Everyday Chequing has a monthly account fee of $4.95, waived in any month the account keeps a minimum daily balance of $3,000 or receives a payroll deposit.
Debit purchases and transfers between your own Demo Bank accounts are free and unlimited.
E-transfers to other people: first 10 per month free, then $1.00 each.
Cash withdrawals at Demo Bank ATMs are free. Withdrawals at other Canadian ATMs cost $2.00 each; withdrawals outside Canada cost $5.00 plus the foreign transaction fee.
Paper statements cost $2.50 per month; e-statements are free.
A stop payment costs $12.50. A returned (NSF) item costs $48.00.
High Interest Savings and Tax-Free Savings Accounts have no monthly fee.`,
  },
  {
    id: 'foreign-transactions',
    title: 'Foreign transactions and currency exchange',
    url: '/rates#policy-foreign-transactions',
    text: `Foreign transactions and currency exchange.
The foreign transaction fee is 2.5% of the converted amount for any card purchase or ATM withdrawal made in a currency other than the card's account currency.
Purchases made with a card linked to the US Dollar Account in US dollars have no foreign transaction fee.
Currency exchange between your CAD and USD accounts uses the Demo Bank customer rate, which includes a spread of 1.5% from the mid-market rate. There is no separate commission.
Quotes are indicative and are locked when the exchange is booked. Rates are published on the Rates page and refreshed every business day.
Refunds of foreign purchases are converted at the rate on the refund date, so the amount returned may differ from the original charge.`,
  },
  {
    id: 'transfer-limits',
    title: 'Transfer limits and approvals',
    url: '/rates#policy-transfer-limits',
    text: `Transfer limits and approvals.
Transfers between your own accounts in online banking and the digital assistant are limited to $3,000.00 per transfer and $5,000.00 per business day in total.
Larger transfers can be made at a branch or by calling the contact centre after identity verification.
Every transfer requested through the digital assistant must be approved by you in the app before it runs; the assistant can never move money on its own.
Transfers between accounts in different currencies are booked as currency exchanges (see Foreign transactions and currency exchange).
Transfers between your own accounts post immediately and are available right away.`,
  },
  {
    id: 'card-replacement',
    title: 'Lost, stolen or damaged cards',
    url: '/rates#policy-card-replacement',
    text: `Lost, stolen or damaged cards.
If your card is lost or stolen, freeze it right away in online banking or with the digital assistant; a frozen card declines new purchases and withdrawals but pre-authorised payments continue.
Unfreeze it if you find it. If it is gone for good, order a replacement.
The first replacement card each year is free. Further replacements cost $10.00 each. Express delivery within 2 business days costs $25.00.
Standard delivery takes 5 to 7 business days to the address on file.
You are not responsible for unauthorised transactions made after you report the card lost or stolen, provided you protected your PIN.`,
  },
  {
    id: 'overdraft',
    title: 'Overdraft protection',
    url: '/rates#policy-overdraft',
    text: `Overdraft protection.
Overdraft protection is optional and must be requested. With it, Everyday Chequing can go up to $1,000 below zero.
The overdraft protection fee is $5.00 for each month in which you use it, plus overdraft interest of 21% a year on the overdrawn balance, calculated daily.
Without overdraft protection, a payment that would overdraw the account is returned and the NSF fee of $48.00 applies.
Transfers in the digital assistant never use overdraft: the source account must have enough funds.`,
  },
  {
    id: 'disputes',
    title: 'Disputing a transaction',
    url: '/rates#policy-disputes',
    text: `Disputing a transaction.
If you don't recognise a transaction, first check the merchant name in your transaction history, then contact us within 60 days of the statement date.
For card purchases, we open a dispute with the merchant's bank. You will receive a temporary credit within 10 business days while we investigate.
Most disputes are resolved within 45 days; we tell you the outcome in writing.
If you suspect fraud, freeze the card first, then report it. There is no fee to dispute a transaction.
If the dispute is not in your favour, the temporary credit is reversed with 5 business days' notice.`,
  },
  {
    id: 'savings-interest',
    title: 'Savings interest rates',
    url: '/rates#policy-savings-interest',
    text: `Savings interest rates (fictional, for this demo).
High Interest Savings earns 2.35% a year on the full balance, calculated daily and paid monthly.
The Tax-Free Savings Account earns 2.60% a year; contribution room is set by the government and over-contributions are taxed.
US Dollar Account balances earn 0.75% a year.
Everyday Chequing earns no interest.
Rates may change; changes are published on the Rates page at least 30 days in advance.`,
  },
  {
    id: 'security',
    title: 'How the digital assistant protects you',
    url: '/rates#policy-security',
    text: `How the digital assistant protects you.
The assistant only sees the accounts and cards of the signed-in customer. It never asks for your password, PIN, full card number or one-time codes; anyone who does is not Demo Bank.
Every transfer and every card freeze or unfreeze needs your explicit approval in the app.
Every action is written to a tamper-evident audit trail you can review in online banking.
Conversations are stored for 90 days to help with disputes, then deleted.`,
  },
];
