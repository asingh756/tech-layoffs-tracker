// app.js — UI controller. Loads the store, wires the four views, and renders.

import * as store from './data.js';
import * as charts from './charts.js';
import {
  fmtInt, fmtDate, fmtSignedPct, confidenceMeta, trendVerb,
} from './format.js';

const state = { year: null, company: null };
const REDUCE_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---- tiny DOM helpers ------------------------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function badge(conf) {
  const m = confidenceMeta(conf);
  return `<span class="badge ${m.key}" title="${esc(m.title)}">${m.label}</span>`;
}
function sourceLink(name, url) {
  return url
    ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(name)}</a>`
    : esc(name);
}
function emptyState(msg) {
  return `<div class="empty-state">${esc(msg)}</div>`;
}

// ---- boot ------------------------------------------------------------------
async function main() {
  try {
    await store.initStore();
  } catch (err) {
    document.querySelector('#main').innerHTML =
      `<div class="empty-state">Could not load data: ${esc(err.message)}.<br>
       If you opened this file directly, serve it over HTTP (e.g. <code>python3 -m http.server</code>).</div>`;
    return;
  }
  state.year = store.currentYear();
  renderFooter();
  buildYearSelectors();
  setupTabs();
  setupCompany();
  setupEvents();
  setupCompareControls();
  document.addEventListener('click', delegatedClicks);
  routeFromHash();
}

// ---- routing / tabs --------------------------------------------------------
const VIEWS = ['dashboard', 'company', 'historical', 'events'];

function setupTabs() {
  $$('#tabs .tab').forEach((btn) =>
    btn.addEventListener('click', () => activateView(btn.dataset.view)));
  window.addEventListener('hashchange', routeFromHash);
}

function activateView(name, { updateHash = true } = {}) {
  if (!VIEWS.includes(name)) name = 'dashboard';
  $$('#tabs .tab').forEach((b) => b.classList.toggle('is-active', b.dataset.view === name));
  $$('.view').forEach((v) => v.classList.toggle('is-active', v.id === `view-${name}`));
  if (updateHash && !location.hash.startsWith(`#${name}`)) {
    history.replaceState(null, '', `#${name}`);
  }
  if (name === 'dashboard') renderDashboard();
  if (name === 'historical') renderHistorical();
  if (name === 'company' && state.company) renderCompany(state.company);
  if (name === 'events') renderEventsTable();
  window.scrollTo(0, 0);
}

function routeFromHash() {
  const raw = location.hash.replace(/^#/, '');
  const [view, arg] = raw.split('=');
  if (view === 'company' && arg) state.company = decodeURIComponent(arg);
  activateView(view || 'dashboard', { updateHash: false });
}

function delegatedClicks(e) {
  const link = e.target.closest('[data-company]');
  if (link) {
    e.preventDefault();
    navigateToCompany(link.dataset.company);
  }
}

function navigateToCompany(name) {
  state.company = name;
  const input = $('#company-input');
  if (input) input.value = name;
  activateView('company');
  renderCompany(name);
}

// ---- year selectors --------------------------------------------------------
function buildYearSelectors() {
  const desc = store.years().slice().sort((a, b) => b - a);
  const opts = desc.map((y) => `<option value="${y}">${y}</option>`).join('');
  $('#year-select').innerHTML = opts;
  $('#year-select').value = String(state.year);
  $('#year-select').addEventListener('change', (e) => setYear(+e.target.value));
  $('#year-prev').addEventListener('click', () => stepYear(-1));
  $('#year-next').addEventListener('click', () => stepYear(1));
}
function setYear(y) {
  state.year = y;
  $('#year-select').value = String(y);
  renderDashboard();
}
function stepYear(dir) {
  const asc = store.years().slice().sort((a, b) => a - b);
  const i = asc.indexOf(state.year);
  if (i + dir >= 0 && i + dir < asc.length) setYear(asc[i + dir]);
}

// ---- count-up animation ----------------------------------------------------
function countUp(el, target) {
  if (target === null || target === undefined) { el.textContent = '—'; return; }
  const from = parseInt(String(el.textContent).replace(/[^0-9]/g, ''), 10) || 0;
  if (REDUCE_MOTION) { el.textContent = fmtInt(target); return; }
  const dur = 850;
  const t0 = performance.now();
  function step(now) {
    const p = Math.min(1, (now - t0) / dur);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = fmtInt(Math.round(from + (target - from) * eased));
    if (p < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

// =================== DASHBOARD ===================
function renderDashboard() {
  const year = state.year;
  const annual = store.annualFor(year);
  const m = store.meta();

  $('#headline-year').textContent = year;
  $('#monthly-year').textContent = year;
  $('#leaderboard-year').textContent = year;
  $('#biggest-year').textContent = year;
  $('#hero-asof').textContent = m.lastUpdated ? `Updated ${fmtDate(m.lastUpdated)}` : '';

  countUp($('#headline-count'), annual ? annual.total : null);
  renderHeadlineMeta(annual);
  renderTrendChip(year);
  $('#trend-summary').innerHTML = trendSummary(year);

  renderStats(year, annual);
  charts.historicalChart(store.annualTotals(), year);
  charts.monthlyChart(store.monthlyForYear(year), year);
  renderMonthlyNote(year);
  renderLeaderboard(year);
  renderBiggest(year);
  renderCoverage(year);

  // year-stepper bounds
  const asc = store.years().slice().sort((a, b) => a - b);
  $('#year-prev').disabled = state.year <= asc[0];
  $('#year-next').disabled = state.year >= asc[asc.length - 1];
}

function renderHeadlineMeta(annual) {
  const el = $('#headline-meta');
  if (!annual) { el.innerHTML = ''; return; }
  let html = `${badge(annual.confidence)} <span>Source: ${sourceLink(annual.source, annual.sourceUrl)}</span>`;
  if (annual.asOf) html += ` <span>&middot; as of ${fmtDate(annual.asOf)}</span>`;
  if (annual.estimates && annual.estimates.length) {
    const rows = annual.estimates.map((e) =>
      `<div><strong>${esc(e.source)}</strong>: ${fmtInt(e.total)} <span class="muted">(as of ${fmtDate(e.asOf)})</span></div>`).join('');
    html += ` <details class="estimates"><summary>trackers vary</summary><div class="estimates-body">${rows}</div></details>`;
  }
  el.innerHTML = html;
}

function renderTrendChip(year) {
  const t = store.trend(year);
  const chip = $('#headline-trend');
  if (!t.hasPrior) { chip.className = 'trend-chip flat'; chip.textContent = 'No prior-year comparison'; return; }
  const arrow = t.direction === 'up' ? '▲' : t.direction === 'down' ? '▼' : '▬';
  chip.className = `trend-chip ${t.direction}`;
  chip.textContent = `${arrow} ${fmtSignedPct(t.pct)} vs ${t.priorYear}`;
}

function trendSummary(year) {
  const t = store.trend(year);
  const peak = store.peakYear();
  const isCurrent = year === store.currentYear();
  let s;
  if (!t.hasPrior) {
    s = `This is the earliest year tracked, so there is no prior-year comparison yet.`;
  } else if (t.direction === 'flat') {
    s = `Tech layoffs in ${year} are <strong>about even</strong> with ${t.priorYear} (${fmtInt(t.prior)} laid off).`;
  } else {
    const word = t.direction === 'up' ? 'up' : 'down';
    s = `Tech layoffs in ${year} are <strong>${word} ${Math.abs(t.pct).toFixed(1)}%</strong> compared to ${t.priorYear} (${fmtInt(t.prior)} laid off).`;
  }
  if (peak) {
    s += peak.year === year
      ? ` That makes ${year} the worst year on record.`
      : ` The peak remains <strong>${peak.year}</strong> with ${fmtInt(peak.total)} layoffs.`;
  }
  if (isCurrent) s += ` ${year} figures are year-to-date and keep updating as sources refresh.`;
  return s;
}

function renderStats(year, annual) {
  const cov = store.coverage(year);
  const biggest = store.biggestEvents(year, 1)[0];
  const cards = [
    statCard('Total laid off', annual ? fmtInt(annual.total) : '—',
      annual ? `${confidenceMeta(annual.confidence).label}` : 'No data'),
    statCard('Companies affected', annual && annual.companies ? fmtInt(annual.companies) : '—',
      annual && annual.companies ? 'reported layoffs' : 'not disclosed by source'),
    statCard('Biggest single layoff', biggest ? fmtInt(biggest.laidOff) : '—',
      biggest ? esc(biggest.company) : 'no tracked events'),
    statCard('Tracked events', fmtInt(cov.trackedEvents),
      cov.pct != null ? `~${cov.pct.toFixed(0)}% of total itemised` : 'itemised below'),
  ];
  $('#stat-grid').innerHTML = cards.join('');
}
function statCard(label, value, foot, footClass = '') {
  return `<div class="stat"><div class="stat-label">${esc(label)}</div>
    <div class="stat-value">${value}</div>
    <div class="stat-foot ${footClass}">${foot}</div></div>`;
}

function renderMonthlyNote(year) {
  const cov = store.coverage(year);
  $('#monthly-note').innerHTML = cov.trackedEvents
    ? `Based on ${cov.trackedEvents} tracked event${cov.trackedEvents > 1 ? 's' : ''} (${fmtInt(cov.trackedSum)} people). Months without tracked events show zero.`
    : `No individually tracked events for ${year} yet.`;
}

function renderLeaderboard(year) {
  const rows = store.leaderboard(year, 8);
  const el = $('#leaderboard');
  if (!rows.length) { el.innerHTML = emptyState(`No tracked events for ${year}.`); return; }
  const max = Math.max(...rows.map((r) => r.total), 1);
  el.innerHTML = rows.map((r, i) => `
    <div class="lb-row">
      <div class="lb-rank">${i + 1}</div>
      <div class="lb-body">
        <div class="lb-top">
          <span class="lb-name" data-company="${esc(r.company)}">${esc(r.company)}</span>
          <span class="lb-val">${r.total ? fmtInt(r.total) : '—'}</span>
        </div>
        <div class="lb-track"><div class="lb-fill" style="width:${Math.max(3, (r.total / max) * 100)}%"></div></div>
        <div class="lb-sub">${r.rounds} event${r.rounds > 1 ? 's' : ''}${r.hasUnknown ? ' · some undisclosed' : ''}${r.hq ? ` · ${esc(r.hq)}` : ''}</div>
      </div>
    </div>`).join('');
}

function renderBiggest(year) {
  const evs = store.biggestEvents(year, 6);
  const el = $('#biggest-events');
  if (!evs.length) { el.innerHTML = emptyState(`No tracked events for ${year}.`); return; }
  el.innerHTML = evs.map((e) => `
    <div class="event-row">
      <div class="event-main">
        <div class="event-co" data-company="${esc(e.company)}">${esc(e.company)} ${badge(e.confidence)}</div>
        <div class="event-meta">${fmtDate(e.date)}${typeof e.percentage === 'number' ? ` · ${e.percentage}% of company` : ''}${e.industry ? ` · ${esc(e.industry)}` : ''}</div>
      </div>
      <div class="event-num">${fmtInt(e.laidOff)}</div>
    </div>`).join('');
}

function renderCoverage(year) {
  const c = store.coverage(year);
  const el = $('#coverage-note');
  if (c.annualTotal == null) {
    el.innerHTML = `Showing <strong>${c.trackedEvents}</strong> individually tracked events for ${year}.`;
    return;
  }
  el.innerHTML = `The tracked events here account for <strong>${fmtInt(c.trackedSum)}</strong> of the
    <strong>${fmtInt(c.annualTotal)}</strong> total layoffs in ${year}
    (~${c.pct.toFixed(0)}% itemised). The remainder is counted in the headline total by the source but
    not individually listed — we don't invent the rest.`;
}

// =================== COMPANY ===================
function setupCompany() {
  const list = store.companies();
  $('#company-list').innerHTML = list.map((c) => `<option value="${esc(c.company)}"></option>`).join('');
  $('#company-chips').innerHTML = list.slice(0, 12)
    .map((c) => `<button class="chip" data-company="${esc(c.company)}">${esc(c.company)}</button>`).join('');
  const input = $('#company-input');
  const go = () => { const v = input.value.trim(); if (v) navigateToCompany(v); };
  input.addEventListener('change', go);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
}

function renderCompany(name) {
  state.company = name;
  const input = $('#company-input');
  if (input && input.value !== name) input.value = name;
  const p = store.companyProfile(name);
  const profileEl = $('#company-profile');
  const chartPanel = $('#company-chart-panel');
  const tableEl = $('#company-events');

  if (!p) {
    profileEl.innerHTML = emptyState(`No tracked layoff events for “${name}”. Try a suggested company above, or browse the Events tab.`);
    chartPanel.hidden = true;
    tableEl.innerHTML = '';
    history.replaceState(null, '', `#company`);
    return;
  }

  const span = p.firstDate === p.lastDate ? fmtDate(p.lastDate) : `${fmtDate(p.firstDate)} → ${fmtDate(p.lastDate)}`;
  const roundsBadge = p.multipleRounds
    ? `<span class="cp-rounds">⟳ ${p.rounds} rounds of layoffs</span>`
    : `<span class="cp-rounds" style="background:rgba(70,214,160,.12);color:var(--down)">single tracked round</span>`;
  const floorNote = p.knownCount < p.rounds
    ? `<p class="panel-note">${p.rounds - p.knownCount} round(s) had undisclosed headcounts, so the tracked total is a floor.</p>`
    : '';

  profileEl.innerHTML = `<div class="cp-card">
    <div class="cp-head"><span class="cp-name">${esc(p.company)}</span>${roundsBadge}</div>
    <div class="cp-stats">
      ${cpStat('Total laid off (tracked)', p.total ? fmtInt(p.total) : '—')}
      ${cpStat('Layoff rounds', p.rounds)}
      ${cpStat('Period', span)}
      ${cpStat('Industry', p.industry || '—')}
      ${cpStat('Headquarters', p.hq || '—')}
    </div>${floorNote}
  </div>`;

  chartPanel.hidden = false;
  charts.companyChart(p.events);
  tableEl.innerHTML = eventsTable(p.events, { sortable: false, showCompany: false });
  history.replaceState(null, '', `#company=${encodeURIComponent(name)}`);
}
function cpStat(label, value) {
  return `<div><div class="cp-stat-label">${esc(label)}</div><div class="cp-stat-value">${value}</div></div>`;
}

// =================== HISTORICAL ===================
let compareWired = false;
function setupCompareControls() {
  const desc = store.years().slice().sort((a, b) => b - a);
  const opts = desc.map((y) => `<option value="${y}">${y}</option>`).join('');
  $('#compare-a').innerHTML = opts;
  $('#compare-b').innerHTML = opts;
  $('#compare-a').value = String(store.currentYear());
  $('#compare-b').value = String(desc[1] ?? desc[0]);
  $('#compare-a').addEventListener('change', renderCompare);
  $('#compare-b').addEventListener('change', renderCompare);
  compareWired = true;
}

function renderHistorical() {
  const totals = store.annualTotals();
  const peak = store.peakYear();
  charts.yearsChart(totals, peak.year);
  $('#peak-hint').textContent = `Peak: ${peak.year} (${fmtInt(peak.total)} laid off)`;
  renderCompare();
  $('#annual-table').innerHTML = annualTable(totals);
}

function renderCompare() {
  if (!compareWired) return;
  const a = +$('#compare-a').value;
  const b = +$('#compare-b').value;
  const ta = store.annualFor(a);
  const tb = store.annualFor(b);
  if (!ta || !tb) return;
  let delta = '';
  if (tb.total) {
    const pct = ((ta.total - tb.total) / tb.total) * 100;
    const dir = pct > 1.5 ? 'up' : pct < -1.5 ? 'down' : 'flat';
    const arrow = dir === 'up' ? '▲' : dir === 'down' ? '▼' : '▬';
    delta = `<div class="cmp-delta trend-chip ${dir}" style="border:0;background:transparent">
      ${arrow} ${fmtSignedPct(pct)}<br><span class="muted" style="font-weight:500">${a} vs ${b}</span></div>`;
  }
  $('#compare-result').innerHTML = `
    ${cmpSide(ta)}
    ${delta}
    ${cmpSide(tb)}`;
}
function cmpSide(t) {
  return `<div class="cmp-side"><div class="cmp-year">${t.year}</div>
    <div class="cmp-num">${fmtInt(t.total)}</div>
    <div class="muted" style="font-size:.78rem">${t.companies ? fmtInt(t.companies) + ' companies' : '&nbsp;'}</div></div>`;
}

function annualTable(totals) {
  const rows = totals.slice().sort((a, b) => b.year - a.year).map((t) => {
    const tr = store.trend(t.year);
    const yoy = tr.hasPrior
      ? `<span class="${tr.direction}" style="color:var(--${tr.direction === 'up' ? 'up' : tr.direction === 'down' ? 'down' : 'flat'})">${fmtSignedPct(tr.pct)}</span>`
      : '—';
    return `<tr>
      <td class="td-co">${t.year}</td>
      <td class="td-num">${fmtInt(t.total)}</td>
      <td class="td-num">${t.companies ? fmtInt(t.companies) : '—'}</td>
      <td class="td-num">${yoy}</td>
      <td>${sourceLink(t.source, t.sourceUrl)}</td>
      <td>${badge(t.confidence)}</td>
      <td class="muted">${esc(t.note || '')}</td>
    </tr>`;
  }).join('');
  return `<table class="data"><thead><tr>
    <th class="no-sort">Year</th><th class="no-sort">Total laid off</th><th class="no-sort">Companies</th>
    <th class="no-sort">YoY</th><th class="no-sort">Source</th><th class="no-sort">Confidence</th><th class="no-sort">Note</th>
    </tr></thead><tbody>${rows}</tbody></table>`;
}

// =================== EVENTS ===================
const EVENT_COLS = [
  { key: 'company', label: 'Company', sort: true, cell: (e) => `<td class="td-co cell-link" data-company="${esc(e.company)}">${esc(e.company)}</td>` },
  { key: 'date', label: 'Date', sort: true, cell: (e) => `<td>${fmtDate(e.date)}</td>` },
  { key: 'laidOff', label: 'Laid off', sort: true, num: true, cell: (e) => `<td class="td-num">${fmtInt(e.laidOff)}</td>` },
  { key: 'percentage', label: '% of co.', sort: true, num: true, cell: (e) => `<td class="td-num">${typeof e.percentage === 'number' ? e.percentage + '%' : '—'}</td>` },
  { key: 'location', label: 'Location', sort: false, cell: (e) => `<td>${esc(e.employeeLocation || e.companyHQ || '—')}</td>` },
  { key: 'industry', label: 'Industry', sort: true, cell: (e) => `<td>${e.industry ? esc(e.industry) : '—'}</td>` },
  { key: 'source', label: 'Source', sort: false, cell: (e) => `<td>${sourceLink(e.source, e.sourceUrl)}</td>` },
  { key: 'confidence', label: 'Confidence', sort: true, cell: (e) => `<td>${badge(e.confidence)}</td>` },
];
const CONF_RANK = { confirmed: 3, estimated: 2, unknown: 1 };
let eventsSort = { key: 'date', dir: 'desc' };

function setupEvents() {
  const years = store.years().slice().sort((a, b) => b - a);
  $('#events-year').innerHTML = `<option value="">All years</option>` +
    years.map((y) => `<option value="${y}">${y}</option>`).join('');
  ['#events-search', '#events-year', '#events-confidence'].forEach((s) =>
    $(s).addEventListener('input', renderEventsTable));
  // delegated header sorting
  $('#events-table').addEventListener('click', (e) => {
    const th = e.target.closest('th[data-key]');
    if (!th) return;
    const key = th.dataset.key;
    eventsSort = { key, dir: eventsSort.key === key && eventsSort.dir === 'asc' ? 'desc' : 'asc' };
    renderEventsTable();
  });
}

function sortEvents(evs, { key, dir }) {
  const col = EVENT_COLS.find((c) => c.key === key);
  const mul = dir === 'asc' ? 1 : -1;
  return evs.slice().sort((a, b) => {
    let va; let vb;
    if (key === 'confidence') { va = CONF_RANK[a.confidence] || 0; vb = CONF_RANK[b.confidence] || 0; }
    else { va = a[key]; vb = b[key]; }
    if (col && col.num) { // nulls last regardless of dir
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      return (va - vb) * mul;
    }
    return String(va ?? '').localeCompare(String(vb ?? '')) * mul;
  });
}

function renderEventsTable() {
  const filters = {
    year: $('#events-year').value || null,
    company: $('#events-search').value.trim(),
    confidence: $('#events-confidence').value || null,
  };
  const evs = sortEvents(store.filterEvents(filters), eventsSort);
  $('#events-count').textContent = `${evs.length} event${evs.length !== 1 ? 's' : ''}`;
  $('#events-table').innerHTML = evs.length
    ? eventsTable(evs, { sortable: true, showCompany: true })
    : emptyState('No events match those filters.');
}

function eventsTable(events, { sortable, showCompany }) {
  const cols = EVENT_COLS.filter((c) => showCompany || c.key !== 'company');
  const head = cols.map((c) => {
    if (sortable && c.sort) {
      const active = eventsSort.key === c.key;
      const arrow = active ? `<span class="arrow">${eventsSort.dir === 'asc' ? '▲' : '▼'}</span>` : '';
      return `<th data-key="${c.key}">${c.label} ${arrow}</th>`;
    }
    return `<th class="no-sort">${c.label}</th>`;
  }).join('');
  const body = events.map((e) =>
    `<tr title="${esc(e.notes || '')}">${cols.map((c) => c.cell(e)).join('')}</tr>`).join('');
  return `<table class="data"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

// =================== FOOTER ===================
function renderFooter() {
  const m = store.meta();
  $('#updated-text').textContent = m.lastUpdated ? `Updated ${fmtDate(m.lastUpdated)}` : 'Live';
  $('#sources-list').innerHTML = store.sources().map((s) =>
    `<li>${sourceLink(s.name, s.url)} <span class="src-cred">— ${esc(s.type)} · ${esc(s.credibility)} credibility</span></li>`).join('');
  $('#methodology-text').textContent = m.methodology || '';
  $('#coverage-text').textContent = m.coverageNote || '';
  $('#honesty-list').innerHTML = (m.honesty || []).map((h) => `<li>${esc(h)}</li>`).join('');
  $('#disclaimer-text').textContent = m.disclaimer || '';
}

main();
