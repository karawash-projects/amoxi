import { Controller, Island, Page } from 'amoxi';
import Assistant from '../islands/Assistant';
import { Layout } from '../ui/layout';

@Controller()
export class AssistantPage {
  @Page('/assistant')
  assistant() {
    return (
      <Layout title="Assistant" active="assistant">
        <div class="split">
          <section class="intro">
            <h1>Assistant</h1>
            <p>
              An AI agent with tools from <code>src/agent/</code>. Without an API key it uses Amoxi's offline demo model; put{' '}
              <code>ANTHROPIC_API_KEY</code> or <code>OPENAI_API_KEY</code> in <code>.env</code> to use a real one.
            </p>
            <p>
              Agents also answer over HTTP: <code>POST /agents/assistant/runs</code>.
            </p>
          </section>
          <Island of={Assistant} examples={['Show my notes', 'Add a note "Buy coffee beans"']} />
        </div>
      </Layout>
    );
  }
}
