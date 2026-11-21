import { describe, expect, it } from "vitest";

import {
    cloudHours,
    darkIn,
    nightWindow,
    nightsSeen,
    placeSensors,
    ratioSeries,
    stateSeries,
    valueAt,
    visibilitySensors,
} from "../src/aurora";
import type { HistoryRow } from "../src/aurora";
import type { HassEntity, HomeAssistant } from "../src/hass";

function entity(
    entity_id: string,
    state: string,
    attributes: Record<string, unknown> = {},
    updated = "2026-01-15T20:10:00+00:00",
): HassEntity {
    return { entity_id, state, attributes, last_changed: updated, last_updated: updated };
}

const R = { latitude: 60.5, longitude: 24.65, lower_limit: 60 };

/** One place, Testikylä, with a station each side of it, and a second place whose station must not be mixed in. */
function hass(): HomeAssistant {
    const states = [
        entity("sensor.testikyla_visibility", "possible", { ratio: 0.7 }),
        entity("sensor.testikyla_kp", "4.33"),
        entity("sensor.testikyla_clouds", "40"),
        entity("sensor.south_r", "30", R),
        entity("sensor.north_r", "70", { ...R, latitude: 62.25, lower_limit: 63 }),
        entity("sensor.north_activity", "12"),
        entity("sensor.other_r", "10", R),
    ];
    return {
        states: Object.fromEntries(states.map((state) => [state.entity_id, state])),
        entities: {
            "sensor.testikyla_visibility": {
                entity_id: "sensor.testikyla_visibility",
                device_id: "place",
                platform: "aurora_finland",
                translation_key: "visibility",
            },
            "sensor.testikyla_kp": {
                entity_id: "sensor.testikyla_kp",
                device_id: "place",
                platform: "aurora_finland",
                translation_key: "kp_tonight",
            },
            "sensor.testikyla_clouds": {
                entity_id: "sensor.testikyla_clouds",
                device_id: "place",
                platform: "aurora_finland",
                translation_key: "clouds_tonight",
            },
            "sensor.south_r": { entity_id: "sensor.south_r", device_id: "south", platform: "aurora_finland", translation_key: "r_index" },
            "sensor.north_r": { entity_id: "sensor.north_r", device_id: "north", platform: "aurora_finland", translation_key: "r_index" },
            "sensor.north_activity": {
                entity_id: "sensor.north_activity",
                device_id: "north",
                platform: "aurora_finland",
                translation_key: "activity",
            },
            "sensor.other_r": { entity_id: "sensor.other_r", device_id: "other", platform: "aurora_finland", translation_key: "r_index" },
            "sensor.weather_r": {
                entity_id: "sensor.weather_r",
                device_id: "south",
                platform: "somebody_else",
                translation_key: "r_index",
            },
        },
        devices: {
            place: { id: "place", name: "Testikylä" },
            south: { id: "south", name: "Etelä", via_device_id: "place" },
            north: { id: "north", name: "Pohjola", name_by_user: "Pohjoinen", via_device_id: "place" },
            other: { id: "other", name: "Muualla", via_device_id: "another place" },
        },
    };
}

describe("placeSensors", () => {
    it("finds the place's Kp, clouds and its own stations, northernmost first", () => {
        const sensors = placeSensors(hass(), "sensor.testikyla_visibility");
        expect(sensors.kp).toBe("sensor.testikyla_kp");
        expect(sensors.clouds).toBe("sensor.testikyla_clouds");
        expect(sensors.stations.map((station) => [station.name, station.entity, station.lower])).toEqual([
            ["Pohjoinen", "sensor.north_r", 63],
            ["Etelä", "sensor.south_r", 60],
        ]);
    });

    it("leaves out a station without its limits, as its colour can't be worked out", () => {
        const home = hass();
        home.states["sensor.south_r"] = entity("sensor.south_r", "unavailable");
        const sensors = placeSensors(home, "sensor.testikyla_visibility");
        expect(sensors.stations.map((station) => station.entity)).toEqual(["sensor.north_r"]);
        expect(sensors.complete).toBe(false);
    });

    it("finds nothing for an entity that isn't in the registry", () => {
        expect(placeSensors(hass(), "sensor.nowhere")).toEqual({ visibility: "sensor.nowhere", stations: [], complete: true });
    });

    it("lists the integration's visibility sensors for the picker", () => {
        expect(visibilitySensors(hass())).toEqual(["sensor.testikyla_visibility"]);
    });
});

describe("nightWindow", () => {
    const zone = "Europe/Helsinki";

    it("runs from noon to eight the next morning", () => {
        const window = nightWindow(Date.parse("2026-01-15T20:12:00Z"), zone);
        expect(new Date(window.start).toISOString()).toBe("2026-01-15T10:00:00.000Z");
        expect(new Date(window.end).toISOString()).toBe("2026-01-16T06:00:00.000Z");
    });

    it("shows the night just gone before noon", () => {
        const window = nightWindow(Date.parse("2026-01-16T09:59:00Z"), zone);
        expect(new Date(window.start).toISOString()).toBe("2026-01-15T10:00:00.000Z");
        expect(nightWindow(Date.parse("2026-01-16T10:00:00Z"), zone).start).toBe(Date.parse("2026-01-16T10:00:00Z"));
    });

    it("starts at noon by the summer clock and ends at eight by the winter one across the change in October", () => {
        // Clocks go back from 4 to 3 in the night to 25 October 2026, so the night is 21 hours long.
        const window = nightWindow(Date.parse("2026-10-24T15:00:00Z"), zone);
        expect(new Date(window.start).toISOString()).toBe("2026-10-24T09:00:00.000Z");
        expect(new Date(window.end).toISOString()).toBe("2026-10-25T06:00:00.000Z");
    });

    it("ends at eight by the summer clock across the change in March", () => {
        // Clocks go forward from 3 to 4 in the night to 28 March 2027, so the night is 19 hours long.
        const window = nightWindow(Date.parse("2027-03-27T15:00:00Z"), zone);
        expect(new Date(window.start).toISOString()).toBe("2027-03-27T10:00:00.000Z");
        expect(new Date(window.end).toISOString()).toBe("2027-03-28T05:00:00.000Z");
    });

    it("follows the zone it is given, not the machine's", () => {
        const window = nightWindow(Date.parse("2026-01-15T20:12:00Z"), "America/New_York");
        expect(new Date(window.start).toISOString()).toBe("2026-01-15T17:00:00.000Z");
    });
});

describe("dark hours", () => {
    const window = nightWindow(Date.parse("2026-01-16T07:00:00Z"), "Europe/Helsinki");
    const lastNight = { dark_start: "2026-01-15T15:04:00+00:00", dark_end: "2026-01-16T05:10:00+00:00" };
    const tonight = { dark_start: "2026-01-16T15:06:00+00:00", dark_end: "2026-01-17T05:09:00+00:00" };

    it("finds the night just gone in the history after the sensor has moved on to the next", () => {
        const rows = [
            { s: "unlikely", a: lastNight, lu: Date.parse("2026-01-15T20:00:00Z") / 1000 },
            { s: "unlikely", a: lastNight, lu: Date.parse("2026-01-16T03:00:00Z") / 1000 },
            { s: "unlikely", a: tonight, lu: Date.parse("2026-01-16T05:15:00Z") / 1000 },
        ];
        const nights = nightsSeen(rows, entity("sensor.visibility", "unlikely", tonight));
        expect(nights).toHaveLength(2);
        expect(darkIn(nights, window)).toEqual({ start: Date.parse(lastNight.dark_start), end: Date.parse(lastNight.dark_end) });
    });

    it("takes the night given last when the sensor's dark hours shift within a night", () => {
        const later = { ...lastNight, dark_end: "2026-01-16T05:11:00+00:00" };
        const nights = nightsSeen(
            [
                { s: "unlikely", a: lastNight, lu: Date.parse("2026-01-15T20:00:00Z") / 1000 },
                { s: "unlikely", a: later, lu: Date.parse("2026-01-16T00:00:00Z") / 1000 },
            ],
            undefined,
        );
        expect(darkIn(nights, window)?.end).toBe(Date.parse(later.dark_end));
    });

    it("has nothing to shade when no night falls on the window", () => {
        expect(darkIn(nightsSeen([], entity("sensor.visibility", "unlikely", tonight)), window)).toBeUndefined();
        expect(nightsSeen([], entity("sensor.visibility", "unlikely", { dark_start: null, dark_end: null }))).toEqual([]);
    });
});

describe("series", () => {
    it("reads the ratio from the attributes and adds the current state when it is newer", () => {
        const rows = [
            { s: "unlikely", a: { ratio: 0.2 }, lu: Date.parse("2026-01-15T18:00:00Z") / 1000 },
            { s: "unlikely", a: {}, lu: Date.parse("2026-01-15T18:05:00Z") / 1000 },
            { s: "possible", a: { ratio: 0.7 }, lu: Date.parse("2026-01-15T18:10:00Z") / 1000 },
        ];
        const points = ratioSeries(rows, entity("sensor.v", "possible", { ratio: 0.9 }, "2026-01-15T18:15:00+00:00"));
        expect(points.map((point) => point.value)).toEqual([0.2, 0.7, 0.9]);
    });

    it("doesn't add the current state again when the history already ends with it", () => {
        const at = Date.parse("2026-01-15T18:10:00Z");
        const points = ratioSeries(
            [{ s: "possible", a: { ratio: 0.7 }, lu: at / 1000 }],
            entity("sensor.v", "possible", { ratio: 0.7 }, "2026-01-15T18:10:00+00:00"),
        );
        expect(points).toEqual([{ at, value: 0.7 }]);
    });

    it("leaves unavailable states out of a station's", () => {
        const rows = [
            { s: "30", lu: 100 },
            { s: "unavailable", lu: 200 },
            { s: "45", lu: 300 },
        ];
        expect(stateSeries(rows, undefined)).toEqual([
            { at: 100_000, value: 30 },
            { at: 300_000, value: 45 },
        ]);
    });

    it("gives the value in force at a moment", () => {
        const points = [
            { at: 100, value: 1 },
            { at: 200, value: 2 },
        ];
        expect(valueAt(points, 99)).toBeUndefined();
        expect(valueAt(points, 100)).toBe(1);
        expect(valueAt(points, 199)).toBe(1);
        expect(valueAt(points, 5000)).toBe(2);
    });
});

describe("cloudHours", () => {
    it("reads the hours and skips those it can't", () => {
        const clouds = entity("sensor.c", "50", {
            hours: [
                { time: "2026-01-15T16:00:00+00:00", cloud_coverage: 40 },
                { time: "nonsense", cloud_coverage: 10 },
                { time: "2026-01-15T17:00:00+00:00" },
                null,
            ],
        });
        expect(cloudHours(undefined, clouds)).toEqual([{ at: Date.parse("2026-01-15T16:00:00Z"), cover: 40 }]);
    });

    it("keeps the hours gone by from the history, each with its last forecast", () => {
        const hour = (at: string, cover: number) => ({ time: `2026-01-15T${at}:00+00:00`, cloud_coverage: cover });
        const rows = [
            { s: "60", lu: 0, a: { hours: [hour("16:00", 80), hour("17:00", 60), hour("18:00", 40)] } },
            { s: "45", lu: 0, a: { hours: [hour("17:00", 50), hour("18:00", 40)] } },
            { s: "30" },
        ] as HistoryRow[];
        const now = entity("sensor.c", "30", { hours: [hour("18:00", 30)] });
        expect(cloudHours(rows, now).map((item) => item.cover)).toEqual([80, 50, 30]);
    });
});
