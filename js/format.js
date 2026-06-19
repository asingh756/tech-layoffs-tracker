// format.js — pure presentation helpers, no dependencies.

export const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

const MONTHS_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** Full integer with thousands separators, or an em dash for unknown. */
export function fmtInt(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return Number(n).toLocaleString('en-US');
}

/** Compact form: 1,280 -> 1.3K, 152922 -> 153K, 1500000 -> 1.5M. */
export function fmtCompact(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(n);
}

export function fmtPct(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return `${n}%`;
}

/** Signed percentage for trend deltas: +18.4% / -22.1%. */
export function fmtSignedPct(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  const v = Math.round(n * 10) / 10;
  return `${v > 0 ? '+' : ''}${v.toFixed(1)}%`;
}

/**
 * Format an ISO date. Accepts YYYY-MM-DD or partial YYYY-MM / YYYY.
 * 2026-01-30 -> "Jan 30, 2026", 2026-05 -> "May 2026", 2026 -> "2026".
 */
export function fmtDate(iso) {
  if (!iso) return '—';
  const parts = String(iso).split('-');
  const y = parts[0];
  const m = parts[1] ? parseInt(parts[1], 10) : null;
  const d = parts[2] ? parseInt(parts[2], 10) : null;
  if (m && d) return `${MONTHS[m - 1]} ${d}, ${y}`;
  if (m) return `${MONTHS[m - 1]} ${y}`;
  return `${y}`;
}

export function monthName(index1to12, long = false) {
  const arr = long ? MONTHS_LONG : MONTHS;
  return arr[index1to12 - 1] || '';
}

export function yearOf(iso) {
  return iso ? parseInt(String(iso).slice(0, 4), 10) : null;
}

export function monthOf(iso) {
  const p = String(iso || '').split('-');
  return p[1] ? parseInt(p[1], 10) : null;
}

/** Metadata for a confidence label: drives badges and copy. */
export function confidenceMeta(c) {
  switch ((c || 'unknown').toLowerCase()) {
    case 'confirmed':
      return { key: 'confirmed', label: 'Confirmed', title: 'Reported as a specific, corroborated figure.' };
    case 'estimated':
      return { key: 'estimated', label: 'Estimated', title: 'An approximate or ranged figure ("up to", "about").' };
    default:
      return { key: 'unknown', label: 'Unknown', title: 'The source did not disclose a headcount.' };
  }
}

/** URL/anchor-safe slug for a company name. */
export function slug(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** "increased" / "decreased" / "held roughly flat" from a signed pct. */
export function trendVerb(pct) {
  if (pct === null || pct === undefined) return 'changed';
  if (pct > 1.5) return 'increased';
  if (pct < -1.5) return 'decreased';
  return 'held roughly flat';
}

export function titleCase(s) {
  return String(s).replace(/\w\S*/g, (t) => t.charAt(0).toUpperCase() + t.slice(1));
}
