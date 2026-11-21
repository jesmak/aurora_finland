"""Constants for the Aurora Finland integration."""

from datetime import timedelta
from typing import Final

DOMAIN: Final = "aurora_finland"

ATTRIBUTION: Final = "Data provided by the Finnish Meteorological Institute (CC BY 4.0) and NOAA SWPC"

# FMI's space weather files. Both are rewritten every five minutes.
R_INDEX_URL: Final = "https://space.fmi.fi/MIRACLE/RWC/data/r_index_latest_en.json"
RX_URL: Final = "https://space.fmi.fi/MIRACLE/RWC/data/RX_latest_en.json"
# NOAA's planetary Kp, observed and forecast, in three-hour periods about three days ahead.
KP_URL: Final = "https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json"

FMI_INTERVAL: Final = timedelta(minutes=5)
KP_INTERVAL: Final = timedelta(minutes=30)
CLOUD_INTERVAL: Final = timedelta(minutes=30)

CONF_WEATHER: Final = "weather_entity"

# The sun's elevation at or below which the sky counts as dark enough for the aurora.
DARK_ELEVATION: Final = -10.0

EVENT_LIKELY: Final = "likely"
