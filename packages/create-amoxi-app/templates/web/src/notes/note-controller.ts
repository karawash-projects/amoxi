import { Body, Controller, Get, HttpResponse, Post } from 'amoxi';
import type { NewNote, Note } from './note';
import { NoteService } from './note-service';

@Controller('/api/notes')
export class NoteController {
  constructor(private readonly notes: NoteService) {}

  @Get()
  list(): Note[] {
    return this.notes.list();
  }

  // Invalid bodies are rejected with a 400 listing every problem before this runs.
  @Post()
  create(@Body() body: NewNote): HttpResponse<Note> {
    return HttpResponse.created(this.notes.add(body));
  }
}
