"""The place's sensors (visibility, tonight's Kp and clouds) and each station's R-index and RX."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from homeassistant.components.sensor import SensorDeviceClass, SensorEntity, SensorStateClass
from homeassistant.const import PERCENTAGE
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.device_registry import DeviceEntryType, DeviceInfo
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity, DataUpdateCoordinator

from .const import ATTRIBUTION, DOMAIN
from .coordinator import AuroraConfigEntry, Stations
from .estimate import LIKELY, POSSIBLE, UNLIKELY

PARALLEL_UPDATES = 0


async def async_setup_entry(hass: HomeAssistant, entry: AuroraConfigEntry, async_add_entities: AddConfigEntryEntitiesCallback) -> None:
    data = entry.runtime_data
    place = DeviceInfo(identifiers={(DOMAIN, entry.entry_id)})
    entities: list[SensorEntity] = [VisibilitySensor(data.stations, place), KpSensor(data.kp, place)]
    if data.clouds:
        entities.append(CloudSensor(data.clouds, place))
    async_add_entities(entities)

    added: set[tuple[str, str]] = set()

    @callback
    def add_stations() -> None:
        """Add a station's sensors once its file lists it, so one left out by a failed file comes with a later update."""
        stations = data.stations.data
        new: list[SensorEntity] = []
        for code in sorted(stations.r_index.keys() | stations.activity.keys()):
            found = stations.r_index.get(code) or stations.activity[code]
            device = DeviceInfo(
                identifiers={(DOMAIN, f"{entry.entry_id}_{code}")},
                name=found.name,
                manufacturer="Finnish Meteorological Institute",
                model="Magnetometer",
                entry_type=DeviceEntryType.SERVICE,
                via_device_id=data.place_device_id,
            )
            if code in stations.r_index and (code, "r_index") not in added:
                added.add((code, "r_index"))
                new.append(RIndexSensor(data.stations, device, code))
            if code in stations.activity and (code, "activity") not in added:
                added.add((code, "activity"))
                new.append(ActivitySensor(data.stations, device, code, "activity", lambda a: a.past_hour))
                new.append(ActivitySensor(data.stations, device, code, "activity_next_hour", lambda a: a.next_hour_max))
        if new:
            async_add_entities(new)

    add_stations()
    entry.async_on_unload(data.stations.async_add_listener(add_stations))


class _Sensor(CoordinatorEntity[DataUpdateCoordinator[Any]], SensorEntity):
    _attr_has_entity_name = True
    _attr_attribution = ATTRIBUTION

    def __init__(self, coordinator: DataUpdateCoordinator[Any], device: DeviceInfo, key: str, unique_id: str) -> None:
        super().__init__(coordinator)
        self._attr_device_info = device
        self._attr_translation_key = key
        self._attr_unique_id = unique_id


class VisibilitySensor(_Sensor):
    _attr_device_class = SensorDeviceClass.ENUM
    _attr_options = [UNLIKELY, POSSIBLE, LIKELY]

    def __init__(self, coordinator: DataUpdateCoordinator[Stations], device: DeviceInfo) -> None:
        super().__init__(coordinator, device, "visibility", f"{coordinator.config_entry.entry_id}_visibility")

    @property
    def available(self) -> bool:
        return super().available and self.coordinator.data.visibility is not None

    @property
    def native_value(self) -> str | None:
        visibility = self.coordinator.data.visibility
        return visibility.level if visibility else None

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        visibility = self.coordinator.data.visibility
        if visibility is None:
            return {}
        start, end = self.coordinator.data.dark_hours or (None, None)
        return {
            "view": visibility.view,
            "elevation": visibility.elevation,
            "ratio": visibility.ratio,
            "dark": self.coordinator.data.dark,
            "dark_start": start.isoformat() if start else None,
            "dark_end": end.isoformat() if end else None,
            "next_hour": self.coordinator.data.next_hour,
        }


class KpSensor(_Sensor):
    _attr_suggested_display_precision = 2

    def __init__(self, coordinator: DataUpdateCoordinator[Any], device: DeviceInfo) -> None:
        super().__init__(coordinator, device, "kp_tonight", f"{coordinator.config_entry.entry_id}_kp_tonight")

    @property
    def available(self) -> bool:
        return super().available and self.coordinator.data is not None

    @property
    def native_value(self) -> float | None:
        return self.coordinator.data.kp if self.coordinator.data else None

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        kp = self.coordinator.data
        return {"start": kp.start.isoformat(), "end": kp.end.isoformat()} if kp else {}


class CloudSensor(_Sensor):
    _attr_native_unit_of_measurement = PERCENTAGE

    def __init__(self, coordinator: DataUpdateCoordinator[Any], device: DeviceInfo) -> None:
        super().__init__(coordinator, device, "clouds_tonight", f"{coordinator.config_entry.entry_id}_clouds_tonight")

    @property
    def available(self) -> bool:
        return super().available and self.coordinator.data is not None

    @property
    def native_value(self) -> int | None:
        return self.coordinator.data.mean if self.coordinator.data else None

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        clouds = self.coordinator.data
        if clouds is None:
            return {}
        return {
            "least": clouds.least,
            "clearest": clouds.clearest.isoformat(),
            "hours": [{"time": when.isoformat(), "cloud_coverage": cover} for when, cover in clouds.hours],
        }


class RIndexSensor(_Sensor):
    _attr_state_class = SensorStateClass.MEASUREMENT

    def __init__(self, coordinator: DataUpdateCoordinator[Stations], device: DeviceInfo, code: str) -> None:
        super().__init__(coordinator, device, "r_index", f"{coordinator.config_entry.entry_id}_{code}_r_index")
        self._code = code

    @property
    def available(self) -> bool:
        # Without a reading the state is unknown, so the card still has the station's place and limit to draw.
        return super().available and self._code in self.coordinator.data.r_index

    @property
    def native_value(self) -> float | None:
        station = self.coordinator.data.r_index.get(self._code)
        return station.value if station else None

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        station = self.coordinator.data.r_index.get(self._code)
        if station is None:
            return {}
        return {
            "lower_limit": station.lower,
            "upper_limit": station.upper,
            "time": station.time.isoformat() if station.time else None,
            "latitude": station.latitude,
            "longitude": station.longitude,
        }


class ActivitySensor(_Sensor):
    _attr_state_class = SensorStateClass.MEASUREMENT

    def __init__(
        self, coordinator: DataUpdateCoordinator[Stations], device: DeviceInfo, code: str, key: str, value: Callable[[Any], float | None]
    ) -> None:
        super().__init__(coordinator, device, key, f"{coordinator.config_entry.entry_id}_{code}_{key}")
        self._code = code
        self._value = value

    @property
    def available(self) -> bool:
        return super().available and self.native_value is not None

    @property
    def native_value(self) -> float | None:
        activity = self.coordinator.data.activity.get(self._code)
        return self._value(activity) if activity else None
