"""Adding a place, and moving it."""

from homeassistant.config_entries import SOURCE_USER
from homeassistant.const import CONF_LATITUDE, CONF_LOCATION, CONF_LONGITUDE, CONF_NAME
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResultType
from pytest_homeassistant.test_util.aiohttp import AiohttpClientMocker

from custom_components.aurora_finland.const import CONF_WEATHER, DOMAIN

from .conftest import LATITUDE, LONGITUDE, aurora_entry

INPUT = {CONF_NAME: "Example", CONF_LOCATION: {CONF_LATITUDE: 62.6, CONF_LONGITUDE: 29.76}, CONF_WEATHER: "weather.example"}


async def test_add(hass: HomeAssistant, feeds: AiohttpClientMocker) -> None:
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": SOURCE_USER})
    assert result["type"] is FlowResultType.FORM
    result = await hass.config_entries.flow.async_configure(result["flow_id"], INPUT)
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["title"] == "Example"
    assert result["data"] == {CONF_LATITUDE: 62.6, CONF_LONGITUDE: 29.76, CONF_WEATHER: "weather.example"}
    assert result["result"].unique_id == "62.60_29.76"
    await hass.async_block_till_done()


async def test_without_weather(hass: HomeAssistant, feeds: AiohttpClientMocker) -> None:
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": SOURCE_USER})
    result = await hass.config_entries.flow.async_configure(result["flow_id"], {k: v for k, v in INPUT.items() if k != CONF_WEATHER})
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert CONF_WEATHER not in result["data"]
    await hass.async_block_till_done()


async def test_same_place_twice(hass: HomeAssistant, feeds: AiohttpClientMocker) -> None:
    aurora_entry(hass)
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": SOURCE_USER})
    same = {CONF_NAME: "Again", CONF_LOCATION: {CONF_LATITUDE: LATITUDE, CONF_LONGITUDE: LONGITUDE}}
    result = await hass.config_entries.flow.async_configure(result["flow_id"], same)
    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "already_configured"


async def test_reconfigure(hass: HomeAssistant, feeds: AiohttpClientMocker) -> None:
    entry = aurora_entry(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()

    result = await entry.start_reconfigure_flow(hass)
    assert result["type"] is FlowResultType.FORM
    result = await hass.config_entries.flow.async_configure(result["flow_id"], INPUT)
    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "reconfigure_successful"
    await hass.async_block_till_done()
    assert entry.title == "Example"
    assert entry.unique_id == "62.60_29.76"
    assert entry.data[CONF_WEATHER] == "weather.example"


async def test_reconfigure_onto_another_place(hass: HomeAssistant, feeds: AiohttpClientMocker) -> None:
    entry = aurora_entry(hass)
    other = aurora_entry(hass)
    hass.config_entries.async_update_entry(other, unique_id="62.60_29.76")
    result = await entry.start_reconfigure_flow(hass)
    result = await hass.config_entries.flow.async_configure(result["flow_id"], INPUT)
    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "already_configured"
