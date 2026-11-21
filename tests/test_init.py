"""Setting up a place: its sensors, the stations' devices, and the event."""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from freezegun.api import FrozenDateTimeFactory
from homeassistant.config_entries import ConfigEntryState
from homeassistant.core import HomeAssistant, ServiceCall, ServiceResponse, SupportsResponse
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er
from pytest_homeassistant.common import async_fire_time_changed
from pytest_homeassistant.test_util.aiohttp import AiohttpClientMocker

from custom_components.aurora_finland.const import CONF_WEATHER, DOMAIN, KP_URL, R_INDEX_URL, RX_URL

from .conftest import LATITUDE, LONGITUDE, aurora_entry, fixture


def entity_id(hass: HomeAssistant, domain: str, unique_id: str) -> str:
    found = er.async_get(hass).async_get_entity_id(domain, DOMAIN, unique_id)
    assert found is not None
    return found


async def test_setup(hass: HomeAssistant, feeds: AiohttpClientMocker) -> None:
    entry = aurora_entry(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()

    visibility = hass.states.get(entity_id(hass, "sensor", f"{entry.entry_id}_visibility"))
    assert visibility is not None
    assert visibility.state == "unlikely"
    assert visibility.attributes["view"] == "not_visible"
    assert visibility.attributes["dark"] is True
    # The night going on at 20.12 UTC, from the evening's dusk.
    assert visibility.attributes["dark_start"].startswith("2026-01-15T15:")
    assert visibility.attributes["dark_end"].startswith("2026-01-16T05:")
    assert isinstance(visibility.attributes["next_hour"], float)
    assert (visibility.attributes["latitude"], visibility.attributes["longitude"]) == (LATITUDE, LONGITUDE)

    kp = hass.states.get(entity_id(hass, "sensor", f"{entry.entry_id}_kp_tonight"))
    assert kp is not None and kp.state == "4.33"
    assert kp.attributes["start"] == "2026-01-15T21:00:00+00:00"

    # No weather entity was given, so there are no clouds.
    assert er.async_get(hass).async_get_entity_id("sensor", DOMAIN, f"{entry.entry_id}_clouds_tonight") is None

    nurmijarvi = hass.states.get(entity_id(hass, "sensor", f"{entry.entry_id}_NUR_r_index"))
    assert nurmijarvi is not None
    assert nurmijarvi.attributes["lower_limit"] == 60
    # Masi has RX only, and no past hour.
    assert er.async_get(hass).async_get_entity_id("sensor", DOMAIN, f"{entry.entry_id}_MAS_r_index") is None
    masi = hass.states.get(entity_id(hass, "sensor", f"{entry.entry_id}_MAS_activity"))
    assert masi is not None and masi.state == "unavailable"

    devices = dr.async_get(hass)
    place = devices.async_get_device_by_identifier((DOMAIN, entry.entry_id), entry.entry_id)
    station = devices.async_get_device_by_identifier((DOMAIN, f"{entry.entry_id}_NUR"), entry.entry_id)
    assert place is not None and station is not None
    assert station.via_device_id == place.id
    assert station.name == "Nurmijärvi"
    # Eleven stations in each file, ten of them in both.
    assert len(dr.async_entries_for_config_entry(devices, entry.entry_id)) == 13


async def test_clouds(hass: HomeAssistant, feeds: AiohttpClientMocker) -> None:
    async def forecasts(call: ServiceCall) -> ServiceResponse:
        hours = [{"datetime": f"2026-01-15T{h}:00:00+00:00", "cloud_coverage": c} for h, c in [(20, 90), (21, 30), (22, 60)]]
        return {"weather.example": {"forecast": hours}}

    hass.services.async_register("weather", "get_forecasts", forecasts, supports_response=SupportsResponse.ONLY)
    hass.states.async_set("weather.example", "cloudy")
    entry = aurora_entry(hass, **{CONF_WEATHER: "weather.example"})
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()

    clouds = hass.states.get(entity_id(hass, "sensor", f"{entry.entry_id}_clouds_tonight"))
    assert clouds is not None
    assert clouds.state == "60"
    assert clouds.attributes["least"] == 30
    assert clouds.attributes["clearest"] == "2026-01-15T21:00:00+00:00"


async def test_clouds_once_the_weather_entity_appears(hass: HomeAssistant, feeds: AiohttpClientMocker) -> None:
    # At startup the weather integration may set up after this one.
    asked: list[ServiceCall] = []

    async def forecasts(call: ServiceCall) -> ServiceResponse:
        asked.append(call)
        return {"weather.example": {"forecast": [{"datetime": "2026-01-15T21:00:00+00:00", "cloud_coverage": 40}]}}

    hass.services.async_register("weather", "get_forecasts", forecasts, supports_response=SupportsResponse.ONLY)
    entry = aurora_entry(hass, **{CONF_WEATHER: "weather.example"})
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    clouds = entity_id(hass, "sensor", f"{entry.entry_id}_clouds_tonight")
    assert not asked
    assert hass.states.get(clouds).state == "unavailable"

    hass.states.async_set("weather.example", "cloudy")
    await hass.async_block_till_done()
    assert hass.states.get(clouds).state == "40"

    # A later change of the weather is no reason to ask again.
    hass.states.async_set("weather.example", "rainy")
    await hass.async_block_till_done()
    assert len(asked) == 1


def likely(body: dict[str, Any]) -> dict[str, Any]:
    """Nurmijärvi and Hankasalmi at their upper limits."""
    body["data"]["NUR"]["R-index"] = 120
    body["data"]["HAN"]["R-index"] = 140
    return body


async def test_event_when_an_aurora_becomes_likely(hass: HomeAssistant, feeds: AiohttpClientMocker, freezer: FrozenDateTimeFactory) -> None:
    entry = aurora_entry(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    event = entity_id(hass, "event", f"{entry.entry_id}_aurora")
    assert hass.states.get(event).state == "unknown"

    async def update(body: dict[str, Any]) -> None:
        feeds.clear_requests()
        feeds.get(R_INDEX_URL, json=body)
        feeds.get(RX_URL, json=fixture("rx.json"))
        freezer.tick(timedelta(minutes=5))
        async_fire_time_changed(hass)
        await hass.async_block_till_done()

    await update(likely(fixture("r_index.json")))
    fired = hass.states.get(event)
    assert fired.state != "unknown"
    assert fired.attributes["event_type"] == "likely"
    assert fired.attributes["view"] == "overhead"
    first = fired.state

    # Still likely: no new event.
    await update(likely(fixture("r_index.json")))
    assert hass.states.get(event).state == first

    # Quiet again, then likely again: a new one.
    await update(fixture("r_index.json"))
    await update(likely(fixture("r_index.json")))
    assert hass.states.get(event).state != first


async def test_no_event_in_daylight(hass: HomeAssistant, feeds: AiohttpClientMocker, freezer: FrozenDateTimeFactory) -> None:
    freezer.move_to("2026-01-15T10:00:00+00:00")
    entry = aurora_entry(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()

    feeds.clear_requests()
    feeds.get(R_INDEX_URL, json=likely(fixture("r_index.json")))
    feeds.get(RX_URL, json=fixture("rx.json"))
    freezer.tick(timedelta(minutes=5))
    async_fire_time_changed(hass)
    await hass.async_block_till_done()

    visibility = hass.states.get(entity_id(hass, "sensor", f"{entry.entry_id}_visibility"))
    assert visibility.state == "likely"
    assert hass.states.get(entity_id(hass, "event", f"{entry.entry_id}_aurora")).state == "unknown"


async def test_no_event_after_restart_if_likely(hass: HomeAssistant, feeds: AiohttpClientMocker, freezer: FrozenDateTimeFactory) -> None:
    # A restart in the middle of an aurora doesn't announce it again, at setup or on the updates after it.
    feeds.clear_requests()
    feeds.get(R_INDEX_URL, json=likely(fixture("r_index.json")))
    feeds.get(RX_URL, json=fixture("rx.json"))
    feeds.get(KP_URL, json=fixture("kp.json"))
    entry = aurora_entry(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()

    freezer.tick(timedelta(minutes=5))
    async_fire_time_changed(hass)
    await hass.async_block_till_done()

    assert hass.states.get(entity_id(hass, "sensor", f"{entry.entry_id}_visibility")).state == "likely"
    assert hass.states.get(entity_id(hass, "event", f"{entry.entry_id}_aurora")).state == "unknown"


async def test_event_at_dark_while_likely(hass: HomeAssistant, feeds: AiohttpClientMocker, freezer: FrozenDateTimeFactory) -> None:
    freezer.move_to("2026-01-15T10:00:00+00:00")
    feeds.clear_requests()
    feeds.get(R_INDEX_URL, json=likely(fixture("r_index.json")))
    feeds.get(RX_URL, json=fixture("rx.json"))
    feeds.get(KP_URL, json=fixture("kp.json"))
    entry = aurora_entry(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    event = entity_id(hass, "event", f"{entry.entry_id}_aurora")

    freezer.tick(timedelta(minutes=5))
    async_fire_time_changed(hass)
    await hass.async_block_till_done()
    assert hass.states.get(event).state == "unknown"

    freezer.move_to("2026-01-15T17:00:00+00:00")
    async_fire_time_changed(hass)
    await hass.async_block_till_done()
    fired = hass.states.get(event)
    assert fired.state != "unknown"
    assert fired.attributes["event_type"] == "likely"


async def test_failed_rx_leaves_the_estimate(hass: HomeAssistant, feeds: AiohttpClientMocker, freezer: FrozenDateTimeFactory) -> None:
    feeds.clear_requests()
    feeds.get(R_INDEX_URL, json=fixture("r_index.json"))
    feeds.get(RX_URL, status=503)
    feeds.get(KP_URL, json=fixture("kp.json"))
    entry = aurora_entry(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    assert hass.states.get(entity_id(hass, "sensor", f"{entry.entry_id}_visibility")).state == "unlikely"
    registry = er.async_get(hass)
    assert registry.async_get_entity_id("sensor", DOMAIN, f"{entry.entry_id}_NUR_activity") is None

    # Once RX is back, its sensors and its station of its own come with the update.
    feeds.clear_requests()
    feeds.get(R_INDEX_URL, json=fixture("r_index.json"))
    feeds.get(RX_URL, json=fixture("rx.json"))
    freezer.tick(timedelta(minutes=5))
    async_fire_time_changed(hass)
    await hass.async_block_till_done()
    assert hass.states.get(entity_id(hass, "sensor", f"{entry.entry_id}_NUR_activity")).state != "unavailable"
    assert registry.async_get_entity_id("sensor", DOMAIN, f"{entry.entry_id}_MAS_activity") is not None
    assert len(dr.async_entries_for_config_entry(dr.async_get(hass), entry.entry_id)) == 13


async def test_failed_r_index_retries_setup(hass: HomeAssistant, feeds: AiohttpClientMocker) -> None:
    feeds.clear_requests()
    feeds.get(R_INDEX_URL, status=503)
    feeds.get(RX_URL, json=fixture("rx.json"))
    feeds.get(KP_URL, json=fixture("kp.json"))
    entry = aurora_entry(hass)
    await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    assert entry.state is ConfigEntryState.SETUP_RETRY


async def test_unchanged_file_is_reused(hass: HomeAssistant, feeds: AiohttpClientMocker, freezer: FrozenDateTimeFactory) -> None:
    entry = aurora_entry(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()

    feeds.clear_requests()
    feeds.get(R_INDEX_URL, status=304)
    feeds.get(RX_URL, status=304)
    freezer.tick(timedelta(minutes=5))
    async_fire_time_changed(hass)
    await hass.async_block_till_done()

    asked = [call for call in feeds.mock_calls if str(call[1]) == R_INDEX_URL]
    assert asked and asked[-1][3]["If-Modified-Since"] == "Thu, 15 Jan 2026 20:11:19 GMT"
    assert hass.states.get(entity_id(hass, "sensor", f"{entry.entry_id}_NUR_r_index")).state == "19.0"


async def test_station_without_a_reading_keeps_its_place(hass: HomeAssistant, feeds: AiohttpClientMocker) -> None:
    body = fixture("r_index.json")
    body["data"]["KEV"]["R-index"] = None
    feeds.clear_requests()
    feeds.get(R_INDEX_URL, json=body)
    feeds.get(RX_URL, json=fixture("rx.json"))
    feeds.get(KP_URL, json=fixture("kp.json"))
    entry = aurora_entry(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    kevo = hass.states.get(entity_id(hass, "sensor", f"{entry.entry_id}_KEV_r_index"))
    assert kevo is not None and kevo.state == "unknown"
    assert kevo.attributes["latitude"] == 69.76 and kevo.attributes["lower_limit"] == 55
