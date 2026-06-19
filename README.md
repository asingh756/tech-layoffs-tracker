# Tech Layoffs Tracker

A live-style dashboard that tracks tech-industry layoffs: the current-year count front
and center, historical trends, company leaderboards, and a fully sourced events table.

It is a **static website** — plain HTML/CSS/JavaScript with a vendored copy of Chart.js
and a structured JSON data layer. No build step, no framework, no server required to view
it. A small Python pipeline (standard library only) refreshes the data from public sources
on a schedule.

> **Headline:** “Number of tech layoffs in 2026: 185,894” — the year and number update with
> the selected/current year, and every figure carries its source and a confidence label.

---

## Why this exists / guiding principle

Layoff numbers vary a lot between trackers because each one counts differently. Rather than
pretend there is one true number, this project is **honest about provenance**:

- **Numbers are never invented.** When a source doesn't disclose a headcount, the site shows
  *Unknown* (e.g. Rivian and Intel's 2025 cut) instead of a guess.
- **Estimates are labeled** distinctly from confirmed figures (`confirmed` / `estimated` / `unknown`).
- **Every data point stores its source** and the date it was imported/refreshed.
- A **coverage indicator** makes clear that the itemized events are a curated subset of the
  larger authoritative annual totals — the site doesn't pretend to enumerate every layoff.

---

## Features

| View | What it shows |
| --- | --- |
| **Dashboard** | Big headline count for the selected year, year selector, historical line chart, monthly breakdown, company leaderboard, biggest events, a trend summary ("up X% vs last year"), and a coverage note. |
| **By Company** | Search/select any tracked company; see total tracked layoffs, whether it ran **multiple rounds**, an events-over-time chart, and a sourced table (date, headcount, %, location, source, confidence). |
| **Historical** | Layoffs by year with the **peak year highlighted**, a two-year comparison tool, and a full annual table with year-over-year change. |
| **Events** | Every tracked event in one sortable, filterable table: company, date, headcount, % of company, location, industry, source, confidence. |

Deep-linkable via URL hash: `#dashboard`, `#company=Meta`, `#historical`, `#events`.

---

## Data sources

Ranked by how this project weights them. Each event/total records which source it came from.

| Source | Type | Why it's used |
| --- | --- | --- |
| [WARN notices](https://www.dol.gov/agencies/eta/layoffs/warn) | Government filing | Official US state filings legally required for mass layoffs. Authoritative and public — the basis of the automated refresh. |
| [Layoffs.fyi](https://layoffs.fyi/) | Aggregator | The de-facto standard tech-layoff tracker. Provides the authoritative annual totals (free to use with attribution). |
| [TrueUp](https://www.trueup.io/layoffs) | Aggregator | Cross-check on event counts and people impacted. |
| [Crunchbase News](https://news.crunchbase.com/startups/tech-layoffs/) | Editorial | US-focused weekly tracker; source for several recent events. |
| [Computerworld](https://www.computerworld.com/article/3816579/tech-layoffs-this-year-a-timeline.html) / [TechCrunch](https://techcrunch.com/2025/12/22/tech-layoffs-2025-list/) / [Tech.co](https://tech.co/news/tech-companies-layoffs) | Media | Per-company headcounts and dates for individual events. |

**On the 2026 number:** trackers disagree (Layoffs.fyi ~100K+, TrueUp ~154K, aggregate
trackers ~186K). The dashboard shows the headline figure with a "trackers vary" breakdown so
the disagreement is visible rather than hidden.

---

## Data model

The **layoff events list is the single source of truth** for itemized views; annual totals
are stored separately as the authoritative aggregate. All four datasets live in `data/`:

- `data/annual-totals.json` — authoritative per-year totals (`year`, `total`, `companies`,
  `source`, `sourceUrl`, `confidence`, `asOf`, `note`, and a per-source `estimates` breakdown for the current year).
- `data/events.json` — individual events. Each event:

  ```json
  {
    "id": "oracle-2026-01",
    "company": "Oracle",
    "date": "2026-01-30",
    "laidOff": 30000,
    "percentage": null,
    "companyHQ": "Austin, TX, USA",
    "employeeLocation": null,
    "industry": "Enterprise Software / Cloud",
    "source": "Computerworld",
    "sourceUrl": "https://www.computerworld.com/...",
    "confidence": "estimated",
    "year": 2026,
    "importedAt": "2026-06-18",
    "notes": "Reported as 'up to 30,000' — the largest single 2026 layoff."
  }
  ```

- `data/sources.json` — the source registry (name, URL, type, credibility, description).
- `data/meta.json` — `lastUpdated`, methodology, honesty principles, disclaimer.

The browser computes everything else (monthly buckets, leaderboards, trends, coverage,
company profiles, dedupe) in [`js/data.js`](js/data.js).

---

## Project structure

```
.
├── index.html              # the whole UI (four views)
├── css/styles.css          # dashboard theme
├── js/
│   ├── app.js              # controller: routing + rendering
│   ├── data.js             # single source of truth: load + aggregate + dedupe
│   ├── charts.js           # Chart.js wrappers
│   ├── format.js           # pure formatting helpers
│   └── vendor/chart.umd.min.js   # vendored Chart.js (no runtime CDN dependency)
├── data/                   # the JSON datasets (see above)
├── scripts/
│   ├── refresh.py          # data refresh pipeline (stdlib only)
│   ├── adapters/           # warn.py (Texas WARN), layoffs_fyi.py (Apify, optional)
│   └── serve.py            # local static server for previewing
└── .github/workflows/refresh-data.yml   # scheduled auto-refresh
```

---

## Run it locally

No dependencies. Because the page loads JSON via `fetch`, it must be served over HTTP
(opening `index.html` directly with `file://` is blocked by the browser):

```bash
python3 scripts/serve.py      # serves the project at http://127.0.0.1:8000
```

Then open <http://127.0.0.1:8000>.

---

## Refreshing the data

The pipeline pulls fresh events from public sources, **dedupes** them against the existing
dataset (by id and by company+date+headcount, keeping the highest-confidence record), and
updates `data/`. It never invents numbers and fails soft if a source is unreachable.

```bash
python3 scripts/refresh.py                     # live fetch + write
python3 scripts/refresh.py --dry-run --verbose # compute, write nothing
python3 scripts/refresh.py --self-test         # offline, exercises merge/dedupe with fixtures
python3 scripts/refresh.py --source warn       # run a single adapter
```

**Adapters:**
- `warn` — pulls public **Texas WARN** filings from the state's key-free Socrata CSV. Add
  more states by following the pattern in [`scripts/adapters/warn.py`](scripts/adapters/warn.py).
- `layoffs_fyi` — **opt-in**. Set `APIFY_TOKEN` (Apify "Tech Layoff Intelligence Tracker"
  actor) to enable; otherwise it cleanly skips. See [`scripts/README.md`](scripts/README.md).

### Automated refresh

[`.github/workflows/refresh-data.yml`](.github/workflows/refresh-data.yml) runs the pipeline
daily (12:00 UTC) and on demand, then commits any data changes back to the repo. To enable
the Layoffs.fyi adapter in CI, add an `APIFY_TOKEN` repository secret.

---

## Deploy (GitHub Pages)

This is a static site, so GitHub Pages works out of the box:

1. Push to GitHub (already configured for `git@github.com:asingh756/tech-layoffs-tracker.git`).
2. Repo **Settings → Pages → Build and deployment → Source: Deploy from a branch**, select
   `main` / `root`.
3. The site publishes at `https://asingh756.github.io/tech-layoffs-tracker/`.

---

## Tech stack

Vanilla JavaScript (ES modules), Chart.js (vendored), Python 3 standard library for the
pipeline. No framework, no bundler, no install.

## Disclaimer

This site aggregates publicly reported data for informational purposes only and is not
affiliated with any of the cited sources. Figures vary by source and methodology — always
consult the original source linked on each data point.
