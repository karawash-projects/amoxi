import { PostConstruct, Singleton, Value } from 'amoxi';
import type { NewNote, Note } from './note';

/** Keeps notes in memory. Replace with a database-backed service when you need persistence. */
@Singleton()
export class NoteService {
  private readonly notes: Note[] = [];
  private nextId = 1;

  constructor(private readonly max: Value<number, 'notes.max', 100>) {}

  @PostConstruct()
  seed(): void {
    this.add({ text: 'Welcome to Amoxi. Edit a file in src/ and save to see it update.' });
  }

  list(): Note[] {
    return [...this.notes].reverse();
  }

  add(input: NewNote): Note {
    if (this.notes.length >= this.max) this.notes.shift();
    const note: Note = { id: this.nextId++, text: input.text.trim(), createdAt: new Date().toISOString() };
    this.notes.push(note);
    return note;
  }
}
