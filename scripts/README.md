# Data-refresh pipeline

This directory holds the Python pipeline that refreshes the JSON data the
**tech-layoffs-tracker** website reads from `data/`. It pulls layoff events from one or
more source adapters, merges + dedupes them into the existing data, and writes the
result back — all using the **Python standard library only** (target: Python 3.9+).

```
scripts/
├── refresh.py             # orchestrator (CLI)
├── requirements.txt       # intentionally empty — stdlib only
├── README.md              # this file
└── adapters/
    ├── __init__.py        # ADAPTERS registry
    ├── warn.py            # US state WARN-notice adapter (live: Texas)
    └── layoffs_fyi.py     # Layoffs.fyi via Apify actor (opt-in with a token)
```

## Running it

From the repository root:

```bash
# Full run: fetch live data and write data/events.json + data/meta.json
python3 scripts/refresh.py

# Compute and print a summary but DO NOT write any files
python3 scripts/refresh.py --dry-run

# Offline self-test: runs adapters against bundled fixtures (no network).
# Use this to exercise the merge/dedupe path anywhere, including CI smoke tests.
python3 scripts/refresh.py --self-test --dry-run --verbose

# Run only one adapter
python3 scripts/refresh.py --source warn
python3 scripts/refresh.py --source layoffs_fyi

# More logging
python3 scripts/refresh.py --verbose
```

### Flags

| Flag          | Effect                                                                 |
|---------------|------------------------------------------------------------------------|
| `--dry-run`   | Do everything except write `data/*.json`. Prints the summary.          |
| `--source N`  | Run only the adapter named `N` (`warn`, `layoffs_fyi`).                |
| `--self-test` | Use each adapter's bundled offline fixture. No network is touched.     |
| `--verbose`   | Debug-level logging.                                                    |

### Exit codes

- **0** — success, *including* "nothing changed" and "a source was unreachable".
  Unreachable sources are expected (network may be blocked) and are logged as
  warnings, never treated as failures.
- **non-zero** — only for genuinely unexpected internal errors, or an unknown
  `--source` name.

## Data files and their shape

The pipeline reads and writes two files:

- `data/events.json` — the layoff events. The website ships this as an object that
  wraps the array under an `"events"` key (`{ "events": [ … ] }`). The pipeline
  **auto-detects** whether the file is a bare array or a wrapper object and **writes
  back in the same shape**, preserving any other top-level keys. If the file is
  missing it is treated as empty (it is **not** seeded here — another process owns the
  seed data).
- `data/meta.json` — refresh metadata. The pipeline updates `lastUpdated`,
  `lastRefresh`, `generatedBy` (→ `"refresh"`) and recomputes `sourceCounts`. It
  **preserves** existing descriptive fields (`primarySource`, `methodology`,
  `coverageNote`, and any extra keys such as `honesty`/`disclaimer`).

Output is written with `indent=2`, `ensure_ascii=False`, and a trailing newline, and
events are sorted by **date descending, then company ascending**, so day-to-day diffs
stay small and readable.

## Merge & dedupe rules

Incoming events are merged into the existing set using two dedupe keys:

1. **Exact `id`** (the stable slug, e.g. `oracle-2026-01`).
2. **Fuzzy key**: `lowercased(company)` + `date` + `laidOff`. If an incoming event
   matches an existing one on this key, it is **not** duplicated.

When a duplicate is found, the records are merged:

- The **higher-confidence** record wins as the base (`confirmed` > `estimated` >
  `unknown`).
- Any `null` field on the base is filled from the other record.
- The **earliest** `date` is kept.
- `importedAt` is set to today; `year` is recomputed from the final `date`.

New events get a stable slug `company-YYYY-MM`, with a numeric suffix (`-2`, `-3`, …)
only if needed to stay unique.

## Sources / adapters

### `warn.py` — US state WARN notices (live source: **Texas**)

WARN notices are public state filings under the federal *Worker Adjustment and
Retraining Notification Act*. Each row is a confirmed event, so these are mapped with
`confidence = "confirmed"` and `source = "<State> WARN Notice"`.

The live adapter targets the **Texas Workforce Commission** WARN dataset, published as
a stable, key-free Socrata CSV:

- Landing: <https://data.texas.gov/d/8w53-c4f6>
- CSV: `https://data.texas.gov/api/views/8w53-c4f6/rows.csv?accessType=DOWNLOAD`

It fetches over HTTPS with a 15-second timeout and a `User-Agent` header, keeps the
most-recent rows (bounded so one source can't dominate the dataset), and maps the
location to `CITY_NAME, COUNTY County, TX, USA`. On **any** error it logs a warning and
returns an empty list.

#### Adding more states

States expose WARN data differently. For any state that publishes a **Socrata CSV**
(e.g. Oregon: `data.oregon.gov`, dataset *WARN*), adding it is just a config entry —
append to `STATE_SOURCES` in `adapters/warn.py`:

```python
{
    "key": "OR",
    "label": "Oregon WARN Notice",
    "url": "https://data.oregon.gov/api/views/<id>/rows.csv?accessType=DOWNLOAD",
    "landing": "https://data.oregon.gov/d/<id>",
    "state_full": "OR, USA",
    "col_company": "<company column>",
    "col_date": "<notice date column>",
    "col_count": "<headcount column>",
    "col_city": "<city column>",       # optional
    "col_county": "<county column>",   # optional
    "col_effective": "<layoff date>",  # optional, used in notes
    "date_format": "%m/%d/%Y",         # strptime format of the source dates
},
```

The generic `_fetch_csv_text` + `_map_socrata_row` helpers handle the rest. For
**HTML-only** states (many publish a table, not a CSV), write a small `html.parser`
subclass that yields the same intermediate fields and feed them through
`_finalize_event`.

### `layoffs_fyi.py` — Layoffs.fyi via Apify (opt-in)

Layoffs.fyi has no stable public data API, so this adapter goes through an Apify actor
(*Tech Layoff Intelligence Tracker*) that scrapes and normalizes it. Results are mapped
with `source = "Layoffs.fyi"` and `confidence = "estimated"` (it is a crowd-sourced
aggregator, not a primary filing).

It is **opt-in**:

```bash
export APIFY_TOKEN="apify_api_xxx"          # required to enable live fetches
export APIFY_ACTOR_ID="username~actor-name" # optional: override the default actor
python3 scripts/refresh.py --source layoffs_fyi
```

If `APIFY_TOKEN` is not set, the adapter logs
`layoffs_fyi: skipped (set APIFY_TOKEN to enable)` and returns nothing. Under
`--self-test` it returns a tiny hardcoded sample so the merge path is exercised
offline. On any network/parse error it logs a warning and returns an empty list.

The endpoint used is the actor's synchronous run-and-fetch REST call:

```
POST https://api.apify.com/v2/acts/<ACTOR_ID>/run-sync-get-dataset-items?token=<TOKEN>
```

## Honesty rules (important)

This tracker is only as trustworthy as its discipline about uncertainty. The pipeline
enforces:

- **Never invent numbers.** If a source does not provide a field (headcount,
  percentage, location, industry, …), it is stored as `null` — never guessed,
  rounded, or back-filled from unrelated data.
- **Confidence labels are meaningful.** `confirmed` = official filing (e.g. WARN).
  `estimated` = aggregator/reported figure (e.g. Layoffs.fyi). `unknown` = the source
  gave no count. On a merge, the higher-confidence record wins.
- **Provenance is preserved.** Every event keeps its `source`, `sourceUrl`, and the
  `importedAt` date it was added or last refreshed.
- **Sources fail soft.** A blocked network or a broken source produces a warning and an
  empty result, never a crash and never fabricated filler.

## Automation

`.github/workflows/refresh-data.yml` runs this pipeline daily (12:00 UTC) and on manual
dispatch, then commits any changes under `data/`. Set the optional `APIFY_TOKEN`
repository secret to enable the Layoffs.fyi adapter in CI.
