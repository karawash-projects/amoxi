import { Singleton } from 'amoxi';
import type { Customer } from './model';

const CUSTOMERS: readonly Customer[] = [
  {
    id: 'C-1001',
    name: 'Maya Vellandré',
    firstName: 'Maya',
    city: 'Montréal, QC',
    since: 2014,
    persona: 'Chequing, high-interest savings and a US-dollar account for trips south.',
  },
  {
    id: 'C-1002',
    name: 'Daniel Obrelle',
    firstName: 'Daniel',
    city: 'Calgary, AB',
    since: 2019,
    persona: 'Chequing, savings and a TFSA he tops up every payday.',
  },
  {
    id: 'C-1003',
    name: 'Priya Ravelund',
    firstName: 'Priya',
    city: 'Halifax, NS',
    since: 2009,
    persona: 'A long-time customer with a large savings balance and a US-dollar account.',
  },
];

/** The demo's customers. In production this is the bank's customer information file behind the IdP. */
@Singleton()
export class CustomerDirectory {
  all(): readonly Customer[] {
    return CUSTOMERS;
  }

  find(id: unknown): Customer | undefined {
    return typeof id === 'string' ? CUSTOMERS.find((c) => c.id === id) : undefined;
  }
}
