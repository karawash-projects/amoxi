import { For, signal } from 'amoxi';
import type { OpsSnapshot, ShipmentView, VehicleView } from '../ops/ops-views';
import { dayLabel, hoursText, VEHICLE_KIND, VEHICLE_STATUS } from '../ui/labels';
import { liveSnapshot } from '../ui/live';

interface Props {
  part: 'kpis' | 'work' | 'alerts';
  snapshot: OpsSnapshot;
}

function Kpis(props: { snap: () => OpsSnapshot }) {
  const k = () => props.snap().kpis;
  return (
    <dl class="kpis" aria-label="Operations at a glance">
      <div class="kpi">
        <dt>Unassigned for {() => dayLabel(props.snap().tomorrow)}</dt>
        <dd>
          <span class="kpi-num">{() => k().tomorrowUnassigned}</span>
          <span class="kpi-of">of {() => k().tomorrowShipments} shipments</span>
        </dd>
      </div>
      <div class="kpi">
        <dt>Pallets tomorrow</dt>
        <dd>
          <span class="kpi-num">{() => k().tomorrowPallets}</span>
          <span class="kpi-of">across 3 depots</span>
        </dd>
      </div>
      <div class="kpi">
        <dt>Trucks on the road</dt>
        <dd>
          <span class="kpi-num">{() => k().onRoute}</span>
          <span class="kpi-of">
            {() => k().available} at depots, {() => k().outOfService} out of service
          </span>
        </dd>
      </div>
      <div class={() => (k().atRisk > 0 ? 'kpi kpi-warn' : 'kpi')}>
        <dt>On time today</dt>
        <dd>
          <span class="kpi-num">{() => `${k().onTimePct}%`}</span>
          <span class="kpi-of">{() => (k().atRisk > 0 ? `${k().atRisk} deliveries at risk` : 'no deliveries at risk')}</span>
        </dd>
      </div>
      <div class="kpi">
        <dt>Drivers texted</dt>
        <dd>
          <span class="kpi-num">{() => k().driversTexted}</span>
          <span class="kpi-of">route messages sent</span>
        </dd>
      </div>
      <div class={() => (k().openAlerts > 1 ? 'kpi kpi-warn' : 'kpi')}>
        <dt>Open alerts</dt>
        <dd>
          <span class="kpi-num">{() => k().openAlerts}</span>
          <span class="kpi-of">on the ops board</span>
        </dd>
      </div>
    </dl>
  );
}

function ShipmentRow(props: { s: ShipmentView }) {
  const s = props.s;
  return (
    <li class="ship">
      <div class="ship-main">
        <span class="ship-id">{s.id}</span>
        <span class="ship-place">{s.place}</span>
        {s.reefer ? (
          <span class="tag tag-reefer" title="Refrigerated">
            Reefer
          </span>
        ) : null}
      </div>
      <div class="ship-meta">
        <span>{s.customer}</span>
        <span class="ship-load">
          {s.pallets} plt, {s.weightKg.toLocaleString('en-CA')} kg
        </span>
        <span class="ship-window">{s.window}</span>
      </div>
    </li>
  );
}

function VehicleRow(props: { v: VehicleView }) {
  const v = props.v;
  const fill = Math.min(100, Math.round((v.palletsOnBoard / v.capacityPallets) * 100));
  const lowHours = v.cycleLeftMin < 480;
  return (
    <li class={`truck truck-${v.status}`}>
      <div class="truck-main">
        <span class="truck-id">{v.id}</span>
        <span class={`truck-status status-${v.status}`}>{VEHICLE_STATUS[v.status]}</span>
        <span class="truck-kind">{VEHICLE_KIND[v.kind]}</span>
      </div>
      <div class="truck-meta">
        <span class="truck-driver">{v.driver}</span>
        <span class={lowHours ? 'truck-hours low' : 'truck-hours'} title="Driving left today / left in the 70 h cycle">
          {hoursText(v.drivingLeftMin)} today, {hoursText(v.cycleLeftMin)} cycle
        </span>
      </div>
      <div class="truck-load">
        <span class="bar" aria-hidden="true">
          <span class="bar-fill" style={`width:${fill}%`} />
        </span>
        <span class="truck-cap">
          {v.palletsOnBoard}/{v.capacityPallets} plt
        </span>
        <span class="truck-loc">{v.location}</span>
      </div>
      {v.tomorrowPlan ? <span class="truck-plan">Tomorrow: {v.tomorrowPlan}</span> : null}
    </li>
  );
}

function Work(props: { snap: () => OpsSnapshot }) {
  const [depot, setDepot] = signal<string>('All');
  const depots = ['All', 'Toronto', 'Montreal', 'Ottawa'];
  const shipments = () => props.snap().unassigned.filter((s) => depot() === 'All' || s.depot === depot());
  const fleet = () => props.snap().fleet.filter((v) => depot() === 'All' || v.depot === depot());
  return (
    <div class="work">
      <div class="depot-filter" role="group" aria-label="Depot">
        {depots.map((d) => (
          <button type="button" class="seg" aria-pressed={() => (depot() === d ? 'true' : 'false')} onClick={() => setDepot(d)}>
            {d}
          </button>
        ))}
      </div>
      <section class="panel" aria-labelledby="unassigned-title">
        <header class="panel-head">
          <h2 id="unassigned-title">Unassigned, {() => dayLabel(props.snap().tomorrow)}</h2>
          <span class="count">
            {() => shipments().length} shipments, {() => shipments().reduce((n, s) => n + s.pallets, 0)} plt
          </span>
        </header>
        {() => (shipments().length === 0 ? <p class="empty">Everything for this depot is on a truck.</p> : null)}
        <ul class="ship-list">
          <For each={shipments} key={(s) => s.id}>
            {(s: ShipmentView) => <ShipmentRow s={s} />}
          </For>
        </ul>
      </section>
      <section class="panel" aria-labelledby="fleet-title">
        <header class="panel-head">
          <h2 id="fleet-title">Fleet</h2>
          <span class="count">{() => fleet().length} trucks</span>
        </header>
        <ul class="truck-list">
          <For each={fleet} key={(v) => `${v.id}:${v.status}:${v.palletsOnBoard}:${v.tomorrowPlan}:${v.location}`}>
            {(v: VehicleView) => <VehicleRow v={v} />}
          </For>
        </ul>
      </section>
    </div>
  );
}

function Alerts(props: { snap: () => OpsSnapshot }) {
  return (
    <section class="panel alerts" aria-labelledby="alerts-title">
      <header class="panel-head">
        <h2 id="alerts-title">Ops board</h2>
        <span class="count">{() => props.snap().alerts.length} alerts</span>
      </header>
      <ul class="alert-list">
        <For each={() => props.snap().alerts} key={(a) => a.id}>
          {(a: OpsSnapshot['alerts'][number]) => (
            <li class={`alert alert-${a.severity}`}>
              <p class="alert-title">
                <span class="sev">{a.severity === 'critical' ? 'Critical' : a.severity === 'warning' ? 'Warning' : 'Note'}</span>
                {a.title}
              </p>
              <p class="alert-body">{a.body}</p>
              {a.runId ? (
                <a class="alert-link" href={`/runs/${a.runId}`}>
                  Open the exception run
                </a>
              ) : null}
            </li>
          )}
        </For>
      </ul>
    </section>
  );
}

/** Live operations data for the console: KPI strip, tomorrow's work and fleet, or the ops board. */
export default function OpsBoard(props: Props) {
  const snap = liveSnapshot(props.snapshot);
  if (props.part === 'kpis') return <Kpis snap={snap} />;
  if (props.part === 'alerts') return <Alerts snap={snap} />;
  return <Work snap={snap} />;
}
