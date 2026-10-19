import { Agent, type AgentRunContext } from 'amoxi/ai';
import { NoteTools } from './note-tools';

/** Answers questions about your notes and writes new ones. */
@Agent({
  tools: [NoteTools],
  ui: ['NoteList'],
  examples: ['Show my notes', 'Add a note "Buy coffee beans"'],
})
export class Assistant {
  instructions(ctx: AgentRunContext): string {
    return [
      'You are the assistant of a small notes app. Be brief and friendly.',
      'Use the tools to read and save notes; never invent notes.',
      `Today is ${ctx.now.toDateString()}.`,
    ].join('\n');
  }
}
