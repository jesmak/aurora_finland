"""Fetching the files, each asked for again only when it has changed."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import aiohttp
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.util.json import json_loads

from .feeds import FeedError

TIMEOUT = aiohttp.ClientTimeout(total=30)


@dataclass
class _Cached:
    body: Any
    # FMI's server answers If-Modified-Since with 304 and sends no ETag, NOAA's sends an ETag.
    last_modified: str | None
    etag: str | None


class Files:
    """The last copy of each file, so an unchanged one costs a 304."""

    def __init__(self, hass: HomeAssistant) -> None:
        self._session = async_get_clientsession(hass)
        self._cache: dict[str, _Cached] = {}

    async def get(self, url: str, source: str) -> Any:
        cached = self._cache.get(url)
        headers = {}
        if cached and cached.etag:
            headers["If-None-Match"] = cached.etag
        elif cached and cached.last_modified:
            headers["If-Modified-Since"] = cached.last_modified
        try:
            async with self._session.get(url, headers=headers, timeout=TIMEOUT) as response:
                if response.status == 304 and cached:
                    return cached.body
                if response.status != 200:
                    raise FeedError(f"{source} answered with status {response.status}")
                raw = await response.read()
                last_modified, etag = response.headers.get("Last-Modified"), response.headers.get("ETag")
        except (aiohttp.ClientError, TimeoutError) as err:
            # A timeout's message is empty, so the type is the cause.
            raise FeedError(f"{source} couldn't be reached: {str(err) or type(err).__name__}") from err
        try:
            body = json_loads(raw)
        except ValueError as err:
            raise FeedError(f"{source} sent something that isn't JSON") from err
        self._cache[url] = _Cached(body, last_modified, etag)
        return body
