"""Config flow: a place, and a weather entity for tonight's clouds."""

from __future__ import annotations

from typing import Any

import voluptuous as vol
from homeassistant.config_entries import ConfigFlow, ConfigFlowResult
from homeassistant.const import CONF_LATITUDE, CONF_LOCATION, CONF_LONGITUDE, CONF_NAME
from homeassistant.helpers.selector import EntitySelector, EntitySelectorConfig, LocationSelector, LocationSelectorConfig, TextSelector

from .const import CONF_WEATHER, DOMAIN


class AuroraFinlandConfigFlow(ConfigFlow, domain=DOMAIN):
    VERSION = 1

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        if user_input is not None:
            data = _data(user_input)
            await self.async_set_unique_id(_unique_id(data))
            self._abort_if_unique_id_configured()
            return self.async_create_entry(title=user_input[CONF_NAME], data=data)
        defaults = {
            CONF_NAME: self.hass.config.location_name,
            CONF_LOCATION: {CONF_LATITUDE: self.hass.config.latitude, CONF_LONGITUDE: self.hass.config.longitude},
        }
        return self.async_show_form(step_id="user", data_schema=self.add_suggested_values_to_schema(_SCHEMA, defaults))

    async def async_step_reconfigure(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        entry = self._get_reconfigure_entry()
        if user_input is not None:
            data = _data(user_input)
            await self.async_set_unique_id(_unique_id(data))
            # Moving the place is allowed, onto another entry's place isn't.
            if self.unique_id != entry.unique_id:
                self._abort_if_unique_id_configured()
            # The entry's update listener reloads it.
            return self.async_update_and_abort(entry, title=user_input[CONF_NAME], unique_id=_unique_id(data), data=data)
        defaults = {
            CONF_NAME: entry.title,
            CONF_LOCATION: {CONF_LATITUDE: entry.data[CONF_LATITUDE], CONF_LONGITUDE: entry.data[CONF_LONGITUDE]},
            CONF_WEATHER: entry.data.get(CONF_WEATHER),
        }
        return self.async_show_form(step_id="reconfigure", data_schema=self.add_suggested_values_to_schema(_SCHEMA, defaults))


_SCHEMA = vol.Schema(
    {
        vol.Required(CONF_NAME): TextSelector(),
        vol.Required(CONF_LOCATION): LocationSelector(LocationSelectorConfig(radius=False)),
        vol.Optional(CONF_WEATHER): EntitySelector(EntitySelectorConfig(domain="weather")),
    }
)


def _data(user_input: dict[str, Any]) -> dict[str, Any]:
    location = user_input[CONF_LOCATION]
    data: dict[str, Any] = {CONF_LATITUDE: float(location[CONF_LATITUDE]), CONF_LONGITUDE: float(location[CONF_LONGITUDE])}
    if user_input.get(CONF_WEATHER):
        data[CONF_WEATHER] = user_input[CONF_WEATHER]
    return data


def _unique_id(data: dict[str, Any]) -> str:
    # Places in the same 0.01° cell count as one, as their estimates would be the same.
    return f"{data[CONF_LATITUDE]:.2f}_{data[CONF_LONGITUDE]:.2f}"
