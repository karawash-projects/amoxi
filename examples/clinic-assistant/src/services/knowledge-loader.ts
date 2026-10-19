import { Eager, PostConstruct, Singleton } from 'amoxi';
import { KnowledgeBases } from 'amoxi/ai';
import { POLICIES } from '../domain/clinic-data';

/** Name of the knowledge base the assistant searches (`knowledge: ['clinic']`). */
export const CLINIC_KB = 'clinic';

/**
 * Loads the clinic's policies into the 'clinic' knowledge base at startup. Each policy point is
 * its own small document, so a search returns one precise, citable passage.
 */
@Singleton()
@Eager()
export class KnowledgeLoader {
  constructor(private readonly knowledge: KnowledgeBases) {}

  @PostConstruct()
  load(): void {
    const docs = POLICIES.flatMap((p) => p.points.map((text, i) => ({ id: `${p.id}-${i + 1}`, title: p.title, url: `/policies#${p.id}`, text })));
    void this.knowledge.get(CLINIC_KB).ingest(docs);
  }
}
