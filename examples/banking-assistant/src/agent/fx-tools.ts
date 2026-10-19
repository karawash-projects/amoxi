import { Singleton } from 'amoxi';
import { Tool } from 'amoxi/ai';
import { FxDesk, type FxDirection, type FxQuote } from '../bank/fx';

/**
 * Public, read-only market information. It needs no customer, so it is the one tool offered to
 * external AI agents over MCP (expose: true), e.g. a travel-planning assistant pricing a trip.
 */
@Singleton()
export class FxTools {
  constructor(private readonly fx: FxDesk) {}

  /** Quote a CAD to USD or USD to CAD currency exchange at the Demo Bank customer exchange rate, spread included. */
  @Tool({ readOnly: true, expose: true })
  quoteExchangeRate(input: {
    /**
     * Amount to convert, in cents of the currency being sold, e.g. 50000 for $500.00
     * @integer
     * @minimum 100
     * @maximum 100000000
     */
    amountCents: number;
    /** Which way to convert (default CAD to USD) */
    direction?: FxDirection;
  }): FxQuote {
    return this.fx.quote(input.direction ?? 'CAD to USD', input.amountCents);
  }
}
