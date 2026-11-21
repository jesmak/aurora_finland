"""An event for when an aurora becomes likely while it is dark, for an automation to announce."""

from __future__ import annotations

from homeassistant.components.event import EventEntity
from homeassistant.core import HomeAssistant
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from .const import ATTRIBUTION, DOMAIN, EVENT_LIKELY
from .coordinator import AuroraConfigEntry
from .estimate import Visibility


async def async_setup_entry(hass: HomeAssistant, entry: AuroraConfigEntry, async_add_entities: AddConfigEntryEntitiesCallback) -> None:
    async_add_entities([AuroraEvent(entry)])


class AuroraEvent(EventEntity):
    _attr_has_entity_name = True
    _attr_attribution = ATTRIBUTION
    _attr_translation_key = "aurora"
    _attr_event_types = [EVENT_LIKELY]

    def __init__(self, entry: AuroraConfigEntry) -> None:
        self._entry = entry
        self._attr_unique_id = f"{entry.entry_id}_aurora"
        self._attr_device_info = DeviceInfo(identifiers={(DOMAIN, entry.entry_id)})

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        stations = self._entry.runtime_data.stations
        stations.on_likely = self._likely
        self.async_on_remove(lambda: setattr(stations, "on_likely", None))

    def _likely(self, visibility: Visibility) -> None:
        self._trigger_event(EVENT_LIKELY, {"view": visibility.view, "elevation": visibility.elevation, "ratio": visibility.ratio})
        self.async_write_ha_state()
