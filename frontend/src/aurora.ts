/**
 * What the card reads from Home Assistant: the place's sensors, found from its visibility sensor through the registry,
 * the night's window, and the night's activity from the recorder's history.
 */
import type { HassEntity, HomeAssistant } from "./hass";

export const DOMAIN = "aurora_finland";

/** The night's timeline runs from noon to eight the next morning, by the clock of the zone the card shows. */
const WINDOW_START_HOUR = 12;
const WINDOW_END_HOUR = 8;

export interface Station {
    name: string;
    /** The R-index sensor. */
    entity: string;
    latitude: number;
    longitude: number;
    lower: number;
}

export interface Sensors {
    visibility: string;
    kp?: string;
    clouds?: string;
    stations: Station[];
    /** False while a station's sensor has no state yet to give its place, so the lookup is worth repeating. */
    complete: boolean;
}

/** Every visibility sensor of the integration, for the editor's picker and a new card's default. */
export function visibilitySensors(hass: HomeAssistant): string[] {
    return Object.values(hass.entities ?? {})
        .filter((entry) => entry?.platform === DOMAIN && entry.translation_key === "visibility")
        .map((entry) => entry!.entity_id)
        .sort();
}

/**
 * The place's other sensors. Tonight's Kp and clouds are on the place's device, and each station's R-index on a device
 * of its own, which names the place's as its parent.
 */
export function placeSensors(hass: HomeAssistant, visibility: string): Sensors {
    const entries = Object.values(hass.entities ?? {}).filter((entry) => entry?.platform === DOMAIN);
    const place = hass.entities?.[visibility]?.device_id;
    const sensors: Sensors = { visibility, stations: [], complete: true };
    if (!place) {
        return sensors;
    }
    for (const entry of entries) {
        if (!entry?.device_id) {
            continue;
        }
        if (entry.device_id === place && entry.translation_key === "kp_tonight") {
            sensors.kp = entry.entity_id;
        } else if (entry.device_id === place && entry.translation_key === "clouds_tonight") {
            sensors.clouds = entry.entity_id;
        } else if (entry.translation_key === "r_index" && hass.devices?.[entry.device_id]?.via_device_id === place) {
            const state = hass.states[entry.entity_id];
            const latitude = number(state?.attributes.latitude);
            const longitude = number(state?.attributes.longitude);
            const lower = number(state?.attributes.lower_limit);
            const device = hass.devices[entry.device_id];
            if (latitude !== undefined && longitude !== undefined && lower !== undefined && lower > 0) {
                const name = device?.name_by_user || device?.name || entry.entity_id;
                sensors.stations.push({ name, entity: entry.entity_id, latitude, longitude, lower });
            } else {
                sensors.complete = false;
            }
        }
    }
    sensors.stations.sort((a, b) => b.latitude - a.latitude);
    return sensors;
}

export function number(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
        return Number(value);
    }
    return undefined;
}

export function time(value: unknown): number | undefined {
    if (typeof value !== "string") {
        return undefined;
    }
    const at = Date.parse(value);
    return Number.isNaN(at) ? undefined : at;
}

/**
 * The night shown, as milliseconds: from noon to eight the next morning in the zone given. Before noon it is the night
 * just gone, so the morning still shows it.
 */
export function nightWindow(now: number, timeZone?: string): { start: number; end: number } {
    const today = clock(now, timeZone);
    const day = today.day + (today.hour < WINDOW_START_HOUR ? -1 : 0);
    // Each end by the clock, so a change of daylight saving time in the night makes the night an hour longer or shorter.
    return {
        start: atClock(today.year, today.month, day, WINDOW_START_HOUR, timeZone),
        end: atClock(today.year, today.month, day + 1, WINDOW_END_HOUR, timeZone),
    };
}

/** The moment a zone's clock shows a whole hour on a day, as milliseconds. Days past the month's end roll over. */
function atClock(year: number, month: number, day: number, hour: number, timeZone?: string): number {
    const wall = Date.UTC(year, month - 1, day, hour);
    return wall - offset(wall - offset(wall, timeZone), timeZone);
}

export interface Night {
    start: number;
    end: number;
}

/** The dark hours the visibility sensor has given, from its history and its state now, each night once. */
export function nightsSeen(rows: HistoryRow[] | undefined, current: HassEntity | undefined): Night[] {
    const nights: Night[] = [];
    for (const attributes of [...(rows ?? []).map((row) => row.a), current?.attributes]) {
        const start = time(attributes?.dark_start);
        const end = time(attributes?.dark_end);
        const last = nights[nights.length - 1];
        if (start !== undefined && end !== undefined && (last?.start !== start || last.end !== end)) {
            nights.push({ start, end });
        }
    }
    return nights;
}

/**
 * The dark hours to shade on a window: the last night given that falls on it. At dawn the sensor moves on to the next
 * night, so before noon the night shown is found in the history.
 */
export function darkIn(nights: Night[], window: { start: number; end: number }): Night | undefined {
    return nights.filter((night) => night.end > window.start && night.start < window.end).pop();
}

/** A row of the recorder's compressed history: the state, its attributes and when it was last updated, in seconds. */
export interface HistoryRow {
    s: string;
    a?: Record<string, unknown>;
    lu: number;
}

export interface Point {
    at: number;
    value: number;
}

/** The visibility estimate's activity against the lower limit through the night, from the sensor's own history. */
export function ratioSeries(rows: HistoryRow[] | undefined, current: HassEntity | undefined): Point[] {
    const points = (rows ?? []).flatMap((row) => {
        const value = number(row.a?.ratio);
        return value === undefined ? [] : [{ at: row.lu * 1000, value }];
    });
    const now = number(current?.attributes.ratio);
    const updated = time(current?.last_updated);
    if (now !== undefined && updated !== undefined && (points.length === 0 || points[points.length - 1].at < updated)) {
        points.push({ at: updated, value: now });
    }
    return points;
}

/** A station's R-index through the night, from its sensor's history, unavailable states left out. */
export function stateSeries(rows: HistoryRow[] | undefined, current: HassEntity | undefined): Point[] {
    const points = (rows ?? []).flatMap((row) => {
        const value = number(row.s);
        return value === undefined ? [] : [{ at: row.lu * 1000, value }];
    });
    const now = number(current?.state);
    const updated = time(current?.last_updated);
    if (now !== undefined && updated !== undefined && (points.length === 0 || points[points.length - 1].at < updated)) {
        points.push({ at: updated, value: now });
    }
    return points;
}

/** The value in force at a moment: the last one at or before it. Undefined before the first. */
export function valueAt(points: Point[], at: number): number | undefined {
    let found: number | undefined;
    for (const point of points) {
        if (point.at > at) {
            break;
        }
        found = point.value;
    }
    return found;
}

export interface CloudHour {
    at: number;
    cover: number;
}

/**
 * The night's cloud cover hour by hour, from the clouds sensor's `hours` in its history and now. Each update starts
 * from the current hour and drops the hours gone by, so those come from the history, each with the last forecast made
 * for it.
 */
export function cloudHours(rows: HistoryRow[] | undefined, current: HassEntity | undefined): CloudHour[] {
    const cover = new Map<number, number>();
    for (const hours of [...(rows ?? []).map((row) => row.a?.hours), current?.attributes.hours]) {
        for (const hour of Array.isArray(hours) ? hours : []) {
            const item = hour as Record<string, unknown> | null;
            const at = time(item?.time);
            const value = number(item?.cloud_coverage);
            if (at !== undefined && value !== undefined) {
                cover.set(at, value);
            }
        }
    }
    return [...cover].map(([at, value]) => ({ at, cover: value })).sort((a, b) => a.at - b.at);
}

/** How far a time zone's clock is ahead of UTC at a moment, in milliseconds. */
function offset(at: number, timeZone?: string): number {
    const { year, month, day, hour, minute, second } = clock(at, timeZone);
    return Date.UTC(year, month - 1, day, hour, minute, second) - Math.floor(at / 1000) * 1000;
}

/** What a time zone's clock and calendar read at a moment, by their parts rather than a formatted string's layout. */
function clock(at: number, timeZone?: string): Record<"year" | "month" | "day" | "hour" | "minute" | "second", number> {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone,
        hourCycle: "h23",
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        second: "numeric",
    }).formatToParts(at);
    const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((item) => item.type === type)?.value);
    return {
        year: part("year"),
        month: part("month"),
        day: part("day"),
        hour: part("hour"),
        minute: part("minute"),
        second: part("second"),
    };
}
