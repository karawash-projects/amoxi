import { Eager, PostConstruct, Singleton } from 'amoxi';
import { KnowledgeBases } from 'amoxi/ai';
import { POLICIES } from './policies';

/** Loads the policy documents into the 'fees' knowledge base when the app starts. */
@Singleton()
@Eager()
export class PolicyLibrary {
  /** Resolves once every document is chunked, embedded and indexed (tests await it). */
  ready: Promise<void> = Promise.resolve();

  constructor(private readonly knowledge: KnowledgeBases) {}

  @PostConstruct()
  load(): void {
    this.ready = this.knowledge
      .get('fees')
      .ingest(POLICIES)
      .then(() => undefined);
    this.ready.catch((err: unknown) => console.error('Failed to index the policy documents', err));
  }
}
