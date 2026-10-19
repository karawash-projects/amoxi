/** Startup figures from `npm run bench` (1,000 services, median of 7 runs). Update after re-running it. */
export const BENCH = {
  beans: 1000,
  lazyMs: 10.7,
  eagerMs: 33.7,
  aotSeconds: 2.1,
  runs: 7,
};

const MAX = 50; // ms shown on the ruler
const W = 1000;
const x = (ms: number): number => (ms / MAX) * W;

/**
 * A millisecond ruler from 0 to 50 ms with the measured framework start-up times marked on it.
 * Labels and explanations are HTML next to it, so they stay readable on small screens.
 */
export function StartupRuler() {
  const ticks: unknown[] = [];
  for (let ms = 0; ms <= MAX; ms++) {
    const major = ms % 10 === 0;
    const mid = !major && ms % 5 === 0;
    ticks.push(<line x1={x(ms)} x2={x(ms)} y1={60} y2={major ? 84 : mid ? 76 : 70} class={major ? 'tick major' : 'tick'} />);
    if (major) {
      ticks.push(
        <text x={x(ms)} y={104} class="tick-label" text-anchor={ms === 0 ? 'start' : ms === MAX ? 'end' : 'middle'}>
          {ms === MAX ? `${ms} ms` : String(ms)}
        </text>,
      );
    }
  }
  return (
    <figure class="ruler">
      <svg viewBox={`0 0 ${W} 110`} role="img" aria-labelledby="ruler-title">
        <title id="ruler-title">
          Framework start-up with {BENCH.beans.toLocaleString('en-US')} services: {BENCH.lazyMs} milliseconds when services are created on demand,{' '}
          {BENCH.eagerMs} milliseconds when all are created at start-up.
        </title>
        <rect class="ruler-track" x={0} y={44} width={W} height={16} />
        <rect class="ruler-eager" x={0} y={44} width={x(BENCH.eagerMs)} height={16} />
        <rect class="ruler-lazy" x={0} y={44} width={x(BENCH.lazyMs)} height={16} />
        {ticks}
        <line class="ruler-marker" x1={x(BENCH.lazyMs)} x2={x(BENCH.lazyMs)} y1={14} y2={60} />
        <text class="ruler-value" x={x(BENCH.lazyMs) + 8} y={30}>
          {BENCH.lazyMs} ms
        </text>
        <line class="ruler-marker eager" x1={x(BENCH.eagerMs)} x2={x(BENCH.eagerMs)} y1={14} y2={60} />
        <text class="ruler-value eager" x={x(BENCH.eagerMs) + 8} y={30}>
          {BENCH.eagerMs} ms
        </text>
      </svg>
      <figcaption>
        <dl class="ruler-legend">
          <div>
            <dt>
              <span class="swatch lazy" aria-hidden="true" />
              {BENCH.lazyMs} ms
            </dt>
            <dd>Framework ready with {BENCH.beans.toLocaleString('en-US')} services, each created when first used</dd>
          </div>
          <div>
            <dt>
              <span class="swatch eager" aria-hidden="true" />
              {BENCH.eagerMs} ms
            </dt>
            <dd>The same app with all {BENCH.beans.toLocaleString('en-US')} services created at start-up</dd>
          </div>
        </dl>
        <p class="ruler-note">
          Median of {BENCH.runs} runs of <code>npm run bench</code> on Node 22, measured from the start of the framework to the server
          accepting requests. Node.js loading your compiled code comes on top and grows with the size of the app. Run the benchmark on
          your own hardware to compare.
        </p>
      </figcaption>
    </figure>
  );
}
