"""WARN-notice adapter.

Source targeted
---------------
Texas Workforce Commission "Worker Adjustment and Retraining Notification (WARN)
Notices", published as a stable Socrata open-data CSV on the Texas open data portal:

    https://data.texas.gov/d/8w53-c4f6
    CSV export: https://data.texas.gov/api/views/8w53-c4f6/rows.csv?accessType=DOWNLOAD

Texas was chosen because the dataset is a clean, header-stable CSV with one row per
notice, is updated regularly (entries through the current month), and requires no API
key. WARN filings are public state filings under the federal Worker Adjustment and
Retraining Notification Act, so each row is a "confirmed" event.

Column layout (as of this writing):
    NOTICE_DATE | JOB_SITE_NAME | COUNTY_NAME | WDA_NAME |
    TOTAL_LAYOFF_NUMBER | LayOff_Date | WFDD_RECEIVED_DATE | CITY_NAME

Mapping to the website event schema:
    company           <- JOB_SITE_NAME
    date              <- NOTICE_DATE (MM/DD/YYYY -> YYYY-MM-DD)
    laidOff           <- TOTAL_LAYOFF_NUMBER (int, or null)
    companyHQ         <- "<CITY_NAME>, <COUNTY> County, TX, USA" (best-effort)
    employeeLocation  <- same as companyHQ (the filing's job-site location)
    source            <- "Texas WARN Notice"
    confidence        <- "confirmed"
    sourceUrl         <- the dataset landing page
    industry          <- null (not present in this dataset)
    notes             <- brief, e.g. "WARN filing; effective <LayOff_Date>"

How to add more states
----------------------
Each state's open data portal exposes WARN slightly differently. To add another state:

  1. Find a stable, key-free CSV (or simple HTML table) endpoint. Good candidates that
     also expose Socrata CSVs include Oregon (data.oregon.gov, dataset "WARN") and
     others; many states only publish HTML, which needs a small html.parser subclass.
  2. Add a STATE_SOURCES entry below with: the CSV url, the column names for company /
     date / count / city, the human source label, and a date format.
  3. The generic ``_fetch_socrata_csv`` + ``_map_socrata_row`` helpers handle the rest.
     For HTML-only states, write a dedicated parser that yields the same intermediate
     dicts and feed them through ``_finalize_event``.

Robustness
----------
A short timeout (15s) and a User-Agent header are set. ANY exception (network down,
bad payload, schema drift) is caught, logged as a warning, and results in an empty
list so the adapter never aborts the overall refresh run.
"""

import csv
import io
import logging
import urllib.error
import urllib.request
from datetime import date, datetime
from typing import Any, Dict, List, Optional

logger = logging.getLogger("refresh.warn")

HTTP_TIMEOUT = 15  # seconds
USER_AGENT = "tech-layoffs-tracker-refresh/1.0 (+https://github.com/)"
# Cap how many rows we map per run so a single source can't dominate the dataset.
MAX_ROWS = 60


# ---------------------------------------------------------------------------
# State source configuration. Add new Socrata-CSV states here.
# ---------------------------------------------------------------------------
STATE_SOURCES: List[Dict[str, Any]] = [
    {
        "key": "TX",
        "label": "Texas WARN Notice",
        "url": "https://data.texas.gov/api/views/8w53-c4f6/rows.csv?accessType=DOWNLOAD",
        "landing": "https://data.texas.gov/d/8w53-c4f6",
        "state_full": "TX, USA",
        "col_company": "JOB_SITE_NAME",
        "col_date": "NOTICE_DATE",
        "col_count": "TOTAL_LAYOFF_NUMBER",
        "col_city": "CITY_NAME",
        "col_county": "COUNTY_NAME",
        "col_effective": "LayOff_Date",
        "date_format": "%m/%d/%Y",
    },
]


# ---------------------------------------------------------------------------
# Bundled fixture for --self-test (NO network). A small slice of the Texas CSV
# shape; values are illustrative and only drive the offline mapping path.
# ---------------------------------------------------------------------------
_FIXTURE_CSV = (
    "NOTICE_DATE,JOB_SITE_NAME,COUNTY_NAME,WDA_NAME,TOTAL_LAYOFF_NUMBER,LayOff_Date,WFDD_RECEIVED_DATE,CITY_NAME\n"
    "03/15/2026,Acme Robotics LLC,Travis,Capital Area WDA,420,05/01/2026,03/16/2026,Austin\n"
    "02/28/2026,Globex Manufacturing,Harris,Gulf Coast WDA,150,04/15/2026,03/01/2026,Houston\n"
    "01/10/2026,Initech Services,Dallas,Dallas County WDA,,03/10/2026,01/11/2026,Dallas\n"
)


def _coerce_int(value: Any) -> Optional[int]:
    if value is None:
        return None
    text = str(value).replace(",", "").strip()
    if text == "":
        return None
    try:
        return int(float(text))
    except ValueError:
        return None


def _parse_date(value: Any, fmt: str) -> Optional[str]:
    """Parse a source date string to YYYY-MM-DD, else None."""
    if not value:
        return None
    text = str(value).strip()
    if not text:
        return None
    try:
        return datetime.strptime(text, fmt).date().isoformat()
    except ValueError:
        # Fallback: maybe it's already ISO.
        if len(text) >= 10 and text[4] == "-" and text[7] == "-":
            return text[:10]
        return None


def _location(city: Optional[str], county: Optional[str], state_full: str) -> Optional[str]:
    parts: List[str] = []
    city = (city or "").strip()
    county = (county or "").strip()
    if city:
        parts.append(city)
    if county:
        parts.append(county + " County")
    parts.append(state_full)
    return ", ".join(parts) if parts else None


def _finalize_event(
    company: str,
    iso_date: str,
    laid_off: Optional[int],
    location: Optional[str],
    source_label: str,
    landing: str,
    effective: Optional[str],
) -> Dict[str, Any]:
    note = "WARN filing"
    if effective:
        note = "WARN filing; effective " + effective
    return {
        "id": None,  # orchestrator assigns a stable slug
        "company": company.strip(),
        "date": iso_date,
        "laidOff": laid_off,
        "percentage": None,
        "companyHQ": location,
        "employeeLocation": location,
        "industry": None,
        "source": source_label,
        "sourceUrl": landing,
        "confidence": "confirmed",
        "year": None,  # orchestrator derives from date
        "importedAt": date.today().isoformat(),
        "notes": note,
    }


def _map_socrata_row(row: Dict[str, str], cfg: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    company = (row.get(cfg["col_company"]) or "").strip()
    iso_date = _parse_date(row.get(cfg["col_date"]), cfg["date_format"])
    if not company or not iso_date:
        return None
    laid_off = _coerce_int(row.get(cfg["col_count"]))
    location = _location(
        row.get(cfg.get("col_city")),
        row.get(cfg.get("col_county")),
        cfg["state_full"],
    )
    effective = _parse_date(row.get(cfg.get("col_effective")), cfg["date_format"])
    return _finalize_event(
        company=company,
        iso_date=iso_date,
        laid_off=laid_off,
        location=location,
        source_label=cfg["label"],
        landing=cfg["landing"],
        effective=effective,
    )


def _rows_from_csv_text(text: str) -> List[Dict[str, str]]:
    return list(csv.DictReader(io.StringIO(text)))


def _fetch_csv_text(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "text/csv"})
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
        return resp.read().decode("utf-8", errors="replace")


def _events_from_rows(rows: List[Dict[str, str]], cfg: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Map rows, keep the most-recent MAX_ROWS by date (newest first)."""
    mapped: List[Dict[str, Any]] = []
    for row in rows:
        event = _map_socrata_row(row, cfg)
        if event is not None:
            mapped.append(event)
    # Newest first, then take the most recent slice so one source stays bounded.
    mapped.sort(key=lambda e: e["date"], reverse=True)
    return mapped[:MAX_ROWS]


def fetch_events(self_test: bool = False) -> List[Dict[str, Any]]:
    """Return WARN events mapped to the website schema.

    self_test=True parses the bundled fixture (no network). Otherwise each configured
    state CSV is fetched over https; any failure for a given state is logged and
    skipped, and a total failure yields []. The adapter never raises.
    """
    if self_test:
        cfg = STATE_SOURCES[0]
        try:
            rows = _rows_from_csv_text(_FIXTURE_CSV)
            return _events_from_rows(rows, cfg)
        except Exception as exc:  # noqa: BLE001 - defensive
            logger.warning("warn: self-test fixture parse failed: %s", exc)
            return []

    all_events: List[Dict[str, Any]] = []
    for cfg in STATE_SOURCES:
        try:
            text = _fetch_csv_text(cfg["url"])
            rows = _rows_from_csv_text(text)
            events = _events_from_rows(rows, cfg)
            logger.info("warn: %s -> %d events (of %d rows)", cfg["label"], len(events), len(rows))
            all_events.extend(events)
        except (urllib.error.URLError, urllib.error.HTTPError) as exc:
            logger.warning("warn: %s network/HTTP error, skipping: %s", cfg["label"], exc)
        except (csv.Error, ValueError, TimeoutError) as exc:
            logger.warning("warn: %s parse error, skipping: %s", cfg["label"], exc)
        except Exception as exc:  # noqa: BLE001 - fail soft, never abort the run
            logger.warning("warn: %s unexpected error, skipping: %s", cfg["label"], exc)
    return all_events
