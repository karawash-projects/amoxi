import { Singleton, type Invocation, type MethodInterceptor } from 'amoxi';
import { money } from '../ui/format';
import { AuditLog, type AuditValue } from './audit-log';

const ACTIONS: Record<string, string> = { transfer: 'transfer', setCardFrozen: 'card.status' };

/**
 * AOP: every call to a money-moving method is written to the audit log, whether it succeeds or
 * is refused, with who asked, what they asked for and what happened. Nobody can forget to
 * audit a new code path, because the wrapping is generated at build time on the class itself.
 */
@Singleton()
export class AuditInterceptor implements MethodInterceptor {
  constructor(private readonly audit: AuditLog) {}

  intercept(invocation: Invocation): unknown {
    const request = (invocation.args[0] ?? {}) as Record<string, unknown>;
    const actor = typeof request.customerId === 'string' ? request.customerId : 'system';
    const action = ACTIONS[invocation.method] ?? `${invocation.bean}.${invocation.method}`;
    const data: Record<string, AuditValue> = {};
    for (const [k, v] of Object.entries(request)) {
      if (k !== 'customerId' && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) data[k] = v;
    }
    try {
      const result = invocation.proceed() as Record<string, unknown>;
      const ref = typeof result?.reference === 'string' ? result.reference : undefined;
      this.audit.append({ actor, action, outcome: 'ok', summary: describe(action, request, 'done'), data: { ...data, reference: ref } });
      return result;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.audit.append({ actor, action, outcome: 'refused', summary: `${describe(action, request, 'refused')}: ${reason}`, data });
      throw err;
    }
  }
}

function describe(action: string, r: Record<string, unknown>, what: 'done' | 'refused'): string {
  if (action === 'transfer') {
    const amount = typeof r.amountCents === 'number' ? money(r.amountCents) : '?';
    return `${what === 'done' ? 'Transferred' : 'Transfer refused'} ${amount} from ${String(r.fromAccountId)} to ${String(r.toAccountId)}`;
  }
  if (action === 'card.status') {
    const verb = r.frozen ? 'freeze' : 'unfreeze';
    return what === 'done' ? `Card ${String(r.cardId)}: ${verb}` : `Card ${verb} refused for ${String(r.cardId)}`;
  }
  return `${action} ${what}`;
}
