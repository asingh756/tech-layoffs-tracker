// data.js — single source of truth. Loads the JSON datasets once and exposes
// pure query/aggregation helpers. Every figure shown on the site is derived here.

import { yearOf, monthOf } from './format.js';

const state = {
  events: [],
  annualTotals: [],
  byYear: new Map(), // year -> annualTotal record
  sources: [],
  meta: {},
  ready: false,
};

async function loadJSON(path) {
  const res = await fetch(path, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Failed to load ${path} (HTTP ${res.status})`);
  return res.json();
}

/** Dedupe events by id and by (company|date|laidOff), keeping highest confidence. */
function dedupe(events) {
  const rank = { confirmed: 3, estimated: 2, unknown: 1 };
  const byId = new Map();
  const byKey = new Map();
  for (const ev of events) {
    const key = `${(ev.company || '').toLowerCase()}|${ev.date}|${ev.laidOff}`;
    const existing = byId.get(ev.id) || byKey.get(key);
    if (!existing) {
      byId.set(ev.id, ev);
      byKey.set(key, ev);
      continue;
    }
    // Keep the higher-confidence record; fill nulls from the other.
    const better = (rank[ev.confidence] || 0) > (rank[existing.confidence] || 0) ? ev : existing;
    const other = better === ev ? existing : ev;
    for (const k of Object.keys(other)) {
      if (better[k] === null || better[k] === undefined) better[k] = other[k];
    }
    byId.set(better.id, better);
    byKey.set(key, better);
  }
  return Array.from(new Set(byId.values()));
}

export async function initStore() {
  const [events, totals, sources, meta] = await Promise.all([
    loadJSON('data/events.json'),
    loadJSON('data/annual-totals.json'),
    loadJSON('data/sources.json'),
    loadJSON('data/meta.json'),
  ]);

  state.events = dedupe(events.events || []).map((e) => ({
    ...e,
    year: e.year || yearOf(e.date),
  }));
  state.annualTotals = (totals.annualTotals || []).slice().sort((a, b) => a.year - b.year);
  state.byYear = new Map(state.annualTotals.map((r) => [r.year, r]));
  state.sources = sources.sources || [];
  state.meta = meta || {};
  state.ready = true;
  return state;
}

// ---- basic accessors -------------------------------------------------------

export const meta = () => state.meta;
export const sources = () => state.sources;
export const allEvents = () => state.events;
export const annualTotals = () => state.annualTotals;

export function years() {
  return state.annualTotals.map((r) => r.year);
}

export function currentYear() {
  if (state.meta.currentYear) return state.meta.currentYear;
  return state.annualTotals.length ? state.annualTotals[state.annualTotals.length - 1].year : null;
}

export function annualFor(year) {
  return state.byYear.get(Number(year)) || null;
}

export function sourceByName(name) {
  return state.sources.find((s) => s.name === name) || null;
}

// ---- year-scoped aggregations ---------------------------------------------

export function eventsForYear(year) {
  year = Number(year);
  return state.events
    .filter((e) => e.year === year)
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

/** 12-bucket monthly breakdown for a year, summing known headcounts. */
export function monthlyForYear(year) {
  const buckets = Array.from({ length: 12 }, (_, i) => ({
    month: i + 1,
    total: 0,
    count: 0,
    events: [],
  }));
  for (const e of eventsForYear(year)) {
    const m = monthOf(e.date);
    if (!m) continue;
    const b = buckets[m - 1];
    b.count += 1;
    b.events.push(e);
    if (typeof e.laidOff === 'number') b.total += e.laidOff;
  }
  return buckets;
}

/** Company leaderboard for a year (or all-time when year is omitted). */
export function leaderboard(year = null, limit = null) {
  const evs = year === null ? state.events : eventsForYear(year);
  const map = new Map();
  for (const e of evs) {
    const g = map.get(e.company) || {
      company: e.company,
      total: 0,
      knownCount: 0,
      rounds: 0,
      hq: e.companyHQ,
      industry: e.industry,
      hasUnknown: false,
    };
    g.rounds += 1;
    if (typeof e.laidOff === 'number') {
      g.total += e.laidOff;
      g.knownCount += 1;
    } else {
      g.hasUnknown = true;
    }
    map.set(e.company, g);
  }
  const arr = Array.from(map.values()).sort((a, b) => b.total - a.total);
  return limit ? arr.slice(0, limit) : arr;
}

/** Biggest individual events by known headcount. */
export function biggestEvents(year = null, limit = 10) {
  const evs = year === null ? state.events : eventsForYear(year);
  return evs
    .filter((e) => typeof e.laidOff === 'number')
    .sort((a, b) => b.laidOff - a.laidOff)
    .slice(0, limit);
}

/**
 * Coverage indicator: how much of a year's authoritative total is represented
 * by the individually tracked events. Keeps the site honest about completeness.
 */
export function coverage(year) {
  const annual = annualFor(year);
  const evs = eventsForYear(year);
  const trackedSum = evs.reduce((s, e) => s + (typeof e.laidOff === 'number' ? e.laidOff : 0), 0);
  const pct = annual && annual.total ? (trackedSum / annual.total) * 100 : null;
  return {
    trackedSum,
    trackedEvents: evs.length,
    annualTotal: annual ? annual.total : null,
    pct,
  };
}

// ---- trends ----------------------------------------------------------------

/** Year-over-year change vs the immediately prior year. */
export function trend(year) {
  year = Number(year);
  const cur = annualFor(year);
  const prev = annualFor(year - 1);
  if (!cur || !prev || !prev.total) {
    return { hasPrior: false, current: cur ? cur.total : null };
  }
  const pct = ((cur.total - prev.total) / prev.total) * 100;
  return {
    hasPrior: true,
    current: cur.total,
    prior: prev.total,
    priorYear: year - 1,
    delta: cur.total - prev.total,
    pct,
    direction: pct > 1.5 ? 'up' : pct < -1.5 ? 'down' : 'flat',
    partial: cur.confidence === 'estimated' && year === currentYear(),
  };
}

export function peakYear() {
  return state.annualTotals.reduce((peak, r) => (!peak || r.total > peak.total ? r : peak), null);
}

// ---- company-scoped --------------------------------------------------------

/** Distinct companies with all-time tracked totals, for search + lists. */
export function companies() {
  const board = leaderboard(null);
  return board.map((c) => ({
    company: c.company,
    total: c.total,
    rounds: c.rounds,
    hasUnknown: c.hasUnknown,
  }));
}

export function companyProfile(name) {
  const events = state.events
    .filter((e) => e.company.toLowerCase() === String(name).toLowerCase())
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  if (!events.length) return null;

  const total = events.reduce((s, e) => s + (typeof e.laidOff === 'number' ? e.laidOff : 0), 0);
  const knownCount = events.filter((e) => typeof e.laidOff === 'number').length;
  const yearsHit = Array.from(new Set(events.map((e) => e.year))).sort();
  const industries = Array.from(new Set(events.map((e) => e.industry).filter(Boolean)));
  const hqs = events.map((e) => e.companyHQ).filter(Boolean);

  return {
    company: events[0].company,
    total,
    knownCount,
    rounds: events.length,
    multipleRounds: events.length > 1,
    years: yearsHit,
    firstDate: events[events.length - 1].date,
    lastDate: events[0].date,
    industry: industries[0] || null,
    hq: hqs[0] || null,
    events,
  };
}

// ---- generic filtering for the events table -------------------------------

export function filterEvents({ year = null, company = '', confidence = null } = {}) {
  let evs = state.events.slice();
  if (year) evs = evs.filter((e) => e.year === Number(year));
  if (confidence) evs = evs.filter((e) => e.confidence === confidence);
  if (company) {
    const q = company.toLowerCase();
    evs = evs.filter(
      (e) =>
        e.company.toLowerCase().includes(q) ||
        (e.industry && e.industry.toLowerCase().includes(q)),
    );
  }
  return evs.sort((a, b) => (a.date < b.date ? 1 : -1));
}
