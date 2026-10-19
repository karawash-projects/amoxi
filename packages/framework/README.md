# amoxi

A full-stack TypeScript framework for Node.js: compile-time dependency injection (like Micronaut), server-rendered JSX pages with interactive islands (signal-based or React), and production-ready HTTP built in.

## Get started

```bash
npx create-amoxi-app@latest my-app
cd my-app
npm run dev
```

Then open http://localhost:8080. Requires Node.js 22 or newer; works on Windows, macOS and Linux, with no environment variables to set.

## A taste

```tsx
@Controller()
export class HomePage {
  constructor(private readonly notes: NoteService) {}      // injected at build time

  @Page('/')
  home() {
    return (
      <Layout title="Home">
        <h1>Notes</h1>
        <Island of={AddNote} />                              {/* only islands ship JavaScript */}
      </Layout>
    );
  }
}
```

Commands (in an app): `amoxi dev`, `amoxi build`, `amoxi start`, `amoxi export`.

Full documentation: [karawash-projects.github.io/amoxi/docs](https://karawash-projects.github.io/amoxi/docs/). The same guide is in the [project README](https://github.com/karawash-projects/amoxi#readme), and the [project website](https://karawash-projects.github.io/amoxi/) shows four example apps.
