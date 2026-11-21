"""Shared fixtures: FMI's and NOAA's files in their real shape, with made-up readings."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
from freezegun.api import FrozenDateTimeFactory
from homeassistant.const import CONF_LATITUDE, CONF_LONGITUDE
from homeassistant.core import HomeAssistant
from pytest_homeassistant.common import MockConfigEntry
from pytest_homeassistant.test_util.aiohttp import AiohttpClientMocker

from custom_components.aurora_finland.const import DOMAIN, KP_URL, R_INDEX_URL, RX_URL

FIXTURES = Path(__file__).parent / "fixtures"

# Lappeenranta, between Nurmijärvi and Hankasalmi in latitude. Evening in January, so it is dark.
LATITUDE = 61.06
LONGITUDE = 28.19
NOW = datetime(2026, 1, 15, 20, 12, tzinfo=UTC)


def fixture(name: str) -> Any:
    return json.loads((FIXTURES / name).read_text())


@pytest.fixture
def feeds(aioclient_mock: AiohttpClientMocker, freezer: FrozenDateTimeFactory) -> AiohttpClientMocker:
    freezer.move_to(NOW)
    aioclient_mock.get(R_INDEX_URL, json=fixture("r_index.json"), headers={"Last-Modified": "Thu, 15 Jan 2026 20:11:19 GMT"})
    aioclient_mock.get(RX_URL, json=fixture("rx.json"), headers={"Last-Modified": "Thu, 15 Jan 2026 20:11:19 GMT"})
    aioclient_mock.get(KP_URL, json=fixture("kp.json"), headers={"ETag": '"1afd-1"'})
    return aioclient_mock


def aurora_entry(hass: HomeAssistant, **data: Any) -> MockConfigEntry:
    entry = MockConfigEntry(
        domain=DOMAIN,
        title="Example",
        unique_id=f"{LATITUDE:.2f}_{LONGITUDE:.2f}",
        data={CONF_LATITUDE: LATITUDE, CONF_LONGITUDE: LONGITUDE, **data},
    )
    entry.add_to_hass(hass)
    return entry
