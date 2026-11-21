"""Aurora Finland: FMI's auroral activity and NOAA's Kp forecast, and what they mean for one place.

Each config entry is a place. FMI's magnetometer stations are devices under it, each with its R-index and RX, and the
place has the visibility estimate, tonight's Kp and tonight's clouds, and an event for when an aurora becomes likely.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable

from homeassistant.const import STATE_UNAVAILABLE, Platform
from homeassistant.core import Event, EventStateChangedData, HomeAssistant, callback
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers.event import async_track_state_change_event

from .api import Files
from .const import CONF_WEATHER, DOMAIN
from .coordinator import AuroraConfigEntry, AuroraRuntimeData, CloudCoordinator, KpCoordinator, StationCoordinator

PLATFORMS = [Platform.SENSOR, Platform.EVENT]


async def async_setup_entry(hass: HomeAssistant, entry: AuroraConfigEntry) -> bool:
    files = Files(hass)
    stations = StationCoordinator(hass, entry, files)
    kp = KpCoordinator(hass, entry, files)
    clouds = CloudCoordinator(hass, entry) if entry.data.get(CONF_WEATHER) else None
    await stations.async_config_entry_first_refresh()
    # At startup the weather entity may not exist yet. The clouds are then read as soon as it appears.
    weather_ready = clouds is not None and hass.states.get(clouds.weather) is not None
    await asyncio.gather(kp.async_refresh(), *([clouds.async_refresh()] if clouds and weather_ready else []))
    if clouds:
        entry.async_on_unload(async_track_state_change_event(hass, clouds.weather, _weather_appeared(clouds)))

    # The stations' devices name the place's as their parent, so it is registered before the platforms add them.
    place = dr.async_get(hass).async_get_or_create(
        config_entry_id=entry.entry_id,
        identifiers={(DOMAIN, entry.entry_id)},
        name=entry.title,
        entry_type=dr.DeviceEntryType.SERVICE,
    )
    entry.runtime_data = AuroraRuntimeData(stations, kp, clouds, place.id)
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    entry.async_on_unload(entry.add_update_listener(_async_update_listener))
    return True


def _weather_appeared(clouds: CloudCoordinator) -> Callable[[Event[EventStateChangedData]], None]:
    @callback
    def changed(event: Event[EventStateChangedData]) -> None:
        old, new = event.data["old_state"], event.data["new_state"]
        if new is not None and new.state != STATE_UNAVAILABLE and (old is None or old.state == STATE_UNAVAILABLE):
            clouds.hass.async_create_task(clouds.async_refresh())

    return changed


async def _async_update_listener(hass: HomeAssistant, entry: AuroraConfigEntry) -> None:
    await hass.config_entries.async_reload(entry.entry_id)


async def async_unload_entry(hass: HomeAssistant, entry: AuroraConfigEntry) -> bool:
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
