import { clock } from '../ui/labels';

interface Affected {
  shipmentId: string;
  customer: string;
  place: string;
  window: string;
  pallets: number;
  refrigerated: boolean;
  projectedArrival: string;
  risk: 'late' | 'tight' | 'ok';
}

interface Option {
  vehicleId: string;
  driver: string;
  kind: string;
  location: string;
  distanceKm: number;
  reachMinutes: number;
  sparePallets: number;
  drivingLeft: string;
}

const TYPE_LABEL: Record<string, string> = { breakdown: 'Breakdown', delay: 'Delay', temperature_alarm: 'Reefer temperature alarm' };
const RISK_LABEL: Record<string, string> = { late: 'Will miss window', tight: 'Tight', ok: 'On time' };

/** @generative Shows a vehicle incident: what happened and where, the shipments on board with projected arrival and window risk, and the recommended recovery truck */
export default function IncidentBrief(props: {
  vehicleId: string;
  driver: string;
  type: 'breakdown' | 'delay' | 'temperature_alarm';
  location: string;
  reportedAt: string;
  affected: Affected[];
  recommendation: Option | null;
  alternatives: Option[];
  nextStep: string;
}) {
  const pallets = props.affected.reduce((n, a) => n + a.pallets, 0);
  const atRisk = props.affected.filter((a) => a.risk !== 'ok').length;
  return (
    <article class={`incident incident-${props.type}`} aria-label={`Incident brief for ${props.vehicleId}`}>
      <header class="incident-head">
        <svg class="incident-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 3 2.5 20h19Z" />
          <path d="M12 10v4.5M12 17v.5" />
        </svg>
        <div>
          <h3>
            {TYPE_LABEL[props.type]}: {props.vehicleId}
          </h3>
          <p>
            {props.driver}, {props.location}, reported {clock(props.reportedAt)}
          </p>
        </div>
        <p class="incident-tally">
          <strong>{props.affected.length}</strong> shipments, <strong>{pallets}</strong> pallets, <strong>{atRisk}</strong> at risk
        </p>
      </header>
      {props.affected.length > 0 ? (
        <table class="incident-table">
          <caption class="visually-hidden">Shipments on {props.vehicleId}</caption>
          <thead>
            <tr>
              <th scope="col">Shipment</th>
              <th scope="col">Deliver to</th>
              <th scope="col">Window</th>
              <th scope="col">Projected</th>
              <th scope="col">Risk</th>
            </tr>
          </thead>
          <tbody>
            {props.affected.map((a) => (
              <tr>
                <td class="num">{a.shipmentId}</td>
                <td>
                  {a.customer}, {a.place}
                  {a.refrigerated ? <span class="tag tag-reefer">Reefer</span> : null}
                </td>
                <td class="num">{a.window}</td>
                <td class="num">{a.projectedArrival}</td>
                <td>
                  <span class={`risk risk-${a.risk}`}>{RISK_LABEL[a.risk]}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p class="empty">No freight on board is affected.</p>
      )}
      {props.recommendation ? (
        <div class="recovery">
          <h4>Recommended recovery truck</h4>
          <p class="recovery-main">
            <span class="recovery-id">{props.recommendation.vehicleId}</span> {props.recommendation.driver}, {props.recommendation.kind} at {props.recommendation.location}
          </p>
          <p class="recovery-meta">
            {props.recommendation.distanceKm} km away (about {props.recommendation.reachMinutes} min), {props.recommendation.sparePallets} pallets free, {props.recommendation.drivingLeft} of driving left
          </p>
          {props.alternatives.length > 0 ? (
            <p class="recovery-alt">Also possible: {props.alternatives.map((a) => `${a.vehicleId} (${a.distanceKm} km)`).join(', ')}</p>
          ) : null}
        </div>
      ) : null}
      <p class="incident-next">{props.nextStep}</p>
    </article>
  );
}
