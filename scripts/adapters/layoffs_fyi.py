"""Layoffs.fyi adapter (via Apify "Tech Layoff Intelligence Tracker" actor).

This adapter pulls tech-industry layoff events that ultimately trace back to the
community-maintained Layoffs.fyi dataset. Because Layoffs.fyi itself has no stable
public JSON/CSV API, we go through an Apify actor that scrapes and normalizes it.

Enabling live fetches
---------------------
Set the environment variable ``APIFY_TOKEN`` to an Apify API token. When set, this
module calls the actor's "run-sync-get-dataset-items" REST endpoint, which runs the
actor synchronously and returns the resulting dataset items as JSON in one request:

    https://api.apify.com/v2/acts/<ACTOR_ID>/run-sync-get-dataset-items?token=<TOKEN>

The actor id is configurable via the ``APIFY_ACTOR_ID`` env var so you can point at a
specific actor build without editing code. It defaults to a tilde-separated
``username~actor-name`` slug for the Tech Layoff Intelligence Tracker.

If ``APIFY_TOKEN`` is not set, the adapter logs that it was skipped and returns [] so
the rest of the pipeline keeps working. Under ``self_test=True`` it returns a tiny
hardcoded sample (no network) purely to exercise the merge/dedupe path offline.

Honesty rules
-------------
We never fabricate numbers. ``confidence`` is set to "estimated" because Layoffs.fyi is
a crowd-sourced aggregator rather than a primary filing. Any field the source does not
provide is left as ``None``.
"""

import json
import logging
import os
import urllib.error
import urllib.parse
import urllib.request
from datetime import date
from typing import Any, Dict, List, Optional

logger = logging.getLogger("refresh.layoffs_fyi")

SOURCE_NAME = "Layoffs.fyi"
# Default Apify actor slug (username~actor-name). Override with APIFY_ACTOR_ID.
DEFAULT_ACTOR_ID = "harvest~tech-layoff-intelligence-tracker"
HTTP_TIMEOUT = 30  # seconds; actor run-sync can take a little while
USER_AGENT = "tech-layoffs-tracker-refresh/1.0 (+https://github.com/)"

# A tiny, clearly-synthetic sample used only for --self-test. These are NOT real
# numbers and exist solely to drive the offline merge/dedupe code path.
_SELF_TEST_SAMPLE: List[Dict[str, Any]] = [
    {
        "company": "ExampleCorp",
        "date": "2026-02-15",
        "laidOff": 1200,
        "percentage": 8,
        "companyHQ": "San Francisco, CA, USA",
        "industry": "Consumer",
    },
    {
        "company": "SampleSoft",
        "date": "2026-01-20",
        "laidOff": None,
        "percentage": None,
        "companyHQ": "Seattle, WA, USA",
        "industry": "Enterprise Software",
    },
]


def _coerce_int(value: Any) -> Optional[int]:
    """Best-effort convert a value to int, returning None on failure."""
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str):
        cleaned = value.replace(",", "").replace("+", "").strip()
        if cleaned == "":
            return None
        try:
            return int(float(cleaned))
        except ValueError:
            return None
    return None


def _coerce_number(value: Any) -> Optional[float]:
    """Best-effort convert a value to a float (e.g. percentage), else None."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        cleaned = value.replace("%", "").strip()
        if cleaned == "":
            return None
        try:
            return float(cleaned)
        except ValueError:
            return None
    return None


def _normalize_date(value: Any) -> Optional[str]:
    """Normalize a raw date value to YYYY-MM-DD (or None).

    Accepts already-ISO strings (full or YYYY-MM, which becomes the 1st), or a few
    other common shapes. The orchestrator re-derives ``year`` from this, so a clean
    value here matters.
    """
    if not value:
        return None
    if not isinstance(value, str):
        value = str(value)
    text = value.strip()
    if not text:
        return None
    # YYYY-MM-DD
    if len(text) >= 10 and text[4] == "-" and text[7] == "-":
        return text[:10]
    # YYYY-MM -> first of month
    if len(text) == 7 and text[4] == "-":
        return text + "-01"
    # YYYY only -> Jan 1
    if len(text) == 4 and text.isdigit():
        return text + "-01-01"
    return None


def _map_item(raw: Dict[str, Any], source_url: Optional[str]) -> Optional[Dict[str, Any]]:
    """Map one actor dataset item to the website's event schema.

    Returns None if the item lacks the minimum identifying fields (company + date).
    Field names below cover the common variants emitted by Layoffs.fyi-style datasets;
    unknown fields are simply ignored and left null.
    """
    company = (
        raw.get("company")
        or raw.get("Company")
        or raw.get("companyName")
        or raw.get("name")
    )
    raw_date = (
        raw.get("date")
        or raw.get("Date")
        or raw.get("dateLaidOff")
        or raw.get("date_added")
        or raw.get("reportedDate")
    )
    norm_date = _normalize_date(raw_date)
    if not company or not norm_date:
        return None

    laid_off = _coerce_int(
        raw.get("laidOff")
        if raw.get("laidOff") is not None
        else raw.get("totalLaidOff")
        if raw.get("totalLaidOff") is not None
        else raw.get("employeesLaidOff")
        if raw.get("employeesLaidOff") is not None
        else raw.get("Laid_Off")
    )
    percentage = _coerce_number(
        raw.get("percentage")
        if raw.get("percentage") is not None
        else raw.get("percent")
        if raw.get("percent") is not None
        else raw.get("Percentage")
    )
    hq = (
        raw.get("companyHQ")
        or raw.get("headquarters")
        or raw.get("location")
        or raw.get("Location")
        or raw.get("country")
    )
    industry = raw.get("industry") or raw.get("Industry")
    src_url = raw.get("sourceUrl") or raw.get("source") or source_url

    return {
        "id": None,  # orchestrator assigns a stable slug
        "company": str(company).strip(),
        "date": norm_date,
        "laidOff": laid_off,
        "percentage": percentage,
        "companyHQ": str(hq).strip() if hq else None,
        "employeeLocation": None,
        "industry": str(industry).strip() if industry else None,
        "source": SOURCE_NAME,
        "sourceUrl": src_url if (src_url and str(src_url).startswith("http")) else "https://layoffs.fyi/",
        "confidence": "estimated",
        "year": None,  # orchestrator derives from date
        "importedAt": date.today().isoformat(),
        "notes": None,
    }


def _build_self_test_events() -> List[Dict[str, Any]]:
    events: List[Dict[str, Any]] = []
    for raw in _SELF_TEST_SAMPLE:
        mapped = _map_item(raw, "https://layoffs.fyi/")
        if mapped is not None:
            events.append(mapped)
    return events


def fetch_events(self_test: bool = False) -> List[Dict[str, Any]]:
    """Return a list of layoff-event dicts mapped to the website schema.

    - self_test=True: return a tiny offline sample (no network).
    - APIFY_TOKEN unset: skip with a log line and return [].
    - APIFY_TOKEN set: call the Apify actor and map its dataset items.

    Any error results in a logged warning and an empty list (fail soft).
    """
    if self_test:
        return _build_self_test_events()

    token = os.environ.get("APIFY_TOKEN")
    if not token:
        logger.info("layoffs_fyi: skipped (set APIFY_TOKEN to enable)")
        return []

    actor_id = os.environ.get("APIFY_ACTOR_ID", DEFAULT_ACTOR_ID)
    endpoint = (
        "https://api.apify.com/v2/acts/"
        + urllib.parse.quote(actor_id, safe="~")
        + "/run-sync-get-dataset-items?token="
        + urllib.parse.quote(token, safe="")
        + "&format=json&clean=true"
    )

    try:
        req = urllib.request.Request(
            endpoint,
            headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
            payload = resp.read().decode("utf-8", errors="replace")
        items = json.loads(payload)
        if not isinstance(items, list):
            logger.warning("layoffs_fyi: unexpected payload (not a list); skipping")
            return []
    except (urllib.error.URLError, urllib.error.HTTPError) as exc:
        logger.warning("layoffs_fyi: network/HTTP error, skipping: %s", exc)
        return []
    except (ValueError, TimeoutError) as exc:
        logger.warning("layoffs_fyi: could not parse Apify response, skipping: %s", exc)
        return []
    except Exception as exc:  # noqa: BLE001 - fail soft, never abort the run
        logger.warning("layoffs_fyi: unexpected error, skipping: %s", exc)
        return []

    events: List[Dict[str, Any]] = []
    for raw in items:
        if not isinstance(raw, dict):
            continue
        mapped = _map_item(raw, "https://layoffs.fyi/")
        if mapped is not None:
            events.append(mapped)

    logger.info("layoffs_fyi: mapped %d events from Apify actor %s", len(events), actor_id)
    return events
