#!/usr/bin/env python3
"""Refresh orchestrator for the tech-layoffs-tracker static site.

Loads the existing data the website reads (``data/events.json`` and ``data/meta.json``),
runs each registered source adapter, merges + dedupes incoming events into the existing
set, then writes the result back (unless ``--dry-run``).

Design goals:
  * Standard library only (Python 3.9+). No third-party packages.
  * Fail soft: a single unreachable/broken source never aborts the whole run.
  * Honest data: never fabricate numbers; unknown fields stay ``None``.
  * Stable diffs: deterministic sort and pretty-printed JSON with a trailing newline.

Usage:
    python3 scripts/refresh.py                 # fetch live, write files
    python3 scripts/refresh.py --dry-run       # compute, print summary, write nothing
    python3 scripts/refresh.py --self-test     # offline fixtures, exercises merge path
    python3 scripts/refresh.py --source warn   # run only one adapter
    python3 scripts/refresh.py --verbose       # debug-level logging

Exit code is 0 even when nothing changed or sources were unreachable. A non-zero exit
is reserved for genuinely unexpected internal errors.
"""

import argparse
import json
import logging
import os
import re
import sys
from datetime import date, datetime
from typing import Any, Dict, List, Optional, Tuple

# Allow running both as a module and as a plain script (python3 scripts/refresh.py).
try:
    from adapters import ADAPTERS
except ImportError:  # pragma: no cover - path shim for direct invocation
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from adapters import ADAPTERS

logger = logging.getLogger("refresh")

# Paths are resolved relative to the repo root (parent of this scripts/ dir) so the
# pipeline works regardless of the current working directory (local or CI).
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(SCRIPT_DIR)
DATA_DIR = os.path.join(REPO_ROOT, "data")
EVENTS_PATH = os.path.join(DATA_DIR, "events.json")
META_PATH = os.path.join(DATA_DIR, "meta.json")

CONFIDENCE_RANK = {"confirmed": 3, "estimated": 2, "unknown": 1}

# Canonical event field set, with defaults, used to normalize every record.
EVENT_FIELDS: Dict[str, Any] = {
    "id": None,
    "company": None,
    "date": None,
    "laidOff": None,
    "percentage": None,
    "companyHQ": None,
    "employeeLocation": None,
    "industry": None,
    "source": None,
    "sourceUrl": None,
    "confidence": "unknown",
    "year": None,
    "importedAt": None,
    "notes": None,
}


# ---------------------------------------------------------------------------
# IO helpers
# ---------------------------------------------------------------------------
def load_json(path: str, default: Any) -> Any:
    """Load JSON from ``path``; return ``default`` if missing or unreadable.

    Per the project contract we do NOT create or seed these files here — if they are
    absent we simply behave as if events==[] and meta=={}.
    """
    if not os.path.exists(path):
        logger.info("%s not found; treating as %r", os.path.relpath(path, REPO_ROOT), default)
        return default
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (ValueError, OSError) as exc:
        logger.warning("could not read %s (%s); treating as %r", path, exc, default)
        return default


def write_json(path: str, data: Any) -> None:
    """Write ``data`` as pretty JSON with a trailing newline (stable diffs)."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    text = json.dumps(data, indent=2, ensure_ascii=False)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(text)
        fh.write("\n")


# The website's data/events.json may be either a bare JSON array OR an object that
# wraps the array under an "events" key (the shipped seed uses the wrapper). We must
# read either shape and, critically, write back in the SAME shape we read so we never
# break the file the website actually consumes. ``EVENTS_KEY`` is that wrapper key.
EVENTS_KEY = "events"


def extract_events(raw: Any) -> List[Dict[str, Any]]:
    """Return the event list from a loaded events.json of either supported shape."""
    if isinstance(raw, list):
        return raw
    if isinstance(raw, dict):
        inner = raw.get(EVENTS_KEY)
        if isinstance(inner, list):
            return inner
    return []


def wrap_events(events: List[Dict[str, Any]], original: Any) -> Any:
    """Re-apply the original container shape around the new ``events`` list.

    If the file was a wrapper object, preserve its other top-level keys and only swap
    the events array. If it was a bare array (or missing), return a bare array.
    """
    if isinstance(original, dict):
        out = dict(original)
        out[EVENTS_KEY] = events
        return out
    return events


# ---------------------------------------------------------------------------
# Normalization
# ---------------------------------------------------------------------------
def _slugify_company(name: str) -> str:
    slug = name.lower().strip()
    slug = re.sub(r"[^a-z0-9]+", "-", slug)
    slug = re.sub(r"-+", "-", slug).strip("-")
    return slug or "company"


def _year_from_date(date_str: Optional[str]) -> Optional[int]:
    if not date_str or len(date_str) < 4:
        return None
    head = date_str[:4]
    if head.isdigit():
        return int(head)
    return None


def _normalize_date(date_str: Optional[str]) -> Optional[str]:
    """Coerce a date into YYYY-MM-DD. YYYY-MM becomes the 1st of the month."""
    if not date_str:
        return None
    text = str(date_str).strip()
    if not text:
        return None
    if len(text) >= 10 and text[4] == "-" and text[7] == "-":
        return text[:10]
    if len(text) == 7 and text[4] == "-":  # YYYY-MM
        return text + "-01"
    if len(text) == 4 and text.isdigit():  # YYYY
        return text + "-01-01"
    # Last resort: try a couple of common formats.
    for fmt in ("%Y/%m/%d", "%m/%d/%Y", "%d/%m/%Y"):
        try:
            return datetime.strptime(text, fmt).date().isoformat()
        except ValueError:
            continue
    return None


def base_slug(event: Dict[str, Any]) -> str:
    """company-YYYY-MM stable slug (without uniqueness suffix)."""
    company = event.get("company") or "company"
    date_str = event.get("date") or ""
    ym = date_str[:7].replace("-", "-") if len(date_str) >= 7 else "unknown"
    return "%s-%s" % (_slugify_company(company), ym)


def normalize_event(raw: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Return a fully-shaped event dict, or None if it lacks company+date.

    Fills missing keys with defaults, normalizes the date, derives ``year``, and
    ensures ``confidence`` is one of the allowed labels.
    """
    event = dict(EVENT_FIELDS)
    for key in EVENT_FIELDS:
        if key in raw and raw[key] is not None:
            event[key] = raw[key]

    company = (event.get("company") or "").strip()
    event["company"] = company or None
    event["date"] = _normalize_date(event.get("date"))

    if not event["company"] or not event["date"]:
        return None

    event["year"] = _year_from_date(event["date"])

    conf = (event.get("confidence") or "unknown").lower()
    event["confidence"] = conf if conf in CONFIDENCE_RANK else "unknown"

    # Numeric hygiene without inventing values.
    if event["laidOff"] is not None:
        try:
            event["laidOff"] = int(event["laidOff"])
        except (TypeError, ValueError):
            event["laidOff"] = None
    if event["percentage"] is not None:
        try:
            event["percentage"] = float(event["percentage"])
        except (TypeError, ValueError):
            event["percentage"] = None

    return event


# ---------------------------------------------------------------------------
# Dedupe keys
# ---------------------------------------------------------------------------
def fuzzy_key(event: Dict[str, Any]) -> Tuple[str, Optional[str], Optional[int]]:
    """lowercased(company) + date + laidOff."""
    company = (event.get("company") or "").lower().strip()
    return (company, event.get("date"), event.get("laidOff"))


def _confidence_rank(event: Dict[str, Any]) -> int:
    return CONFIDENCE_RANK.get((event.get("confidence") or "unknown").lower(), 1)


def merge_pair(existing: Dict[str, Any], incoming: Dict[str, Any], today: str) -> Dict[str, Any]:
    """Merge two records that refer to the same layoff event.

    Rules:
      * Prefer the higher-confidence record as the base.
      * Fill any null fields on the base from the other record.
      * Keep the earliest ``date``.
      * Set ``importedAt`` to today (this row was just refreshed).
      * Recompute ``year`` from the resulting date.
    """
    if _confidence_rank(incoming) > _confidence_rank(existing):
        base, other = dict(incoming), existing
    else:
        base, other = dict(existing), incoming

    for key in EVENT_FIELDS:
        if base.get(key) in (None, "") and other.get(key) not in (None, ""):
            base[key] = other[key]

    # Earliest date wins (string compare works for ISO YYYY-MM-DD).
    dates = [d for d in (existing.get("date"), incoming.get("date")) if d]
    if dates:
        base["date"] = min(dates)
    base["year"] = _year_from_date(base.get("date"))

    # Preserve the stable id if either side already had one.
    base["id"] = existing.get("id") or incoming.get("id") or base.get("id")

    base["importedAt"] = today
    return base


# ---------------------------------------------------------------------------
# Merge engine
# ---------------------------------------------------------------------------
class MergeState:
    """Holds the working set of events plus the id/fuzzy indexes during a merge."""

    def __init__(self, existing_events: List[Dict[str, Any]]):
        self.events: List[Dict[str, Any]] = []
        self.by_id: Dict[str, int] = {}
        self.by_fuzzy: Dict[Tuple[str, Optional[str], Optional[int]], int] = {}
        self._used_slugs: Dict[str, int] = {}

        for raw in existing_events:
            norm = normalize_event(raw)
            if norm is None:
                continue
            if not norm.get("id"):
                norm["id"] = self._assign_slug(norm)
            else:
                # Reserve the existing slug so new ones don't collide with it.
                self._reserve_slug(norm["id"])
            self._append(norm)

    def _reserve_slug(self, slug: str) -> None:
        # Record the slug so auto-generated ones never collide with it.
        self._used_slugs.setdefault(slug, 0)

    def _assign_slug(self, event: Dict[str, Any]) -> str:
        root = base_slug(event)
        if root not in self._used_slugs and root not in self.by_id:
            self._used_slugs[root] = 1  # bare root counts as occurrence #1
            return root
        # Collision: the bare root is #1, so suffixes start at -2, then -3, ...
        n = max(self._used_slugs.get(root, 1), 1) + 1
        candidate = "%s-%d" % (root, n)
        while candidate in self.by_id or candidate in self._used_slugs:
            n += 1
            candidate = "%s-%d" % (root, n)
        self._used_slugs[root] = n
        self._used_slugs[candidate] = 0
        return candidate

    def _append(self, event: Dict[str, Any]) -> None:
        idx = len(self.events)
        self.events.append(event)
        if event.get("id"):
            self.by_id[event["id"]] = idx
        self.by_fuzzy[fuzzy_key(event)] = idx

    def _replace(self, idx: int, event: Dict[str, Any]) -> None:
        old = self.events[idx]
        # Drop stale index entries for the old record.
        if old.get("id") in self.by_id:
            del self.by_id[old["id"]]
        old_fk = fuzzy_key(old)
        if self.by_fuzzy.get(old_fk) == idx:
            del self.by_fuzzy[old_fk]
        self.events[idx] = event
        if event.get("id"):
            self.by_id[event["id"]] = idx
        self.by_fuzzy[fuzzy_key(event)] = idx

    def add_incoming(self, raw: Dict[str, Any], today: str) -> str:
        """Merge one incoming event. Returns 'added', 'updated', or 'skipped'."""
        incoming = normalize_event(raw)
        if incoming is None:
            return "skipped"

        # Dedupe key 1: exact id.
        inc_id = incoming.get("id")
        if inc_id and inc_id in self.by_id:
            idx = self.by_id[inc_id]
            merged = merge_pair(self.events[idx], incoming, today)
            self._replace(idx, merged)
            return "updated"

        # Dedupe key 2: fuzzy (company + date + laidOff).
        fk = fuzzy_key(incoming)
        if fk in self.by_fuzzy:
            idx = self.by_fuzzy[fk]
            merged = merge_pair(self.events[idx], incoming, today)
            self._replace(idx, merged)
            return "updated"

        # New event: assign a slug if needed, then append.
        if not incoming.get("id"):
            incoming["id"] = self._assign_slug(incoming)
        elif incoming["id"] in self.by_id:
            incoming["id"] = self._assign_slug(incoming)
        incoming["importedAt"] = today
        self._append(incoming)
        return "added"


def sort_events(events: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Sort by date descending, then company ascending (stable diffs).

    ``_neg_date_key`` inverts the date so a single ascending sort yields newest-first
    on date while keeping company ascending as the tie-breaker.
    """
    return sorted(
        events,
        key=lambda e: (_neg_date_key(e.get("date")), (e.get("company") or "").lower()),
    )


def _neg_date_key(date_str: Optional[str]) -> str:
    """Return a string that sorts so newer dates come first under ascending sort.

    We invert each digit of the ISO date so plain ascending string sort yields
    descending chronological order, while keeping a stable, dependency-free key.
    Missing dates sort last.
    """
    if not date_str:
        return "~"  # '~' (0x7E) sorts after digits, pushing undated rows to the end
    inverted = "".join(str(9 - int(c)) if c.isdigit() else c for c in date_str)
    return inverted


# ---------------------------------------------------------------------------
# Meta
# ---------------------------------------------------------------------------
def build_meta(existing_meta: Dict[str, Any], events: List[Dict[str, Any]], today: str) -> Dict[str, Any]:
    source_counts: Dict[str, int] = {}
    for e in events:
        src = e.get("source") or "Unknown"
        source_counts[src] = source_counts.get(src, 0) + 1

    meta = dict(existing_meta) if isinstance(existing_meta, dict) else {}
    meta["lastUpdated"] = today
    meta["lastRefresh"] = today
    meta["generatedBy"] = "refresh"
    meta["sourceCounts"] = dict(sorted(source_counts.items()))

    # Preserve descriptive fields if the seed provided them; otherwise leave sensible
    # defaults so the website always has something to show.
    meta.setdefault("primarySource", "Layoffs.fyi")
    meta.setdefault(
        "methodology",
        "Aggregated from public state WARN filings (confirmed) and the Layoffs.fyi "
        "community dataset (estimated). Records are deduped by company, date, and "
        "headcount; higher-confidence sources win on conflict.",
    )
    meta.setdefault(
        "coverageNote",
        "Coverage is partial and skewed toward sources with machine-readable feeds. "
        "Numbers are never invented; unknown fields are left blank.",
    )
    return meta


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------
def select_adapters(only: Optional[str]):
    if not only:
        return list(ADAPTERS)
    chosen = [a for a in ADAPTERS if a.name == only]
    if not chosen:
        names = ", ".join(a.name for a in ADAPTERS)
        raise SystemExit("Unknown --source %r. Available: %s" % (only, names))
    return chosen


def run(args: argparse.Namespace) -> int:
    today = date.today().isoformat()

    # events.json may be a bare array or a {"events": [...]} wrapper; support both and
    # remember the original container so we write back in the same shape.
    events_raw = load_json(EVENTS_PATH, [])
    existing_events = extract_events(events_raw)
    existing_meta = load_json(META_PATH, {})
    if not isinstance(existing_meta, dict):
        existing_meta = {}

    before_count = len(existing_events)
    state = MergeState(existing_events)

    adapters = select_adapters(args.source)
    per_adapter: List[Tuple[str, int]] = []
    failed: List[str] = []
    added = 0
    updated = 0

    for adapter in adapters:
        try:
            incoming = adapter.fetch_events(self_test=args.self_test)
        except Exception as exc:  # noqa: BLE001 - never let one adapter abort the run
            logger.warning("adapter %r failed: %s", adapter.name, exc)
            failed.append(adapter.name)
            per_adapter.append((adapter.name, 0))
            continue

        if not isinstance(incoming, list):
            logger.warning("adapter %r returned non-list (%s); ignoring", adapter.name, type(incoming).__name__)
            failed.append(adapter.name)
            per_adapter.append((adapter.name, 0))
            continue

        count = 0
        for raw in incoming:
            if not isinstance(raw, dict):
                continue
            result = state.add_incoming(raw, today)
            if result == "added":
                added += 1
                count += 1
            elif result == "updated":
                updated += 1
                count += 1
        per_adapter.append((adapter.name, count))
        logger.info("adapter %r processed %d incoming events", adapter.name, count)

    final_events = sort_events(state.events)
    after_count = len(final_events)
    meta = build_meta(existing_meta, final_events, today)

    if args.dry_run:
        logger.info("dry-run: not writing files")
    else:
        write_json(EVENTS_PATH, wrap_events(final_events, events_raw))
        write_json(META_PATH, meta)
        logger.info("wrote %s and %s", os.path.relpath(EVENTS_PATH, REPO_ROOT), os.path.relpath(META_PATH, REPO_ROOT))

    _print_summary(before_count, after_count, added, updated, per_adapter, failed, meta, args.dry_run)
    return 0


def _print_summary(before, after, added, updated, per_adapter, failed, meta, dry_run):
    lines = []
    lines.append("=" * 56)
    lines.append("Refresh summary%s" % ("  (DRY RUN)" if dry_run else ""))
    lines.append("-" * 56)
    lines.append("events before : %d" % before)
    lines.append("events after  : %d" % after)
    lines.append("added         : %d" % added)
    lines.append("updated       : %d" % updated)
    lines.append("per-adapter:")
    if per_adapter:
        for name, count in per_adapter:
            flag = "  [FAILED]" if name in failed else ""
            lines.append("    %-14s %d%s" % (name, count, flag))
    else:
        lines.append("    (none)")
    lines.append("adapters failed: %s" % (", ".join(failed) if failed else "none"))
    lines.append("sourceCounts  : %s" % json.dumps(meta.get("sourceCounts", {}), ensure_ascii=False))
    lines.append("=" * 56)
    print("\n".join(lines))


def build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="refresh.py",
        description="Refresh the tech-layoffs-tracker data files from source adapters.",
    )
    p.add_argument("--dry-run", action="store_true", help="compute and summarize but do not write files")
    p.add_argument("--source", metavar="NAME", default=None, help="run only the named adapter (e.g. warn, layoffs_fyi)")
    p.add_argument("--self-test", action="store_true", help="run adapters against bundled offline fixtures (no network)")
    p.add_argument("--verbose", action="store_true", help="enable debug-level logging")
    return p


def main(argv: Optional[List[str]] = None) -> int:
    args = build_arg_parser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s %(name)s: %(message)s",
    )
    try:
        return run(args)
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001 - only genuine internal errors reach here
        logger.exception("unexpected internal error: %s", exc)
        return 1


if __name__ == "__main__":
    sys.exit(main())
