"""Reading FMI's R-index and RX files and NOAA's Kp forecast into plain data."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any


class FeedError(Exception):
    """A file couldn't be fetched, or it wasn't what it should be."""


@dataclass(frozen=True)
class RIndex:
    """One station's R-index: the magnetic field's variation over the last ten minutes."""

    code: str
    name: str
    latitude: float
    longitude: float
    time: datetime | None
    value: float | None
    # Above the lower limit, an aurora is more likely than not overhead the station. The upper is for a bright one.
    lower: float
    upper: float


@dataclass(frozen=True)
class Activity:
    """One station's RX: geomagnetic activity in the past hour, and the most expected in the next."""

    code: str
    name: str
    time: datetime | None
    past_hour: float | None
    next_hour_max: float | None


@dataclass(frozen=True)
class KpPeriod:
    start: datetime
    kp: float
    observed: bool


def parse_r_index(body: Any) -> dict[str, RIndex]:
    stations: dict[str, RIndex] = {}
    for code, row in _data(body).items():
        if not isinstance(row, dict):
            continue
        latitude, longitude = _number(row.get("Geographic latitude")), _number(row.get("Geographic longitude"))
        lower, upper = _number(row.get("Limit value lower")), _number(row.get("Limit value higher"))
        # A station without a position or limits can't be used for anything, so it is left out.
        if latitude is None or longitude is None or not lower or not upper:
            continue
        stations[code] = RIndex(
            code=code,
            name=str(row.get("Station") or code),
            latitude=latitude,
            longitude=longitude,
            time=_time(row.get("Time")),
            value=_number(row.get("R-index")),
            lower=lower,
            upper=upper,
        )
    return stations


def parse_rx(body: Any) -> dict[str, Activity]:
    stations: dict[str, Activity] = {}
    for code, row in _data(body).items():
        if not isinstance(row, dict):
            continue
        stations[code] = Activity(
            code=code,
            name=str(row.get("station") or code),
            time=_time(row.get("time")),
            past_hour=_value(row.get("RX")),
            next_hour_max=_value(row.get("RXmax")),
        )
    return stations


def parse_kp(body: Any) -> list[KpPeriod]:
    if not isinstance(body, list):
        raise FeedError("NOAA's Kp forecast isn't a list")
    periods = []
    for row in body:
        if not isinstance(row, dict):
            continue
        start, kp = _time(row.get("time_tag")), _number(row.get("kp"))
        if start is not None and kp is not None:
            periods.append(KpPeriod(start, kp, row.get("observed") == "observed"))
    return periods


def _data(body: Any) -> dict[str, Any]:
    data = body.get("data") if isinstance(body, dict) else None
    if not isinstance(data, dict):
        raise FeedError("FMI's file has no stations")
    return data


def _value(item: Any) -> float | None:
    return _number(item.get("value")) if isinstance(item, dict) else None


def _number(value: Any) -> float | None:
    # bool is an int, and neither belongs here.
    return float(value) if isinstance(value, int | float) and not isinstance(value, bool) else None


def _time(value: Any) -> datetime | None:
    """FMI writes "2026-11-21 08:10:00+00:00" and "2026-11-21T08:10:10+0000", NOAA "2026-11-21T09:00:00" in UTC."""
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)
