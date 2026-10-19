// Generates a synthetic app with N beans, compiles it with Amoxi AOT, and measures startup.
// Usage: node bench/startup-bench.mjs [beanCount=1000] [runs=7]
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const N = Number(process.argv[2] ?? 1000);
const RUNS = Number(process.argv[3] ?? 7);
const CONTROLLERS = Math.max(1, Math.floor(N / 20));
const app = join(root, 'bench', '.generated-app');

rmSync(app, { recursive: true, force: true });
mkdirSync(join(app, 'src', 'services'), { recursive: true });
// 'junction' works on Windows without admin rights; ignored on macOS/Linux.
symlinkSync(join(root, 'node_modules'), join(app, 'node_modules'), 'junction');
writeFileSync(
  join(app, 'tsconfig.json'),
  JSON.stringify({ extends: '../../tsconfig.base.json', compilerOptions: { rootDir: 'src', outDir: 'dist', types: ['node'], declaration: false, sourceMap: false }, include: ['src'] }),
);
writeFileSync(join(app, 'application.json'), JSON.stringify({ server: { port: 0, host: '127.0.0.1' } }));

// Service i depends on service i-1 and i/2, plus every 10th exposes an interface.
for (let i = 0; i < N; i++) {
  const deps = [...new Set([i - 1, Math.floor(i / 2)].filter((d) => d >= 0 && d < i))];
  const imports = deps.map((d) => `import { Service${d} } from './service${d}';`).join('\n');
  const iface = i % 10 === 0 ? `export interface Port${i} { work(): number }\n` : '';
  writeFileSync(
    join(app, 'src', 'services', `service${i}.ts`),
    `import { Singleton, Value } from 'amoxi';
${imports}
${iface}
@Singleton()
export class Service${i}${iface ? ` implements Port${i}` : ''} {
  constructor(${deps.map((d) => `private readonly s${d}: Service${d}, `).join('')}@Value('\${svc.factor:${i % 7}}') readonly factor: number) {}
  work(): number { return this.factor${deps.map((d) => ` + this.s${d}.factor`).join('')}; }
}
`,
  );
}
for (let c = 0; c < CONTROLLERS; c++) {
  const target = (c * 37) % N;
  writeFileSync(
    join(app, 'src', `controller${c}.ts`),
    `import { Controller, Get, PathParam } from 'amoxi';
import { Service${target} } from './services/service${target}';
@Controller('/c${c}')
export class Controller${c} {
  constructor(private readonly svc: Service${target}) {}
  @Get('/:id') get(@PathParam() id: number) { return { id, value: this.svc.work() }; }
}
`,
  );
}
writeFileSync(
  join(app, 'src', 'main.ts'),
  `import { AmoxiApplication } from 'amoxi';
import { applicationModule } from './generated/amoxi.generated';
AmoxiApplication.run(applicationModule, { shutdownHook: false }).then((a) => a.close());
`,
);

const time = (label, fn) => {
  const t = performance.now();
  fn();
  console.log(`${label.padEnd(28)} ${((performance.now() - t) / 1000).toFixed(2)}s`);
};
console.log(`\nSynthetic app: ${N} beans, ${CONTROLLERS} controllers/routes, ${N + CONTROLLERS + 1} source files\n`);
time('amoxi build (AOT analysis)', () => execFileSync('node', [join(root, 'packages/framework/dist/compiler/cli.js'), 'build'], { cwd: app, stdio: 'inherit' }));
time('tsc', () => execFileSync('node', [join(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'], { cwd: app, stdio: 'inherit' }));

function runOnce(extraArgs) {
  return new Promise((resolve, reject) => {
    const p = spawn('node', ['dist/main.js', ...extraArgs], { cwd: app });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('exit', () => {
      const m = /Startup completed in (\d+)ms \(framework: ([\d.]+)ms/.exec(out);
      m ? resolve({ total: Number(m[1]), framework: Number(m[2]) }) : reject(new Error(out));
    });
  });
}
const median = (xs) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];

async function measure(label, args) {
  const results = [];
  for (let i = 0; i < RUNS; i++) results.push(await runOnce(args));
  console.log(
    `${label.padEnd(44)} framework ${median(results.map((r) => r.framework)).toFixed(2).padStart(6)}ms | ` +
      `process start -> listening ${String(median(results.map((r) => r.total))).padStart(4)}ms`,
  );
}

console.log(`\nStartup (median of ${RUNS} runs):`);
await measure('lazy singletons (default)', []);
await measure(`eager: instantiate all ${N} beans`, ['--amoxi.eager-init=true']);

const t = performance.now();
execFileSync('node', ['-e', "require('http').createServer().listen(0,'127.0.0.1',function(){this.close()})"]);
console.log(`${'baseline: bare node:http server, no app'.padEnd(44)} ${' '.repeat(18)} total process ${(performance.now() - t).toFixed(0)}ms`);
