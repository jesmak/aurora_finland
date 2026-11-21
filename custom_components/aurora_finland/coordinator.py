"""The three updates: FMI's stations every five minutes, NOAA's Kp and the weather entity's clouds every half hour."""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import CONF_LATITUDE, CONF_LONGITUDE
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed
from homeassistant.util import dt as dt_util

from .api import Files
from .const import (
    CLOUD_INTERVAL,
    CONF_WEATHER,
    DARK_ELEVATION,
    DOMAIN,
    FMI_INTERVAL,
    KP_INTERVAL,
    KP_URL,
    R_INDEX_URL,
    RX_URL,
)
from .estimate import LIKELY, CloudsTonight, KpTonight, Visibility, clouds_tonight, is_dark, kp_tonight, night, visibility
from .feeds import Activity, FeedError, RIndex, parse_kp, parse_r_index, parse_rx

_LOGGER = logging.getLogger(__name__)


@dataclass
class AuroraRuntimeData:
    stations: StationCoordinator
    kp: KpCoordinator
    clouds: CloudCoordinator | None
    place_device_id: str


type AuroraConfigEntry = ConfigEntry[AuroraRuntimeData]


@dataclass(frozen=True)
class Stations:
    r_index: dict[str, RIndex]
    activity: dict[str, Activity]
    visibility: Visibility | None
    dark: bool


class StationCoordinator(DataUpdateCoordinator[Stations]):
    config_entry: AuroraConfigEntry

    def __init__(self, hass: HomeAssistant, entry: AuroraConfigEntry, files: Files) -> None:
        super().__init__(hass, _LOGGER, config_entry=entry, name=f"{DOMAIN} stations", update_interval=FMI_INTERVAL)
        self._files = files
        self.latitude: float = entry.data[CONF_LATITUDE]
        self.longitude: float = entry.data[CONF_LONGITUDE]
        # Called when an aurora becomes likely while it is dark, or it gets dark while one is likely.
        self.on_likely: Callable[[Visibility], None] | None = None
        self._was_likely = False

    async def _async_update_data(self) -> Stations:
        try:
            r_index = parse_r_index(await self._files.get(R_INDEX_URL, "FMI"))
            # The estimate needs only the R-index, so a failed RX makes only its own sensors unavailable.
            try:
                activity = parse_rx(await self._files.get(RX_URL, "FMI"))
            except FeedError as err:
                _LOGGER.warning("FMI's RX couldn't be read: %s", err)
                activity = {}
        except FeedError as err:
            raise UpdateFailed(str(err)) from err

        estimate = visibility(r_index, self.latitude, self.longitude)
        dark = is_dark(self.latitude, self.longitude, dt_util.utcnow(), DARK_ELEVATION)
        likely = dark and estimate is not None and estimate.level == LIKELY
        # The first update runs before the event listens, and leaves _was_likely set, so a restart in the middle of an
        # aurora doesn't announce it again.
        if likely and not self._was_likely and self.on_likely and estimate:
            self.on_likely(estimate)
        self._was_likely = likely
        return Stations(r_index, activity, estimate, dark)


class KpCoordinator(DataUpdateCoordinator[KpTonight | None]):
    config_entry: AuroraConfigEntry

    def __init__(self, hass: HomeAssistant, entry: AuroraConfigEntry, files: Files) -> None:
        super().__init__(hass, _LOGGER, config_entry=entry, name=f"{DOMAIN} Kp", update_interval=KP_INTERVAL)
        self._files = files
        self.latitude: float = entry.data[CONF_LATITUDE]
        self.longitude: float = entry.data[CONF_LONGITUDE]
        self.night: tuple[datetime, datetime] | None = None

    async def _async_update_data(self) -> KpTonight | None:
        try:
            periods = parse_kp(await self._files.get(KP_URL, "NOAA"))
        except FeedError as err:
            raise UpdateFailed(str(err)) from err
        # Read again on every update, so tonight moves on with the clock.
        self.night = night(self.latitude, self.longitude, dt_util.utcnow())
        return kp_tonight(periods, self.night) if self.night else None


class CloudCoordinator(DataUpdateCoordinator[CloudsTonight | None]):
    config_entry: AuroraConfigEntry

    def __init__(self, hass: HomeAssistant, entry: AuroraConfigEntry) -> None:
        super().__init__(hass, _LOGGER, config_entry=entry, name=f"{DOMAIN} clouds", update_interval=CLOUD_INTERVAL)
        self.weather: str = entry.data[CONF_WEATHER]
        self.latitude: float = entry.data[CONF_LATITUDE]
        self.longitude: float = entry.data[CONF_LONGITUDE]

    async def _async_update_data(self) -> CloudsTonight | None:
        dark = night(self.latitude, self.longitude, dt_util.utcnow())
        if dark is None:
            return None
        try:
            response: Any = await self.hass.services.async_call(
                "weather",
                "get_forecasts",
                {"entity_id": self.weather, "type": "hourly"},
                blocking=True,
                return_response=True,
            )
        except HomeAssistantError as err:
            raise UpdateFailed(f"{self.weather} gave no hourly forecast: {err}") from err
        forecast = (response or {}).get(self.weather, {}).get("forecast")
        if not isinstance(forecast, list):
            raise UpdateFailed(f"{self.weather} gave no hourly forecast")
        return clouds_tonight(forecast, dark)
