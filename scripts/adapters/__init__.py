"""Adapter registry for the layoff-data refresh pipeline.

Each adapter is a small object exposing:

    name: str                       # stable identifier used by --source
    fetch_events(self_test=False)   # -> List[dict] mapped to the event schema

``ADAPTERS`` is the ordered list the orchestrator iterates over. To add a new data
source, write a module under ``scripts/adapters/`` that exposes a module-level
``fetch_events(self_test=False)`` function, then register it here with ``_Adapter``.
"""

from typing import Any, Callable, Dict, List

from . import layoffs_fyi, warn


class _Adapter:
    """Thin wrapper binding a stable name to a module's fetch_events callable."""

    def __init__(self, name: str, fetch: Callable[..., List[Dict[str, Any]]]):
        self.name = name
        self._fetch = fetch

    def fetch_events(self, self_test: bool = False) -> List[Dict[str, Any]]:
        return self._fetch(self_test=self_test)

    def __repr__(self) -> str:  # pragma: no cover - debug aid
        return "<Adapter %s>" % self.name


# Order here is the order adapters run in. WARN (confirmed filings) first, then the
# aggregator (estimated) so that, on ties, merge logic still prefers higher confidence.
ADAPTERS: List[_Adapter] = [
    _Adapter("warn", warn.fetch_events),
    _Adapter("layoffs_fyi", layoffs_fyi.fetch_events),
]

__all__ = ["ADAPTERS", "_Adapter"]
