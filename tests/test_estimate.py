"""The visibility estimate, tonight's dark hours, and tonight's Kp and clouds."""

from dataclasses import replace
from datetime import UTC, datetime, timedelta

import pytest

from custom_components.aurora_finland.estimate import (
    LIKELY,
    NORTH,
    NOT_VISIBLE,
    OVERHEAD,
    POSSIBLE,
    UNLIKELY,
    clouds_tonight,
    dark_hours,
    is_dark,
    kp_tonight,
    next_hour,
    night,
    visibility,
)
from custom_components.aurora_finland.feeds import Activity, RIndex, parse_kp, parse_r_index

from .conftest import LATITUDE, LONGITUDE, NOW, fixture


def stations(**values: float | None) -> dict[str, RIndex]:
    """Every station quiet, at a tenth of its lower limit, except those given."""
    parsed = parse_r_index(fixture("r_index.json"))
    return {code: replace(s, value=values.get(code, s.lower / 10)) for code, s in parsed.items()}


def test_quiet() -> None:
    estimate = visibility(stations(), LATITUDE, LONGITUDE)
    assert estimate is not None
    assert (estimate.level, estimate.view, estimate.elevation) == (UNLIKELY, NOT_VISIBLE, None)
    assert estimate.ratio == 0.1


def test_overhead_at_the_lower_limits_is_possible() -> None:
    # Nurmijärvi's lower limit is 60 and Hankasalmi's 63.
    estimate = visibility(stations(NUR=60, HAN=63), LATITUDE, LONGITUDE)
    assert estimate is not None
    assert (estimate.level, estimate.view, estimate.ratio) == (POSSIBLE, OVERHEAD, 1.0)


def test_overhead_is_weighted_by_latitude() -> None:
    # Lappeenranta is about a third of the way from Nurmijärvi (60.5) to Hankasalmi (62.25), so Nurmijärvi weighs more.
    south = visibility(stations(NUR=120, HAN=0), LATITUDE, LONGITUDE)
    north = visibility(stations(NUR=0, HAN=126), LATITUDE, LONGITUDE)
    assert south is not None and north is not None
    assert south.ratio == pytest.approx(2 * (1 - (61.06 - 60.5) / (62.25 - 60.5)), abs=0.01)
    assert south.ratio > north.ratio


def test_overhead_at_the_upper_limits_is_likely() -> None:
    estimate = visibility(stations(NUR=120, HAN=140), LATITUDE, LONGITUDE)
    assert estimate is not None
    assert (estimate.level, estimate.view) == (LIKELY, OVERHEAD)


def test_a_bright_aurora_in_the_north() -> None:
    # Oulujärvi is about 390 km north, so its aurora is some 14° up. Kevo's, at nearly 1000 km, is below 12°.
    estimate = visibility(stations(OUJ=200, KEV=500), LATITUDE, LONGITUDE)
    assert estimate is not None
    assert (estimate.level, estimate.view, estimate.elevation) == (POSSIBLE, NORTH, 14)


def test_a_bright_aurora_in_the_north_while_one_is_overhead_is_likely() -> None:
    estimate = visibility(stations(NUR=60, HAN=63, OUJ=200), LATITUDE, LONGITUDE)
    assert estimate is not None
    assert (estimate.level, estimate.view, estimate.elevation) == (LIKELY, OVERHEAD, 14)


def test_a_faint_aurora_close_in_the_north() -> None:
    # Hankasalmi is about 150 km away, so a faint aurora over it is some 35° up.
    estimate = visibility(stations(HAN=63, NUR=0), LATITUDE, LONGITUDE)
    assert estimate is not None
    assert estimate.view == NORTH
    assert estimate.elevation is not None and estimate.elevation >= 30


def test_beyond_the_outermost_station() -> None:
    # North of Kevo, its reading is the only one over the place.
    estimate = visibility(stations(KEV=55), 70.05, 27.5)
    assert estimate is not None
    assert (estimate.level, estimate.view, estimate.ratio) == (POSSIBLE, OVERHEAD, 1.0)


def test_a_missing_reading_moves_to_the_next_station() -> None:
    # Without Nurmijärvi, Tartu is the nearest station south.
    # Tartu at its lower limit and Hankasalmi at none, weighed by latitude: (62.25 - 61.06) / (62.25 - 58.26) of Tartu.
    estimate = visibility(stations(NUR=None, TAR=55, HAN=0), LATITUDE, LONGITUDE)
    assert estimate is not None
    assert estimate.ratio == 0.3


def test_no_reading_north_leaves_the_station_south() -> None:
    # Every station north of the place without a reading, so Nurmijärvi is the only one over it.
    north = {code: None for code, s in stations().items() if s.latitude > LATITUDE}
    estimate = visibility(stations(NUR=60, **north), LATITUDE, LONGITUDE)
    assert estimate is not None
    assert (estimate.level, estimate.view, estimate.ratio) == (POSSIBLE, OVERHEAD, 1.0)


def test_no_readings() -> None:
    assert visibility({code: replace(s, value=None) for code, s in stations().items()}, LATITUDE, LONGITUDE) is None


def test_night_when_it_is_already_dark() -> None:
    dark = night(LATITUDE, LONGITUDE, NOW)
    assert dark is not None
    assert dark[0] == NOW
    # Civil dawn in Lappeenranta in mid-January is at about eight local time, an hour before sunrise.
    assert datetime(2026, 1, 16, 5, 30, tzinfo=UTC) < dark[1] < datetime(2026, 1, 16, 6, 30, tzinfo=UTC)


def test_night_from_dusk() -> None:
    noon = datetime(2026, 1, 15, 10, tzinfo=UTC)
    dark = night(LATITUDE, LONGITUDE, noon)
    assert dark is not None
    assert datetime(2026, 1, 15, 13, tzinfo=UTC) < dark[0] < datetime(2026, 1, 15, 15, tzinfo=UTC)
    assert dark[1] > dark[0]


def test_no_night_at_midsummer() -> None:
    # At 61° the sun stays above -6° all night around midsummer.
    assert night(LATITUDE, LONGITUDE, datetime(2026, 6, 21, 12, tzinfo=UTC)) is None


def forecasts(**values: float | None) -> dict[str, Activity]:
    return {code: Activity(code, code, None, None, value) for code, value in values.items()}


def test_next_hour_is_weighted_like_the_estimate() -> None:
    # Nurmijärvi at 60.50° and Hankasalmi at 62.25° around the place at 61.06°: a third of the way north.
    assert (
        next_hour(
            stations(),
            forecasts(NUR=20, HAN=40),
            LATITUDE,
        )
        == 26.4
    )


def test_next_hour_follows_the_stations_with_a_reading() -> None:
    # Without Hankasalmi's reading the estimate weighs Mekrijärvi, so the forecast is its too.
    # 20 + (80 − 20) × (61.06 − 60.50) / (62.77 − 60.50), to a tenth.
    assert next_hour(stations(HAN=None), forecasts(NUR=20, HAN=40, MEK=80), LATITUDE) == 34.8


def test_no_next_hour_without_a_forecast_for_either_station() -> None:
    assert next_hour(stations(), forecasts(NUR=20), LATITUDE) is None
    assert next_hour(stations(), forecasts(NUR=20, HAN=None), LATITUDE) is None


def test_next_hour_beyond_the_outermost_station() -> None:
    assert next_hour(stations(), forecasts(KEV=55), 70.5) == 55


def test_dark_hours_in_the_dark_start_at_the_evening() -> None:
    start, end = dark_hours(LATITUDE, LONGITUDE, NOW, 10) or (None, None)
    # In mid-January the sun is 10° down at about five in the evening and seven in the morning, local time.
    assert start is not None and datetime(2026, 1, 15, 14, tzinfo=UTC) < start < datetime(2026, 1, 15, 15, 30, tzinfo=UTC)
    assert end is not None and datetime(2026, 1, 16, 4, 30, tzinfo=UTC) < end < datetime(2026, 1, 16, 6, tzinfo=UTC)


def test_dark_hours_after_midnight_start_the_evening_before() -> None:
    small_hours = datetime(2026, 1, 16, 2, tzinfo=UTC)
    assert dark_hours(LATITUDE, LONGITUDE, small_hours, 10) == dark_hours(LATITUDE, LONGITUDE, NOW, 10)


def test_dark_hours_before_dusk() -> None:
    noon = datetime(2026, 1, 15, 10, tzinfo=UTC)
    start, end = dark_hours(LATITUDE, LONGITUDE, noon, 10) or (None, None)
    assert start is not None and end is not None
    assert noon < start < end
    assert start == dark_hours(LATITUDE, LONGITUDE, NOW, 10)[0]  # type: ignore[index]


def test_no_dark_hours_at_midsummer() -> None:
    # At 61° the sun stays above -10° all night around midsummer.
    assert dark_hours(LATITUDE, LONGITUDE, datetime(2026, 6, 21, 12, tzinfo=UTC), 10) is None


def test_dark_hours_in_the_polar_night() -> None:
    # At 78° the sun stays below -10° all day around midwinter.
    assert dark_hours(78.2, 15.6, datetime(2026, 12, 21, 12, tzinfo=UTC), 10) == (None, None)


def test_dark() -> None:
    assert is_dark(LATITUDE, LONGITUDE, NOW, -10)
    assert not is_dark(LATITUDE, LONGITUDE, datetime(2026, 1, 15, 10, tzinfo=UTC), -10)


def test_kp_tonight() -> None:
    dark = night(LATITUDE, LONGITUDE, NOW)
    assert dark is not None
    kp = kp_tonight(parse_kp(fixture("kp.json")), dark)
    assert kp is not None
    assert kp.kp == 4.33
    assert (kp.start, kp.end) == (datetime(2026, 1, 15, 21, tzinfo=UTC), datetime(2026, 1, 16, tzinfo=UTC))


def test_kp_counts_the_period_already_under_way() -> None:
    # The period from 18 to 21 UTC overlaps the dark hours that start at 20:12.
    dark = (NOW, NOW + timedelta(minutes=30))
    kp = kp_tonight(parse_kp(fixture("kp.json")), dark)
    assert kp is not None and kp.kp == 2.67


def test_clouds_tonight() -> None:
    # Until 22:52, so the hour from 23 is left out and the one from 22 is in.
    dark = (NOW, NOW + timedelta(hours=2, minutes=40))
    forecast = [
        {"datetime": "2026-01-15T19:00:00+00:00", "cloud_coverage": 100},
        {"datetime": "2026-01-15T20:00:00+00:00", "cloud_coverage": 80},
        {"datetime": "2026-01-15T21:00:00+00:00", "cloud_coverage": 20.4},
        {"datetime": "2026-01-15T22:00:00+00:00", "cloud_coverage": 50},
        {"datetime": "2026-01-15T23:00:00+00:00", "cloud_coverage": 0},
        {"datetime": "2026-01-15T22:30:00+00:00"},
    ]
    clouds = clouds_tonight(forecast, dark)
    assert clouds is not None
    assert [cover for _, cover in clouds.hours] == [80, 20, 50]
    assert (clouds.mean, clouds.least, clouds.clearest) == (50, 20, datetime(2026, 1, 15, 21, tzinfo=UTC))
    assert clouds_tonight([], dark) is None
