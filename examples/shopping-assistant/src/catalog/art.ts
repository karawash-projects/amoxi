import type { Product, Variant } from './model';

/**
 * Product illustrations generated from catalog data: the silhouette comes from the category,
 * its proportions from the specs (tent capacity, bag warmth, down baffles, boot height), and its
 * colour from the variant. Served as SVG by ArtController, so pages, islands, markdown and
 * other agents all get a real image URL without any external asset.
 */

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

/** Mixes a hex colour with black (amount < 0) or white (amount > 0). */
function shade(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => Math.round(amount < 0 ? c * (1 + amount) : c + (255 - c) * amount));
  return `#${ch.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

function contours(seed: number): string {
  const lines: string[] = [];
  const cx = 60 + (seed % 280);
  const cy = 40 + ((seed >> 8) % 120);
  for (let i = 1; i <= 7; i++) {
    const rx = 40 + i * 34;
    const ry = 22 + i * 19;
    const wob = ((seed >> (i + 3)) % 9) - 4;
    lines.push(
      `<path d="M${cx - rx} ${cy}C${cx - rx} ${cy - ry - wob} ${cx + rx * 0.6} ${cy - ry + wob} ${cx + rx} ${cy - wob}S${cx + rx * 0.2} ${cy + ry + wob} ${cx - rx * 0.4} ${cy + ry}S${cx - rx} ${cy + ry * 0.4} ${cx - rx} ${cy}Z"/>`,
    );
  }
  return `<g fill="none" stroke="#17251F" stroke-opacity=".09" stroke-width="1.4">${lines.join('')}</g>`;
}

function tent(p: Product, c: string): string {
  const cap = p.capacity ?? 2;
  const half = 70 + cap * 18;
  const peak = 112 - Math.min(cap, 4) * 6 - (p.tags.includes('family') ? 18 : 0);
  const l = 200 - half;
  const r = 200 + half;
  return (
    `<path d="M${l} 236L200 ${peak}L${r} 236Z" fill="${c}"/>` +
    `<path d="M200 ${peak}L${r} 236H${200 + half * 0.35}Z" fill="${shade(c, -0.25)}"/>` +
    `<path d="M200 ${peak + 34}L${200 - half * 0.28} 236H${200 + half * 0.28}Z" fill="${shade(c, -0.55)}"/>` +
    `<path d="M${l - 16} 236H${r + 16}" stroke="#17251F" stroke-width="4" stroke-linecap="round"/>` +
    `<path d="M200 ${peak}V${peak - 14}" stroke="#17251F" stroke-width="3" stroke-linecap="round"/>`
  );
}

function bag(p: Product, c: string): string {
  const warmth = Math.max(0, Math.min(30, 10 - (p.temperatureC ?? 0)));
  const w = 54 + warmth * 1.3;
  const rect = p.tags.includes('quilt');
  const body = rect
    ? `<rect x="${200 - w}" y="64" width="${w * 2}" height="176" rx="18" fill="${c}"/>`
    : `<path d="M200 56C${200 + w} 56 ${200 + w} 100 ${200 + w * 0.92} 150C${200 + w * 0.8} 200 ${200 + w * 0.62} 240 200 240C${200 - w * 0.62} 240 ${200 - w * 0.8} 200 ${200 - w * 0.92} 150C${200 - w} 100 ${200 - w} 56 200 56Z" fill="${c}"/>`;
  const baffles: string[] = [];
  const step = p.insulation === 'down' ? 22 : 34;
  for (let y = 112; y < 232; y += step) baffles.push(`<path d="M${200 - w * 0.86} ${y}Q200 ${y + 10} ${200 + w * 0.86} ${y}" fill="none" stroke="${shade(c, -0.3)}" stroke-width="3"/>`);
  const hood = rect ? '' : `<ellipse cx="200" cy="90" rx="${w * 0.42}" ry="24" fill="${shade(c, -0.45)}"/>`;
  return body + hood + baffles.join('') + `<path d="M${200 + w * 0.5} 76V228" stroke="${shade(c, 0.35)}" stroke-width="3" stroke-dasharray="6 6"/>`;
}

function jacket(p: Product, c: string): string {
  const dark = shade(c, -0.3);
  const long = p.tags.includes('parka') ? 30 : 0;
  const body =
    `<path d="M150 82L118 98L92 200L118 206L132 140L134 ${236 + long}H266L268 140L282 206L308 200L282 98L250 82Z" fill="${c}"/>` +
    `<path d="M150 82Q200 40 250 82Q236 104 200 108Q164 104 150 82Z" fill="${dark}"/>` +
    `<path d="M200 108V${236 + long}" stroke="${shade(c, 0.4)}" stroke-width="3"/>`;
  const lines: string[] = [];
  if (p.insulation === 'down') for (let y = 128; y < 236 + long; y += 22) lines.push(`<path d="M136 ${y}H264" stroke="${dark}" stroke-width="2.5"/>`);
  if (p.tags.includes('fleece')) for (let x = 146; x < 260; x += 16) lines.push(`<path d="M${x} 120V${232 + long}" stroke="${dark}" stroke-opacity=".4" stroke-width="2"/>`);
  if (p.waterproofMm) lines.push(`<path d="M120 112L134 136M280 112L266 136" stroke="${shade(c, 0.5)}" stroke-width="3" stroke-linecap="round"/>`);
  return body + lines.join('');
}

function shoe(p: Product, c: string): string {
  const dark = shade(c, -0.35);
  if (p.tags.includes('sandal')) {
    return (
      `<path d="M96 222Q100 206 130 204H292Q318 206 316 222Q312 236 292 236H118Q98 236 96 222Z" fill="#17251F"/>` +
      `<path d="M150 204Q170 150 214 150Q250 152 262 204" fill="none" stroke="${c}" stroke-width="14"/>` +
      `<path d="M128 204Q160 172 196 176" fill="none" stroke="${dark}" stroke-width="12"/>`
    );
  }
  const top = p.temperatureC !== undefined ? 70 : p.tags.includes('mid') ? 96 : 140;
  return (
    `<path d="M112 ${top}H196L204 170Q262 172 296 190Q318 202 316 222H96V${top + 10}Q96 ${top} 112 ${top}Z" fill="${c}"/>` +
    `<path d="M92 222H320Q322 240 304 242H104Q90 240 92 222Z" fill="#17251F"/>` +
    `<path d="M196 ${top + 18}L206 168" stroke="${dark}" stroke-width="4"/>` +
    [0, 1, 2, 3].map((i) => `<path d="M${150 + i * 14} ${top + 24 + i * 16}H${178 + i * 14}" stroke="${shade(c, 0.5)}" stroke-width="3" stroke-linecap="round"/>`).join('') +
    `<path d="M104 242H304" stroke="${dark}" stroke-width="2" stroke-dasharray="8 6"/>`
  );
}

/** The SVG document for a product (and optionally one of its variants' colours). */
export function productSvg(p: Product, variant?: Variant): string {
  const colour = (variant ?? p.variants[0]).swatch;
  const seed = hash(p.id);
  const figure = p.category === 'tents' ? tent(p, colour) : p.category === 'sleeping-bags' ? bag(p, colour) : p.category === 'jackets' ? jacket(p, colour) : shoe(p, colour);
  const sky = shade(colour, 0.86);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300" role="img" aria-label="${p.name.replace(/[<>&"]/g, '')}">` +
    `<rect width="400" height="300" fill="${sky}"/>` +
    contours(seed) +
    `<path d="M0 244H400V300H0Z" fill="${shade(colour, 0.7)}"/>` +
    figure +
    `<rect x="18" y="18" width="10" height="26" rx="2" fill="#F26B1D"/>` +
    `</svg>`
  );
}

/** Public URL of a product's illustration. */
export function artUrl(productId: string, variantId?: string): string {
  return `/art/${variantId ?? productId}.svg`;
}
