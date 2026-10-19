import { Singleton } from 'amoxi';
import { Tool, type ToolContext } from 'amoxi/ai';
import type { Note } from '../notes/note';
import { NoteService } from '../notes/note-service';

/**
 * Tools the assistant can call. Their JSON Schemas and argument validators are generated at
 * build time from the parameter types and JSDoc, like request-body validation.
 */
@Singleton()
export class NoteTools {
  constructor(private readonly notes: NoteService) {}

  /** List the saved notes, newest first, and show them as cards. */
  @Tool({ readOnly: true })
  listNotes(_input: {}, ctx: ToolContext): { notes: Note[] } {
    const notes = this.notes.list();
    ctx.ui('NoteList', { title: 'Your notes', notes });
    return { notes };
  }

  @Tool('Save a new note with the given text')
  addNote(input: {
    /**
     * What to write down, e.g. "Buy coffee beans"
     * @minLength 1
     * @maxLength 280
     */
    content: string;
  }): Note {
    return this.notes.add({ text: input.content });
  }
}
