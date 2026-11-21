"""Reading the files."""

from datetime import UTC, datetime

import pytest

from custom_components.aurora_finland.feeds import FeedError, parse_kp, parse_r_index, parse_rx

from .conftest import fixture


def test_r_index() -> None:
    stations = parse_r_index(fixture("r_index.json"))
    assert len(stations) == 11
    nurmijarvi = stations["NUR"]
    assert nurmijarvi.name == "Nurmijärvi"
    assert (nurmijarvi.latitude, nurmijarvi.longitude) == (60.5, 24.65)
    assert (nurmijarvi.lower, nurmijarvi.upper) == (60, 120)
    assert nurmijarvi.time == datetime(2026, 1, 15, 20, 10, tzinfo=UTC)


def test_r_index_leaves_out_a_station_without_limits() -> None:
    body = fixture("r_index.json")
    body["data"]["NUR"]["Limit value lower"] = None
    body["data"]["HAN"]["R-index"] = None
    stations = parse_r_index(body)
    assert "NUR" not in stations
    # A station that is only missing its reading stays, so its sensor becomes unavailable rather than vanishing.
    assert stations["HAN"].value is None


def test_rx_with_a_station_missing_its_past_hour() -> None:
    stations = parse_rx(fixture("rx.json"))
    # Masi has RX only, and its past hour is null in the real file too.
    assert stations["MAS"].past_hour is None
    assert stations["MAS"].next_hour_max is not None
    # FMI writes this file's times without a colon in the offset.
    assert stations["NUR"].time == datetime(2026, 1, 15, 20, 10, 10, tzinfo=UTC)


@pytest.mark.parametrize("body", [None, [], {"info": {}}, {"data": []}])
def test_a_file_without_stations(body: object) -> None:
    with pytest.raises(FeedError):
        parse_r_index(body)


def test_kp() -> None:
    periods = parse_kp(fixture("kp.json"))
    assert periods[0].start == datetime(2026, 1, 15, 12, tzinfo=UTC)
    assert periods[0].observed
    assert not periods[-1].observed
    with pytest.raises(FeedError):
        parse_kp({"error": "maintenance"})
