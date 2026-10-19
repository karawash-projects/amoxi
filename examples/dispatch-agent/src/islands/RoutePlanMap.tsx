import { signal } from 'amoxi';
import { HIGHWAYS, RIVERS, WATER } from '../domain/geography';
import { dayLabel, hoursText, plural } from '../ui/labels';

interface Stop {
  shipmentId: string;
  place: string;
  customer: string;
  lat: number;
  lon: number;
  eta: string;
  late: boolean;
}

interface Route {
  vehicleId: string;
  driver: string;
  kind: string;
  km: number;
  durationMin: number;
  limitMin: number;
  pallets: number;
  capacityPallets: number;
  stops: Stop[];
}

interface Held {
  shipmentId: string;
  place: string;
  lat: number;
  lon: number;
  reason: string;
}

export const ROUTE_COLORS = ['#0B6E8A', '#C2571A', '#6B4FA3', '#2E8540', '#B8336A', '#8A6D00', '#3A5BA0', '#7A4E2D'];

const W = 640;

/** @generative Shows a route plan on a schematic map: the depot, every stop, one coloured route per truck, held stops, and per-route hours and load */
export default function RoutePlanMap(props: {
  planId: string;
  depot: { name: string; yard: string; lat: number; lon: number };
  date: string;
  totalKm: number;
  savedKm: number;
  routes: Route[];
  held: Held[];
}) {
  const [focus, setFocus] = signal<string | undefined>(undefined);

  // Equirectangular projection fitted to the depot and every stop, with a margin.
  const pts = [props.depot, ...props.routes.flatMap((r) => r.stops), ...props.held];
  let minLat = Math.min(...pts.map((p) => p.lat));
  let maxLat = Math.max(...pts.map((p) => p.lat));
  let minLon = Math.min(...pts.map((p) => p.lon));
  let maxLon = Math.max(...pts.map((p) => p.lon));
  const padLat = Math.max(0.06, (maxLat - minLat) * 0.12);
  const padLon = Math.max(0.08, (maxLon - minLon) * 0.1);
  minLat -= padLat;
  maxLat += padLat;
  minLon -= padLon;
  maxLon += padLon;
  const kx = Math.cos(((minLat + maxLat) / 2) * (Math.PI / 180));
  const lonSpan = (maxLon - minLon) * kx;
  const latSpan = maxLat - minLat;
  // Fit both axes: the height follows the region's shape within limits, the content is centred.
  const H = Math.round(Math.min(480, Math.max(300, (latSpan / lonSpan) * W)));
  const scale = Math.min(W / lonSpan, H / latSpan);
  const xOff = (W - lonSpan * scale) / 2;
  const yOff = (H - latSpan * scale) / 2;
  const x = (lon: number): number => Math.round(((lon - minLon) * kx * scale + xOff) * 10) / 10;
  const y = (lat: number): number => Math.round(((maxLat - lat) * scale + yOff) * 10) / 10;
  const path = (line: ReadonlyArray<readonly [number, number]>): string => line.map(([la, lo], i) => `${i ? 'L' : 'M'}${x(lo)} ${y(la)}`).join(' ');
  const kmPerPx = 111.32 / scale;
  const scaleKm = [10, 20, 25, 50, 100].find((k) => k / kmPerPx > 70) ?? 100;

  const color = (i: number): string => ROUTE_COLORS[i % ROUTE_COLORS.length];
  const dim = (id: string) => () => (focus() && focus() !== id ? 'route dim' : 'route');
  const late = props.routes.flatMap((r) => r.stops).filter((s) => s.late).length;
  const summary = `${plural(props.routes.length, 'route')}, ${props.totalKm.toLocaleString('en-CA')} km${props.held.length ? `, ${props.held.length} held` : ''}${late ? `, ${plural(late, 'window')} at risk` : ''}`;

  return (
    <article class="plan-map" aria-label={`Route plan ${props.planId}`}>
      <header class="plan-head">
        <div>
          <h3>
            Route plan <span class="plan-id">{props.planId}</span>
          </h3>
          <p>
            {props.depot.name} depot, {dayLabel(props.date)}: {summary}
          </p>
        </div>
        {props.savedKm > 0 ? <p class="plan-saved">2-opt saved {props.savedKm} km</p> : null}
      </header>
      <div class="plan-body">
        <svg class="map" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Map of ${props.routes.length} routes from the ${props.depot.name} depot`}>
          <rect class="land" x="0" y="0" width={W} height={H} />
          {WATER.map((w) => (
            <path class="water" d={`${path(w.points)} Z`} />
          ))}
          {RIVERS.map((r) => (
            <path class="river" d={path(r.points)} />
          ))}
          {HIGHWAYS.map((h) => (
            <path class="hwy" d={path(h.points)} />
          ))}
          {props.routes.map((r, i) => (
            <g class={dim(r.vehicleId)} style={`--c:${color(i)}`}>
              <path class="route-line" d={`M${x(props.depot.lon)} ${y(props.depot.lat)} ${r.stops.map((s) => `L${x(s.lon)} ${y(s.lat)}`).join(' ')} L${x(props.depot.lon)} ${y(props.depot.lat)}`} />
              {r.stops.map((s, n) => (
                <g class={s.late ? 'stop late' : 'stop'} transform={`translate(${x(s.lon)} ${y(s.lat)})`}>
                  <title>{`${n + 1}. ${s.place} (${s.shipmentId}), ETA ${s.eta}${s.late ? ', window at risk' : ''}`}</title>
                  <circle r="8" />
                  <text dy="3.2">{n + 1}</text>
                  {() => (focus() === r.vehicleId ? <text class="stop-label" x="11" dy="3.5">{s.place}</text> : null)}
                </g>
              ))}
            </g>
          ))}
          {props.held.map((h) => (
            <g class="held" transform={`translate(${x(h.lon)} ${y(h.lat)})`}>
              <title>{`Held: ${h.place} (${h.shipmentId}). ${h.reason}`}</title>
              <path d="M0 -8 8 0 0 8 -8 0Z" />
              <text dy="3.5">!</text>
              <text class="stop-label" x="11" dy="3.5">
                {h.place}
              </text>
            </g>
          ))}
          <g class="depot" transform={`translate(${x(props.depot.lon)} ${y(props.depot.lat)})`}>
            <title>{`${props.depot.name} depot, ${props.depot.yard}`}</title>
            <rect x="-9" y="-9" width="18" height="18" rx="2" />
            <path d="M-4.5 3V-1.5L0-4.5 4.5-1.5V3Z" />
            <text class="depot-label" x="13" dy="4">
              {props.depot.name} depot
            </text>
          </g>
          <g class="scale" transform={`translate(${W - 20 - scaleKm / kmPerPx} ${H - 18})`}>
            <path d={`M0 0H${(scaleKm / kmPerPx).toFixed(1)}`} />
            <path d={`M0 -4V0M${(scaleKm / kmPerPx).toFixed(1)} -4V0`} />
            <text x={(scaleKm / kmPerPx / 2).toFixed(1)} dy="-6">
              {scaleKm} km
            </text>
          </g>
        </svg>
        <div class="plan-side">
          <ul class="route-legend">
            {props.routes.map((r, i) => (
              <li>
                <button
                  type="button"
                  class="legend-row"
                  style={`--c:${color(i)}`}
                  aria-pressed={() => (focus() === r.vehicleId ? 'true' : 'false')}
                  onClick={() => setFocus(focus() === r.vehicleId ? undefined : r.vehicleId)}
                >
                  <span class="swatch" aria-hidden="true" />
                  <span class="legend-main">
                    <span class="legend-id">{r.vehicleId}</span>
                    <span class="legend-driver">{r.driver}</span>
                  </span>
                  <span class="legend-stats">
                    {plural(r.stops.length, 'stop')}, {r.km} km
                  </span>
                  <span class="meter" title={`On duty ${hoursText(r.durationMin)} of ${hoursText(r.limitMin)} allowed`}>
                    <span class="meter-label">Hours</span>
                    <span class="meter-track">
                      <span class={r.durationMin / r.limitMin > 0.9 ? 'meter-fill hot' : 'meter-fill'} style={`width:${Math.min(100, Math.round((r.durationMin / r.limitMin) * 100))}%`} />
                    </span>
                    <span class="meter-val">{hoursText(r.durationMin)}</span>
                  </span>
                  <span class="meter" title={`${r.pallets} of ${r.capacityPallets} pallets`}>
                    <span class="meter-label">Load</span>
                    <span class="meter-track">
                      <span class="meter-fill" style={`width:${Math.min(100, Math.round((r.pallets / r.capacityPallets) * 100))}%`} />
                    </span>
                    <span class="meter-val">
                      {r.pallets}/{r.capacityPallets} plt
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {() => {
            const r = props.routes.find((x) => x.vehicleId === focus());
            if (!r) return <p class="legend-hint">Select a truck to see its stops in order.</p>;
            return (
              <ol class="stop-list" aria-label={`Stops for ${r.vehicleId}`}>
                {r.stops.map((s) => (
                  <li class={s.late ? 'late' : ''}>
                    <span class="eta">{s.eta}</span>
                    <span class="stop-place">{s.place}</span>
                    <span class="stop-cust">
                      {s.customer}, {s.shipmentId}
                    </span>
                    {s.late ? <span class="tag tag-warn">Window at risk</span> : null}
                  </li>
                ))}
              </ol>
            );
          }}
          {props.held.length > 0 ? (
            <div class="held-list">
              <h4>Held for the dispatcher</h4>
              <ul>
                {props.held.map((h) => (
                  <li>
                    <strong>
                      {h.shipmentId} {h.place}
                    </strong>
                    <span>{h.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </div>
    </article>
  );
}
