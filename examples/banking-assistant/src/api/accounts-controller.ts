import { Controller, Get, type RequestContext } from 'amoxi';
import { BankingTools, type AccountsResult } from '../agent/banking-tools';
import type { Customer } from '../bank/model';

/** JSON for the accounts panel, which refreshes itself after the assistant moves money. */
@Controller('/api')
export class AccountsController {
  constructor(private readonly banking: BankingTools) {}

  /** The signed-in customer's accounts, balances and cards. */
  @Get('/accounts')
  accounts(ctx: RequestContext): AccountsResult {
    const customer = ctx.state.customer as Customer;
    ctx.res.setHeader('cache-control', 'no-store');
    return this.banking.accounts(customer.id);
  }
}
