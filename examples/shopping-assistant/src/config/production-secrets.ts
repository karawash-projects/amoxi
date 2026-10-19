import { ApplicationContext, Eager, Singleton } from 'amoxi';

/**
 * Settings that hold secrets. During development they come from application-development.json, which
 * holds published demo values. That file isn't loaded in production, so each one must be set there,
 * usually as an environment variable: the key in capitals, dots as underscores, dashes left out
 * (ai.mcp.token is AI_MCP_TOKEN). `when` names a switch: the secret is only needed while it is on.
 */
const SECRETS: readonly { key: string; when?: string }[] = [
  { key: 'ai.mcp.token', when: 'ai.mcp.enabled' },
  { key: 'ai.a2a.token', when: 'ai.a2a.enabled' },
];

/** Words that only appear in the published demo values. */
const DEMO_VALUE = /demo|not-a-secret|not-for-production|replace-in-production/i;

/** Refuses to start in production while a secret is missing, too short, or still a demo value. */
@Singleton()
@Eager()
export class ProductionSecrets {
  constructor(context: ApplicationContext) {
    const config = context.config;
    if (!config.isProduction) return;
    const problems: string[] = [];
    for (const { key, when } of SECRETS) {
      if (when && !config.boolean(when, 'false')) continue;
      const value = config.has(key) ? config.string(key) : '';
      const env = key.toUpperCase().replace(/\./g, '_').replace(/-/g, '');
      if (value.length < 16) problems.push(`${key} is not set or shorter than 16 characters (set ${env})`);
      else if (DEMO_VALUE.test(value)) problems.push(`${key} still has a published demo value (set ${env} to a real secret)`);
    }
    if (problems.length > 0) throw new Error(`Refusing to start in production:\n  - ${problems.join('\n  - ')}`);
  }
}
