"""What the stations' readings mean for one place: the aurora's visibility now, tonight's dark hours, Kp and clouds.

The visibility estimate is a heuristic of this integration's own, not FMI's, and it hasn't been calibrated against
sightings.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from astral import Observer
from astral.sun import dawn, dusk, elevation
from homeassistant.util.location import distance

from .feeds import KpPeriod, RIndex

UNLIKELY = "unlikely"
POSSIBLE = "possible"
LIKELY = "likely"

OVERHEAD = "overhead"
NORTH = "north"
NOT_VISIBLE = "not_visible"

# The aurora's lower edge is at about 110 km.
AURORA_HEIGHT_KM = 110
EARTH_DIAMETER_KM = 12742
# An aurora over a station seen at least this high above the horizon counts as visible from the place when it is
# bright (the station's upper limit), and at least the higher one when it is faint (the lower limit).
BRIGHT_ELEVATION = 12
FAINT_ELEVATION = 30


@dataclass(frozen=True)
class Visibility:
    level: str
    view: str
    # How high in the north to look, in degrees, when the aurora is there.
    elevation: int | None
    # The activity over the place against the lower limit: 1 is the limit, where an aurora is more likely than not.
    ratio: float | None


def visibility(stations: dict[str, RIndex], latitude: float, longitude: float) -> Visibility | None:
    """How likely an aurora is to be seen from the place now, and where. None when no station has a reading.

    1. Overhead: the R-index of the nearest stations south and north of the place against each station's own limits,
       weighted by latitude. At the lower limit an aurora is more likely than not, at the upper a bright one is.
    2. In the north: a station north of the place whose aurora would be seen from the place high enough above the
       horizon, by its distance and the earth's curvature. A bright one counts from 12°, a faint one from 30°.
    """
    readings = [station for station in stations.values() if station.value is not None]
    lower, upper = _over_place(readings, latitude)

    bright = faint = None
    for station in readings:
        if station.latitude <= latitude:
            continue
        assert station.value is not None
        angle = _elevation(distance(latitude, longitude, station.latitude, station.longitude) / 1000)
        if angle >= BRIGHT_ELEVATION and station.value >= station.upper and (bright is None or angle > bright):
            bright = angle
        if angle >= FAINT_ELEVATION and station.value >= station.lower and (faint is None or angle > faint):
            faint = angle

    if lower is None and bright is None and faint is None:
        return None
    overhead = lower is not None and lower >= 1
    if (upper is not None and upper >= 1) or (overhead and bright is not None):
        level = LIKELY
    elif overhead or bright is not None or faint is not None:
        level = POSSIBLE
    else:
        level = UNLIKELY

    north = bright if bright is not None else faint
    if overhead:
        view, angle = OVERHEAD, bright
    elif north is not None:
        view, angle = NORTH, north
    else:
        view, angle = NOT_VISIBLE, None
    return Visibility(level, view, round(angle) if angle is not None else None, round(lower, 2) if lower is not None else None)


def _over_place(readings: list[RIndex], latitude: float) -> tuple[float | None, float | None]:
    """The activity over the place against the lower and the upper limit, from the stations around its latitude."""
    south = max((s for s in readings if s.latitude <= latitude), key=lambda s: s.latitude, default=None)
    north = min((s for s in readings if s.latitude > latitude), key=lambda s: s.latitude, default=None)
    if south is None and north is None:
        return None, None
    if south is None or north is None:
        # Beyond the outermost station, it is the best there is.
        only = south or north
        assert only is not None and only.value is not None
        return only.value / only.lower, only.value / only.upper
    assert south.value is not None and north.value is not None
    weight = (latitude - south.latitude) / (north.latitude - south.latitude)
    return (
        (1 - weight) * south.value / south.lower + weight * north.value / north.lower,
        (1 - weight) * south.value / south.upper + weight * north.value / north.upper,
    )


def _elevation(km: float) -> float:
    """How high above the horizon an aurora this far away is seen, the earth's curvature taken off."""
    return math.degrees(math.atan2(AURORA_HEIGHT_KM, km) - km / EARTH_DIAMETER_KM)


def is_dark(latitude: float, longitude: float, when: datetime, darkest: float) -> bool:
    return elevation(Observer(latitude, longitude), when) <= darkest


def night(latitude: float, longitude: float, now: datetime) -> tuple[datetime, datetime] | None:
    """Tonight's dark hours, from civil dusk to dawn. When it is already dark, from now. None when no dusk comes."""
    observer = Observer(latitude, longitude)
    next_dawn = _next(dawn, observer, now)
    if next_dawn is None:
        return None
    if elevation(observer, now) <= -6:
        return now, next_dawn
    next_dusk = _next(dusk, observer, now)
    if next_dusk is None or next_dusk >= next_dawn:
        return None
    return next_dusk, next_dawn


def _next(event: Any, observer: Observer, now: datetime) -> datetime | None:
    """The next dawn or dusk after now within three days. Astral raises ValueError on a day the sun doesn't get there."""
    for days in range(3):
        try:
            when: datetime = event(observer, (now + timedelta(days=days)).date(), tzinfo=UTC)
        except ValueError:
            continue
        if when > now:
            return when
    return None


@dataclass(frozen=True)
class KpTonight:
    kp: float
    # The three hours with the highest Kp. The first of them when several are as high.
    start: datetime
    end: datetime


def kp_tonight(periods: list[KpPeriod], dark: tuple[datetime, datetime]) -> KpTonight | None:
    start, end = dark
    best = None
    for period in periods:
        if period.start < end and period.start + timedelta(hours=3) > start and (best is None or period.kp > best.kp):
            best = period
    return KpTonight(best.kp, best.start, best.start + timedelta(hours=3)) if best else None


@dataclass(frozen=True)
class CloudsTonight:
    mean: int
    least: int
    clearest: datetime
    # Each hour's cloud cover, in percent.
    hours: list[tuple[datetime, int]]


def clouds_tonight(forecast: list[Any], dark: tuple[datetime, datetime]) -> CloudsTonight | None:
    """From a weather entity's hourly forecast, the hours that fall in tonight's dark hours."""
    start, end = dark
    hours: list[tuple[datetime, int]] = []
    for item in forecast:
        if not isinstance(item, dict):
            continue
        cover = item.get("cloud_coverage")
        when = _when(item.get("datetime"))
        if when is not None and isinstance(cover, int | float) and when < end and when + timedelta(hours=1) > start:
            hours.append((when, round(cover)))
    if not hours:
        return None
    clearest = min(hours, key=lambda hour: hour[1])
    return CloudsTonight(round(sum(cover for _, cover in hours) / len(hours)), clearest[1], clearest[0], hours)


def _when(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value
    try:
        return datetime.fromisoformat(value) if isinstance(value, str) else None
    except ValueError:
        return None
