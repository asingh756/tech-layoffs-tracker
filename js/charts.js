// charts.js — Chart.js wrappers. Uses the globally-loaded (vendored) Chart UMD,
// which auto-registers all controllers/scales.

import { fmtInt, fmtCompact, MONTHS, fmtDate } from './format.js';

const Chart = window.Chart;

const C = {
  accent: '#f6c453',
  accent2: '#ffb454',
  up: '#ff6b6b',
  down: '#46d6a0',
  grid: 'rgba(255,255,255,0.06)',
  tick: '#7e8aa3',
  text: '#e9eefb',
  panel: '#0e1622',
};

if (Chart) {
  Chart.defaults.font.family =
    "Inter, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
  Chart.defaults.color = C.tick;
  Chart.defaults.maintainAspectRatio = false;
  Chart.defaults.responsive = true;
  Chart.defaults.plugins.legend.display = false;
}

const instances = {};

function mount(id, config) {
  const el = document.getElementById(id);
  if (!el) return null;
  if (instances[id]) instances[id].destroy();
  instances[id] = new Chart(el.getContext('2d'), config);
  return instances[id];
}

/** Vertical gradient fill helper for area charts. */
function vGradient(ctx, area, from, to) {
  if (!area) return from;
  const g = ctx.createLinearGradient(0, area.top, 0, area.bottom);
  g.addColorStop(0, from);
  g.addColorStop(1, to);
  return g;
}

const baseTooltip = {
  backgroundColor: '#0b1018',
  borderColor: 'rgba(255,255,255,0.12)',
  borderWidth: 1,
  padding: 11,
  titleColor: C.text,
  bodyColor: '#cdd6ea',
  cornerRadius: 9,
  displayColors: false,
};

function yScale(extra = {}) {
  return {
    beginAtZero: true,
    grid: { color: C.grid, drawBorder: false },
    border: { display: false },
    ticks: { callback: (v) => fmtCompact(v), maxTicksLimit: 6, padding: 6 },
    ...extra,
  };
}
function xScale(extra = {}) {
  return {
    grid: { display: false },
    border: { color: C.grid },
    ticks: { padding: 6, ...(extra.ticks || {}) },
    ...extra,
  };
}

/** Annual totals as a highlighted line over time. */
export function historicalChart(totals, selectedYear) {
  const labels = totals.map((t) => String(t.year));
  const data = totals.map((t) => t.total);
  return mount('chart-historical', {
    type: 'line',
    data: {
      labels,
      datasets: [{
        data,
        borderColor: C.accent,
        borderWidth: 2.5,
        tension: 0.32,
        fill: true,
        backgroundColor: (c) => vGradient(c.chart.ctx, c.chart.chartArea, 'rgba(246,196,83,0.28)', 'rgba(246,196,83,0)'),
        pointBackgroundColor: totals.map((t) => (t.year === selectedYear ? '#fff' : C.accent)),
        pointBorderColor: totals.map((t) => (t.year === selectedYear ? C.accent : 'transparent')),
        pointBorderWidth: 3,
        pointRadius: totals.map((t) => (t.year === selectedYear ? 6 : 3)),
        pointHoverRadius: 7,
      }],
    },
    options: {
      scales: { y: yScale(), x: xScale() },
      plugins: {
        tooltip: {
          ...baseTooltip,
          callbacks: {
            title: (it) => `Tech layoffs in ${it[0].label}`,
            label: (it) => {
              const t = totals[it.dataIndex];
              const lines = [`${fmtInt(t.total)} laid off`];
              if (t.companies) lines.push(`${fmtInt(t.companies)} companies`);
              lines.push(`Source: ${t.source} (${t.confidence})`);
              return lines;
            },
          },
        },
      },
    },
  });
}

/** Monthly tracked headcount for a year. */
export function monthlyChart(buckets, year) {
  return mount('chart-monthly', {
    type: 'bar',
    data: {
      labels: MONTHS,
      datasets: [{
        data: buckets.map((b) => b.total),
        backgroundColor: (c) => vGradient(c.chart.ctx, c.chart.chartArea, C.accent, 'rgba(255,180,84,0.45)'),
        borderRadius: 5,
        maxBarThickness: 30,
      }],
    },
    options: {
      scales: { y: yScale(), x: xScale() },
      plugins: {
        tooltip: {
          ...baseTooltip,
          callbacks: {
            title: (it) => `${it[0].label} ${year}`,
            label: (it) => {
              const b = buckets[it.dataIndex];
              if (!b.count) return 'No tracked events';
              return [`${fmtInt(b.total)} laid off`, `${b.count} tracked event${b.count > 1 ? 's' : ''}`];
            },
          },
        },
      },
    },
  });
}

/** Layoffs by year as bars, with the peak year highlighted. */
export function yearsChart(totals, peakYearValue) {
  return mount('chart-years', {
    type: 'bar',
    data: {
      labels: totals.map((t) => String(t.year)),
      datasets: [{
        data: totals.map((t) => t.total),
        backgroundColor: totals.map((t) => (t.year === peakYearValue ? C.up : C.accent)),
        borderRadius: 6,
        maxBarThickness: 64,
      }],
    },
    options: {
      scales: { y: yScale(), x: xScale() },
      plugins: {
        tooltip: {
          ...baseTooltip,
          callbacks: {
            title: (it) => it[0].label,
            label: (it) => {
              const t = totals[it.dataIndex];
              const lines = [`${fmtInt(t.total)} laid off`];
              if (t.companies) lines.push(`${fmtInt(t.companies)} companies`);
              if (t.year === peakYearValue) lines.push('Peak year on record');
              return lines;
            },
          },
        },
      },
    },
  });
}

/** A single company's events over time. */
export function companyChart(events) {
  const ordered = events.slice().sort((a, b) => (a.date < b.date ? -1 : 1));
  return mount('chart-company', {
    type: 'bar',
    data: {
      labels: ordered.map((e) => fmtDate(e.date)),
      datasets: [{
        data: ordered.map((e) => (typeof e.laidOff === 'number' ? e.laidOff : null)),
        backgroundColor: (c) => vGradient(c.chart.ctx, c.chart.chartArea, C.accent, 'rgba(255,180,84,0.4)'),
        borderRadius: 5,
        maxBarThickness: 46,
      }],
    },
    options: {
      scales: { y: yScale(), x: xScale({ ticks: { maxRotation: 0, autoSkip: true } }) },
      plugins: {
        tooltip: {
          ...baseTooltip,
          callbacks: {
            title: (it) => ordered[it[0].dataIndex].company,
            label: (it) => {
              const e = ordered[it.dataIndex];
              const lines = [fmtDate(e.date)];
              lines.push(typeof e.laidOff === 'number' ? `${fmtInt(e.laidOff)} laid off` : 'Headcount undisclosed');
              if (typeof e.percentage === 'number') lines.push(`${e.percentage}% of company`);
              lines.push(`Source: ${e.source} (${e.confidence})`);
              return lines;
            },
          },
        },
      },
    },
  });
}

export function resizeAll() {
  Object.values(instances).forEach((c) => c && c.resize());
}
