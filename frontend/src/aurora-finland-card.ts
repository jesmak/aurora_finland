/**
 * A dashboard card for the aurora's visibility at one place, from the aurora_finland integration's sensors.
 *
 * A header line with the visibility and where to look, and the parts switched on in the editor: the sky drawn with where
 * to look, tonight's clouds and Kp, a map of the stations, and the night's activity from noon to eight in the morning.
 * Moving over the timeline shows a moment in a tooltip. Clicking it, or replaying the night, holds the whole card at
 * that moment, so the map's stations can be looked at as they were then.
 */
import { LitElement, css, html, nothing, svg } from "lit";
import type { CSSResultGroup, PropertyValues, SVGTemplateResult, TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";

import {
    cloudHours,
    darkIn,
    nightWindow,
    nightsSeen,
    rowAt,
    number,
    placeSensors,
    ratioSeries,
    stateSeries,
    time,
    valueAt,
    visibilitySensors,
} from "./aurora";
import type { HistoryRow, Night, Point, Sensors, Station } from "./aurora";
import "./editor";
import { FINLAND } from "./finland";
import type { HomeAssistant } from "./hass";
import { gridMinRows, heightCardSize, heightStyle, validHeight } from "./height";
import { browserLanguage, translate } from "./localize/localize";
import { drawnScale, fillLimit, filledHeight, filledStyle, heldSpare, spareRoom, validRowStep } from "./rows";
import { shows } from "./types";
import type { AuroraCardConfig } from "./types";

declare const __CARD_VERSION__: string;
const CARD_VERSION = __CARD_VERSION__;

const HOUR_MS = 3_600_000;
const TICK_MS = 60_000;
/** The card's padding, which the room a whole row leaves over is added to, half above and half below. */
const PADDING = 16;
/** A replay of the night takes about this long, however much of it has passed. */
const REPLAY_MS = 4_000;
const REPLAY_FRAME_MS = 50;
/** How long a tapped tooltip stays. */
const TAP_TIP_MS = 3000;
const MAP_HEIGHT = 192;
const STATE_ICONS: Record<string, string> = { unlikely: "mdi:weather-night", possible: "mdi:aurora", likely: "mdi:aurora" };

interface History {
    /** What the history was read for: the window, the sensors and whether the map needs the stations'. */
    key: string;
    ratio: Point[];
    stations: Record<string, Point[]>;
    /** The dark hours the visibility sensor gave through the window. */
    nights: Night[];
    /** The clouds sensor's states through the window, for the hours its forecast has dropped. */
    clouds: HistoryRow[];
    /** The visibility sensor's states through the window, for the header and the sky at a moment held. */
    visibility: HistoryRow[];
}

interface Tip {
    lines: string[];
    /** Where the pointer is, from the card's top left corner. */
    x: number;
    y: number;
}

export class AuroraFinlandCard extends LitElement {
    @property({ attribute: false }) public hass?: HomeAssistant;
    @property({ attribute: false }) public layout?: string;
    @state() private config?: AuroraCardConfig;
    @state() private history?: History;
    /** The moment the card is held at, by a click on the timeline or a replay. Unset, the card shows now. */
    @state() private cursor?: number;
    @state() private tip?: Tip;
    /** Where a mouse is over the timeline, for a line there. */
    @state() private hovered?: number;
    private tipTimer?: ReturnType<typeof setTimeout>;
    @state() private playing = false;
    @state() private width = 0;
    @state() private tick = 0;
    @state() private filled = 0;
    @state() private spare = 0;
    private historyFailed = false;
    /** The place's sensors and what they were looked up from, as the lookup walks the whole entity registry. */
    private found?: { from: unknown[]; sensors: Sensors };
    private ticker?: ReturnType<typeof setInterval>;
    private player?: ReturnType<typeof setInterval>;
    private frame?: number;
    private readonly resizes =
        typeof ResizeObserver === "undefined"
            ? undefined
            : new ResizeObserver((entries) => {
                  const width = Math.round(entries[0]?.contentRect.width ?? 0);
                  if (width !== this.width) {
                      this.width = width;
                  }
                  this.measureSoon();
              });

    public static getConfigElement(): HTMLElement {
        return document.createElement("aurora-finland-card-editor");
    }

    /** Offers the first place there is when the card is added from the picker. */
    public static getStubConfig(hass?: HomeAssistant): Record<string, unknown> {
        return { entity: hass ? (visibilitySensors(hass)[0] ?? "") : "" };
    }

    public setConfig(config: AuroraCardConfig): void {
        if (!config || typeof config.entity !== "string" || config.entity === "") {
            throw new Error(translate(browserLanguage(), "common.invalid_configuration"));
        }
        if (!validHeight(config)) {
            throw new Error(translate(browserLanguage(), "common.invalid_height"));
        }
        if (!validRowStep(config)) {
            throw new Error(translate(browserLanguage(), "common.invalid_row_step"));
        }
        this.config = config;
    }

    /** In units of 50 px, for a masonry view. */
    public getCardSize(): number {
        return heightCardSize(this.config ?? {}, Math.ceil(this.minimumHeight() / 50), this.minimumHeight());
    }

    /**
     * In a sections view the card takes a whole section, as the map and tonight's list need about 288 px of card beside
     * each other, a phone's section, and it is never lower than its parts.
     */
    public getGridOptions(): Record<string, unknown> {
        return { columns: 12, min_columns: 12, rows: "auto", min_rows: gridMinRows(this.minimumHeight()) };
    }

    public connectedCallback(): void {
        super.connectedCallback();
        this.tick++;
        this.ticker = setInterval(() => this.tick++, TICK_MS);
        window.addEventListener("keydown", this.escape);
    }

    public disconnectedCallback(): void {
        super.disconnectedCallback();
        clearInterval(this.ticker);
        window.removeEventListener("keydown", this.escape);
        clearTimeout(this.tipTimer);
        this.stop();
        this.cursor = undefined;
        this.resizes?.disconnect();
        cancelAnimationFrame(this.frame ?? 0);
    }

    protected willUpdate(changed: PropertyValues): void {
        if (changed.has("hass") || changed.has("config") || changed.has("tick")) {
            this.readHistory();
            this.followLive();
        }
    }

    protected render(): TemplateResult | typeof nothing {
        if (!this.hass || !this.config) {
            return nothing;
        }
        const entity = this.hass.states[this.config.entity];
        if (!entity || !(entity.state in STATE_ICONS)) {
            return html`<ha-card style=${this.cardStyle()}
                ><div class="content"><div class="message">${this.text("common.unavailable")}</div></div></ha-card
            >`;
        }
        const sensors = this.sensors();
        const now = Date.now();
        const window = nightWindow(now, this.timeZone());
        const at = this.cursor ?? now;
        const map = shows(this.config, "show_map");
        const tonight = shows(this.config, "show_tonight");
        const timeline = shows(this.config, "show_timeline");
        return html`
            <ha-card class=${this.hass.themes?.darkMode ? "dark-theme" : ""} style=${this.cardStyle()}>
                <div class="content">
                    <div class="part">${this.header()}</div>
                    ${tonight && !map ? this.boxes(sensors) : nothing}
                    ${map ? html`<div class="part">${this.map(sensors, at, window, tonight, !timeline)}</div>` : nothing}
                    ${timeline ? html`<div class="part">${this.timeline(sensors, window, now, map)}</div>` : nothing}
                </div>
                ${
                    this.tip
                        ? html`<div
                              class="tip ${this.tip.x > this.width / 2 ? "left" : ""}"
                              style="left: ${this.tip.x}px; top: ${this.tip.y}px"
                          >
                              ${this.tip.lines.map((line) => html`<div>${line}</div>`)}
                          </div>`
                        : nothing
                }
            </ha-card>
        `;
    }

    protected updated(): void {
        const card = this.renderRoot.querySelector("ha-card");
        if (card && this.isConnected) {
            this.resizes?.observe(card);
            this.measureSoon();
        }
    }

    private header(): TemplateResult {
        const entity = this.hass!.states[this.config!.entity]!;
        // Held at a moment, the visibility as it was then, where the history has it.
        const then = this.cursor === undefined ? undefined : rowAt(this.history?.visibility ?? [], this.cursor);
        const held = then && then.s in STATE_ICONS ? then : undefined;
        // Held at a moment the history doesn't reach, or still loading, it says so rather than show now as then.
        const unknown = this.cursor !== undefined && !held;
        const level = held ? held.s : unknown ? "none" : entity.state;
        const attributes = held ? (held.a ?? {}) : unknown ? {} : entity.attributes;
        const view = String(attributes.view ?? "");
        const elevation = number(attributes.elevation);
        const where = unknown
            ? ""
            : view === "north" && elevation !== undefined
              ? this.text("view.north", { elevation: String(Math.round(elevation)) })
              : view === "overhead"
                ? this.text("view.overhead")
                : this.text("view.not_visible");
        const sky = shows(this.config, "show_sky");
        return html`
            <div class="header ${sky ? "with-sky" : ""}">
                <div class="grow">
                    <div class="state">
                        <ha-icon class="state-icon ${level}" .icon=${STATE_ICONS[level] ?? "mdi:help-circle-outline"}></ha-icon>
                        <div class="state-text">
                            <div class="title">${this.heading()}</div>
                            <div class="level">${unknown ? this.text("held.no_data") : this.text(`state.${level}`)}</div>
                            <div class="where">${where}</div>
                        </div>
                    </div>
                    <div class="dark">
                        ${this.cursor === undefined ? this.darkness() : this.text("held.at", { time: this.clock(this.cursor) })}
                    </div>
                </div>
                ${sky ? this.sky(level, view, elevation) : nothing}
            </div>
        `;
    }

    /** What the card is about and where. */
    private heading(): string {
        const name = this.placeName();
        return name ? this.text("header.title", { name }) : this.text("header.title_alone");
    }

    /** The place's name, its device's, as the integration names the device after the place. */
    private placeName(): string | undefined {
        const device = this.hass!.devices?.[this.hass!.entities?.[this.config!.entity]?.device_id ?? ""];
        return device?.name_by_user || device?.name || undefined;
    }

    private darkness(): string {
        const attributes = this.hass!.states[this.config!.entity]!.attributes;
        const start = time(attributes.dark_start);
        const end = time(attributes.dark_end);
        if (attributes.dark === true) {
            return end === undefined ? this.text("dark.now") : this.text("dark.until", { end: this.clock(end) });
        }
        return start === undefined ? this.text("dark.light") : this.text("dark.from", { start: this.clock(start) });
    }

    /** The sky seen from below: the rim is the horizon, the centre straight up, north at the top. */
    private sky(level: string, view: string, elevation: number | undefined): TemplateResult {
        const size = this.width && this.width < 320 ? 84 : 100;
        const c = size / 2;
        const r = c - 12;
        const at = (angle: number) => r * (1 - angle / 90);
        let aurora: SVGTemplateResult | typeof nothing = nothing;
        if (view === "north" && elevation !== undefined) {
            const radius = at(elevation);
            const x = radius * Math.sin(1.1);
            const y = c - radius * Math.cos(1.1);
            aurora = svg`<path class="aurora ${level}" d="M ${c - x} ${y} A ${radius} ${radius} 0 0 1 ${c + x} ${y}" />`;
        } else if (view === "overhead") {
            aurora = svg`<g class="overhead ${level}" transform="rotate(-12 ${c} ${c})">
                <ellipse cx=${c} cy=${c - 4} rx=${r * 0.85} ry=${r * 0.28} opacity="0.35" />
                <ellipse cx=${c} cy=${c + 10} rx=${r * 0.7} ry=${r * 0.12} opacity="0.55" />
            </g>`;
        }
        const label = (key: string, dx: number, dy: number) =>
            svg`<text class=${key === "north" ? "north" : ""} x=${c + dx * (r + 7)} y=${c + dy * (r + 7) + 3.5}>${this.text(`compass.${key}`)}</text>`;
        return html`<svg class="sky" width=${size} height=${size} aria-hidden="true">
            <circle class="dome" cx=${c} cy=${c} r=${r} />
            <circle class="ring" cx=${c} cy=${c} r=${at(30)} />
            <circle class="ring" cx=${c} cy=${c} r=${at(60)} />
            ${aurora}
            <circle class="zenith" cx=${c} cy=${c} r="2" />
            ${label("north", 0, -1)} ${label("south", 0, 1)} ${label("east", 1, 0)} ${label("west", -1, 0)}
        </svg>`;
    }

    private boxes(sensors: Sensors): TemplateResult | typeof nothing {
        const clouds = this.clouds(sensors);
        const kp = this.kp(sensors);
        const next = this.nextHour();
        if (!clouds && !kp && !next) {
            return nothing;
        }
        return html`<div class="part boxes">
            ${
                clouds
                    ? html`<div class="box">
                          <div class="key">${this.text("tonight.clouds")}</div>
                          <div class="value">${clouds.mean} %</div>
                          <div class="detail">
                              ${this.text("tonight.clouds_detail", { least: String(clouds.least), time: clouds.clearest })}
                          </div>
                      </div>`
                    : nothing
            }
            ${
                kp
                    ? html`<div class="box">
                          <div class="key">${this.text("tonight.kp")}</div>
                          <div class="value">${kp.value}</div>
                          <div class="detail">${this.text("tonight.kp_detail", { start: kp.start, end: kp.end })}</div>
                      </div>`
                    : nothing
            }
            ${
                next
                    ? html`<div class="box">
                          <div class="key">${this.text("tonight.next_hour")}</div>
                          <div class="value">≤ ${next}</div>
                          <div class="detail">${this.text("tonight.next_hour_detail")}</div>
                      </div>`
                    : nothing
            }
        </div>`;
    }

    private list(sensors: Sensors): TemplateResult | typeof nothing {
        const clouds = this.clouds(sensors);
        const kp = this.kp(sensors);
        const next = this.nextHour();
        if (!clouds && !kp && !next) {
            return nothing;
        }
        const row = (key: string, value: string) => html`<div class="row"><span>${this.text(key)}</span><span>${value}</span></div>`;
        return html`<div class="list">
            ${clouds ? html`${row("tonight.clouds", `${clouds.mean} %`)}${row("tonight.clearest", `${clouds.clearest}, ${clouds.least} %`)}` : nothing}
            ${kp ? html`${row("tonight.kp", kp.value)}${row("tonight.kp_peak", `${kp.start}–${kp.end}`)}` : nothing}
            ${next ? row("tonight.next_hour", `≤ ${next}`) : nothing}
        </div>`;
    }

    /** FMI's forecast of the next hour's most activity at the place, from the visibility sensor. */
    private nextHour(): string | undefined {
        const value = number(this.hass!.states[this.config!.entity]?.attributes.next_hour);
        return value === undefined ? undefined : new Intl.NumberFormat(this.language(), { maximumFractionDigits: 0 }).format(value);
    }

    private clouds(sensors: Sensors): { mean: number; least: number; clearest: string } | undefined {
        const entity = sensors.clouds ? this.hass!.states[sensors.clouds] : undefined;
        const mean = number(entity?.state);
        const least = number(entity?.attributes.least);
        const clearest = time(entity?.attributes.clearest);
        return mean === undefined || least === undefined || clearest === undefined
            ? undefined
            : { mean: Math.round(mean), least: Math.round(least), clearest: this.clock(clearest) };
    }

    private kp(sensors: Sensors): { value: string; start: string; end: string } | undefined {
        const entity = sensors.kp ? this.hass!.states[sensors.kp] : undefined;
        const value = number(entity?.state);
        const start = time(entity?.attributes.start);
        const end = time(entity?.attributes.end);
        if (value === undefined || start === undefined || end === undefined) {
            return undefined;
        }
        const format = new Intl.NumberFormat(this.language(), { maximumFractionDigits: 2 });
        return { value: format.format(value), start: this.clock(start), end: this.clock(end) };
    }

    /** The stations, coloured by their R-index against their lower limit at the moment shown, and tonight's list beside. */
    private map(sensors: Sensors, at: number, window: { start: number; end: number }, beside: boolean, slider: boolean): TemplateResult {
        const list = beside ? this.list(sensors) : nothing;
        // A fixed size, so the card's height doesn't change with its width.
        const height = MAP_HEIGHT;
        const width = Math.round(height / 1.45);
        const [lon0, lon1, lat0, lat1] = [19.8, 32.2, 57.9, 70.3];
        const k = Math.cos((64 * Math.PI) / 180);
        const scale = Math.min((width - 8) / ((lon1 - lon0) * k), (height - 8) / (lat1 - lat0));
        const left = (width - (lon1 - lon0) * k * scale) / 2;
        const point = (lon: number, lat: number) => [left + (lon - lon0) * k * scale, 4 + (lat1 - lat) * scale];
        const outline = FINLAND.map(([lon, lat]) =>
            point(lon, lat)
                .map((v) => v.toFixed(1))
                .join(","),
        ).join(" ");
        const dots = sensors.stations.map((station) => this.dot(station, at, point, width > 150));
        const drawing = html`<svg
            class="map"
            width=${width}
            height=${height}
            role="img"
            aria-label=${this.text("common.name")}
            @pointerleave=${this.hideTip}
        >
            <polygon class="land" points=${outline} />
            ${dots} ${this.place(at, point, [lon0, lon1, lat0, lat1])}
        </svg>`;
        const now = Date.now();
        const controls = slider
            ? html`<div class="scrub">
                  ${this.playButton()}
                  <input
                      type="range"
                      min=${window.start}
                      max=${now}
                      step=${5 * 60_000}
                      .value=${String(at)}
                      @input=${(event: Event) => this.scrubbed(Number((event.target as HTMLInputElement).value), now)}
                  />
                  <span class="at">${this.clock(at)}</span>
              </div>`
            : nothing;
        return html`<div class="map-row ${list === nothing ? "alone" : ""}">${drawing}${list}</div>
            ${controls}`;
    }

    /** The place itself among the stations, with its activity at the moment shown. Left out when it is off the map. */
    private place(
        at: number,
        point: (lon: number, lat: number) => number[],
        [lon0, lon1, lat0, lat1]: number[],
    ): SVGTemplateResult | typeof nothing {
        const entity = this.hass!.states[this.config!.entity]!;
        const latitude = number(entity.attributes.latitude);
        const longitude = number(entity.attributes.longitude);
        if (
            latitude === undefined ||
            longitude === undefined ||
            longitude < lon0 ||
            longitude > lon1 ||
            latitude < lat0 ||
            latitude > lat1
        ) {
            return nothing;
        }
        const name = this.placeName() ?? String(entity.attributes.friendly_name ?? "");
        const ratio = this.cursor === undefined ? number(entity.attributes.ratio) : valueAt(this.history?.ratio ?? [], at);
        const tip = this.tipFor([ratio === undefined ? name : this.text("map.place", { name, percent: String(Math.round(ratio * 100)) })]);
        const [x, y] = point(longitude, latitude);
        return svg`<g class="place" @pointerenter=${tip} @pointerdown=${tip} @pointerleave=${this.hideTip}>
            <circle class="place-ring" cx=${x} cy=${y} r="5" /><circle class="place-dot" cx=${x} cy=${y} r="1.6" />
        </g>`;
    }

    private tipFor(lines: string[]): (event: PointerEvent) => void {
        return (event) => this.showTip(event, lines);
    }

    private dot(station: Station, at: number, point: (lon: number, lat: number) => number[], labelled: boolean): SVGTemplateResult {
        const series = this.history?.stations[station.entity];
        const current = number(this.hass!.states[station.entity]?.state);
        const value = this.cursor === undefined ? current : series ? valueAt(series, at) : undefined;
        const [x, y] = point(station.longitude, station.latitude);
        if (value === undefined) {
            return svg`<circle class="dot none" cx=${x} cy=${y} r="3" @pointerenter=${this.tipFor([station.name])}
                @pointerdown=${this.tipFor([station.name])} @pointerleave=${this.hideTip} />`;
        }
        const ratio = value / station.lower;
        const tip = this.tipFor([
            this.text("map.station", { name: station.name, value: String(Math.round(value)), lower: String(station.lower) }),
        ]);
        return svg`<circle class="dot ${ratioClass(ratio)}" cx=${x} cy=${y} r=${3 + Math.min(ratio, 2) * 2.5}
                opacity=${0.35 + Math.min(ratio, 1) * 0.55} @pointerenter=${tip} @pointerdown=${tip}
                @pointerleave=${this.hideTip} />
            ${labelled ? svg`<text class="code" x=${x + 9} y=${y + 3}>${station.name.slice(0, 3).toUpperCase()}</text>` : nothing}`;
    }

    private timeline(sensors: Sensors, window: { start: number; end: number }, now: number, replay: boolean): TemplateResult {
        const width = Math.max(120, this.width - 2 * PADDING);
        const cloudsShown = shows(this.config, "show_clouds");
        const kpShown = shows(this.config, "show_kp");
        const height = cloudsShown || kpShown ? 96 : 70;
        const pad = { left: 22, right: 6, top: 8, bottom: 16 };
        const inner = { width: width - pad.left - pad.right, height: height - pad.top - pad.bottom };
        const x = (at: number) =>
            pad.left + ((Math.min(Math.max(at, window.start), window.end) - window.start) / (window.end - window.start)) * inner.width;
        const points = (this.history?.ratio ?? []).filter((point) => point.at >= window.start && point.at <= now);
        const top = Math.max(1.6, Math.ceil(Math.max(0, ...points.map((point) => point.value)) * 5) / 5 + 0.2);
        const y = (value: number) => pad.top + inner.height - (Math.min(value, top) / top) * inner.height;
        const bottom = pad.top + inner.height;
        const parts: SVGTemplateResult[] = [];

        const dark = darkIn([...(this.history?.nights ?? []), ...nightsSeen(undefined, this.hass!.states[this.config!.entity])], window);
        if (dark) {
            parts.push(
                svg`<rect class="night" x=${x(dark.start)} y=${pad.top} width=${x(dark.end) - x(dark.start)} height=${inner.height} />`,
            );
        }
        if (cloudsShown && sensors.clouds) {
            const slot = (HOUR_MS / (window.end - window.start)) * inner.width;
            for (const hour of cloudHours(this.history?.clouds, this.hass!.states[sensors.clouds])) {
                if (hour.at < window.start || hour.at >= window.end) {
                    continue;
                }
                const bar = (hour.cover / 100) * inner.height * 0.38;
                parts.push(
                    svg`<rect class="cloud ${hour.at + HOUR_MS <= now ? "past" : ""}" x=${x(hour.at) + 0.75} y=${bottom - bar} width=${Math.max(1, slot - 1.5)} height=${bar} />`,
                );
            }
        }
        const kp = kpShown && sensors.kp ? this.hass!.states[sensors.kp] : undefined;
        const kpStart = time(kp?.attributes.start);
        const kpEnd = time(kp?.attributes.end);
        const kpValue = number(kp?.state);
        if (kpStart !== undefined && kpEnd !== undefined && kpValue !== undefined && kpEnd > window.start && kpStart < window.end) {
            const format = new Intl.NumberFormat(this.language(), { maximumFractionDigits: 1 });
            parts.push(svg`<rect class="kp" x=${x(kpStart)} y=${pad.top} width=${x(kpEnd) - x(kpStart)} height="3" />
                <text class="kp-label" x=${(x(kpStart) + x(kpEnd)) / 2} y=${pad.top + 13}>Kp ${format.format(kpValue)}</text>`);
        }
        parts.push(svg`<line class="limit" x1=${pad.left} x2=${width - pad.right} y1=${y(1)} y2=${y(1)} />
            <text class="axis end" x=${pad.left - 3} y=${y(1) + 3}>1</text><text class="axis end" x=${pad.left - 3} y=${y(0) + 3}>0</text>`);
        if (points.length > 1) {
            // A step line, as each value holds until the next.
            const steps = points.flatMap((point, index) => {
                const next = points[index + 1]?.at ?? now;
                return [`${x(point.at).toFixed(1)},${y(point.value).toFixed(1)}`, `${x(next).toFixed(1)},${y(point.value).toFixed(1)}`];
            });
            parts.push(svg`<polygon class="area" points="${x(points[0].at)},${bottom} ${steps.join(" ")} ${x(now)},${bottom}" />
                <polyline class="activity" points=${steps.join(" ")} />`);
        }
        // Every four hours from noon, and the end. A change of daylight saving time makes the night 19 or 21 hours, so a
        // label is left out where it would come closer than four hours to the end's.
        for (let at = window.start; at + 4 * HOUR_MS <= window.end; at += 4 * HOUR_MS) {
            parts.push(
                svg`<text class="axis ${at === window.start ? "start" : "middle"}" x=${x(at)} y=${height - 3}>${this.hour(at)}</text>`,
            );
        }
        parts.push(svg`<text class="axis end" x=${x(window.end)} y=${height - 3}>${this.hour(window.end)}</text>`);
        if (now < window.end) {
            parts.push(svg`<line class="now" x1=${x(now)} x2=${x(now)} y1=${pad.top} y2=${bottom} />`);
        }
        const value = this.cursor === undefined ? undefined : valueAt(points, this.cursor);
        if (this.hovered !== undefined) {
            parts.push(svg`<line class="hover" x1=${x(this.hovered)} x2=${x(this.hovered)} y1=${pad.top} y2=${bottom} />`);
        }
        if (this.cursor !== undefined) {
            parts.push(svg`<line class="cursor" x1=${x(this.cursor)} x2=${x(this.cursor)} y1=${pad.top} y2=${bottom} />
                ${value === undefined ? nothing : svg`<circle class="cursor-dot" cx=${x(this.cursor)} cy=${y(value)} r="3" />`}`);
        }
        const readout =
            this.cursor !== undefined
                ? this.text("timeline.at", {
                      time: this.clock(this.cursor),
                      percent: value === undefined ? "–" : String(Math.round(value * 100)),
                  })
                : "";
        const moment = (event: MouseEvent) => {
            const box = (event.currentTarget as SVGElement).getBoundingClientRect();
            const share = (event.clientX - box.left - pad.left) / inner.width;
            return Math.min(Math.max(window.start + share * (window.end - window.start), window.start), window.end);
        };
        const clouds = cloudsShown && sensors.clouds ? cloudHours(this.history?.clouds, this.hass!.states[sensors.clouds]) : [];
        // A tooltip for a mouse only: a tap holds the moment instead, and a tooltip would hide it under the finger.
        const move = (event: PointerEvent) => {
            if (event.pointerType !== "mouse") {
                return;
            }
            const at = moment(event);
            this.hovered = at;
            const activity = at <= now ? valueAt(points, at) : undefined;
            const cover = clouds.find((hour) => at >= hour.at && at < hour.at + HOUR_MS)?.cover;
            this.showTip(event, [
                this.text("tip.time", { time: this.clock(at) }),
                ...(activity === undefined ? [] : [this.text("tip.activity", { percent: String(Math.round(activity * 100)) })]),
                ...(cover === undefined ? [] : [this.text("tip.clouds", { percent: String(cover) })]),
            ]);
        };
        const leave = (event: PointerEvent) => {
            this.hovered = undefined;
            this.hideTip(event);
        };
        const hold = (event: MouseEvent) => {
            const at = moment(event);
            this.stop();
            this.cursor = at >= now ? undefined : at;
        };
        const right = this.playing
            ? html`${readout}${this.playButton()}`
            : this.cursor !== undefined
              ? html`${readout}${replay ? this.playButton() : nothing}<button class="now-chip" @click=${this.release}>
                        ${this.text("held.now")}
                    </button>`
              : replay
                ? this.playButton()
                : nothing;
        return html`<div class="head">
                <span>${this.text("timeline.title")}</span>
                <span class="head-right">${right}</span>
            </div>
            <svg class="timeline" width=${width} height=${height} @pointermove=${move} @pointerleave=${leave} @click=${hold}>${parts}</svg>
            <div class="legend">
                <span><i class="swatch activity"></i>${this.text("timeline.activity")}</span>
                <span><i class="swatch limit"></i>${this.text("timeline.limit")}</span>
                ${cloudsShown && sensors.clouds ? html`<span><i class="swatch cloud"></i>${this.text("timeline.clouds")}</span>` : nothing}
                ${kpShown && sensors.kp ? html`<span><i class="swatch kp"></i>${this.text("timeline.kp")}</span>` : nothing}
            </div>`;
    }

    private playButton(): TemplateResult {
        const label = this.text(this.playing ? "timeline.pause" : "timeline.play");
        return html`<ha-icon-button class="play" .label=${label} title=${label} @click=${this.togglePlay}>
            <ha-icon .icon=${this.playing ? "mdi:pause" : "mdi:play"}></ha-icon>
        </ha-icon-button>`;
    }

    private togglePlay(): void {
        if (this.playing) {
            this.stop();
            return;
        }
        // From noon, or on from a moment held or paused at. The pace is the whole night's either way.
        const start = nightWindow(Date.now(), this.timeZone()).start;
        const step = Math.max(60_000, ((Date.now() - start) * REPLAY_FRAME_MS) / REPLAY_MS);
        this.cursor ??= start;
        this.playing = true;
        this.player = setInterval(() => {
            const next = (this.cursor ?? start) + step;
            if (next >= Date.now()) {
                this.release();
            } else {
                this.cursor = next;
            }
        }, REPLAY_FRAME_MS);
    }

    /** Stops a replay where it is, so the card stays held at that moment. */
    private stop(): void {
        clearInterval(this.player);
        this.player = undefined;
        this.playing = false;
    }

    /** Back to now from a moment held. */
    private readonly release = (): void => {
        this.stop();
        this.cursor = undefined;
    };

    private readonly escape = (event: KeyboardEvent): void => {
        if (event.key === "Escape" && this.cursor !== undefined) {
            this.release();
        }
    };

    /** A tip for a mouse follows it. A tapped one stays a while, as lifting the finger counts as leaving. */
    private showTip(event: PointerEvent, lines: string[]): void {
        const card = this.renderRoot.querySelector("ha-card")?.getBoundingClientRect();
        if (!card) {
            return;
        }
        this.tip = { lines, x: event.clientX - card.left, y: event.clientY - card.top };
        clearTimeout(this.tipTimer);
        if (event.pointerType !== "mouse") {
            this.tipTimer = setTimeout(() => (this.tip = undefined), TAP_TIP_MS);
        }
    }

    private readonly hideTip = (event: PointerEvent): void => {
        if (event.pointerType === "mouse") {
            this.tip = undefined;
        }
    };

    private scrubbed(at: number, now: number): void {
        this.stop();
        this.cursor = at >= now - 5 * 60_000 ? undefined : at;
    }

    /** The place's sensors, looked up again only when the registry or the card's sensor changes. */
    private sensors(): Sensors {
        const from = [this.hass?.entities, this.hass?.devices, this.config?.entity];
        if (!this.found?.sensors.complete || from.some((item, index) => item !== this.found!.from[index])) {
            this.found = { from, sensors: placeSensors(this.hass!, this.config!.entity) };
        }
        return this.found.sensors;
    }

    /** Reads the night's history once per window, sensor and map setting. Live states are added as they come. */
    private readHistory(): void {
        const hass = this.hass;
        if (!hass?.callWS || !this.config) {
            return;
        }
        const window = nightWindow(Date.now(), this.timeZone());
        const sensors = this.sensors();
        const stations = shows(this.config, "show_map") ? sensors.stations.map((station) => station.entity) : [];
        const clouds = shows(this.config, "show_timeline") && shows(this.config, "show_clouds") ? sensors.clouds : undefined;
        const key = `${window.start}|${this.config.entity}|${clouds}|${stations.join(",")}`;
        if (this.history?.key === key) {
            return;
        }
        // A new night: a moment held in the one before is gone from the timeline.
        if (this.history && !this.history.key.startsWith(`${window.start}|`)) {
            this.release();
        }
        this.history = { key, ratio: [], stations: {}, nights: [], clouds: [], visibility: [] };
        const start = new Date(window.start).toISOString();
        const visibility = this.config.entity;
        const read = <T>(message: Record<string, unknown>) =>
            hass.callWS!<T>({ type: "history/history_during_period", start_time: start, ...message });
        Promise.all([
            read<Record<string, HistoryRow[]>>({
                entity_ids: clouds ? [visibility, clouds] : [visibility],
                minimal_response: false,
                no_attributes: false,
                significant_changes_only: false,
            }),
            stations.length
                ? read<Record<string, HistoryRow[]>>({
                      entity_ids: stations,
                      minimal_response: true,
                      no_attributes: true,
                      significant_changes_only: false,
                  })
                : Promise.resolve({} as Record<string, HistoryRow[]>),
        ]).then(
            ([ratio, states]) => {
                if (this.history?.key !== key) {
                    return;
                }
                this.history = {
                    key,
                    ratio: ratioSeries(ratio[visibility], this.hass?.states[visibility]),
                    nights: nightsSeen(ratio[visibility], this.hass?.states[visibility]),
                    clouds: clouds ? (ratio[clouds] ?? []) : [],
                    visibility: ratio[visibility] ?? [],
                    stations: Object.fromEntries(
                        stations.map((entity) => [entity, stateSeries(states[entity], this.hass?.states[entity])]),
                    ),
                };
            },
            (error: unknown) => {
                // Said once, as it is tried again at the next window or change of settings.
                if (!this.historyFailed) {
                    console.warn("aurora-finland-card: couldn't read the night's history", error);
                    this.historyFailed = true;
                }
            },
        );
    }

    /** Adds the sensors' new states to the history read, so the night keeps drawing without reading it again. */
    private followLive(): void {
        const history = this.history;
        if (!history || !this.hass || !this.config) {
            return;
        }
        const add = (points: Point[], value: number | undefined, updated: number | undefined) => {
            if (value !== undefined && updated !== undefined && (points.length === 0 || points[points.length - 1].at < updated)) {
                points.push({ at: updated, value });
            }
        };
        const visibility = this.hass.states[this.config.entity];
        const updated = time(visibility?.last_updated);
        add(history.ratio, number(visibility?.attributes.ratio), updated);
        const last = history.visibility[history.visibility.length - 1];
        if (visibility && updated !== undefined && (!last || last.lu * 1000 < updated)) {
            history.visibility.push({ s: visibility.state, a: visibility.attributes, lu: updated / 1000 });
        }
        for (const [entity, points] of Object.entries(history.stations)) {
            const station = this.hass.states[entity];
            add(points, number(station?.state), time(station?.last_updated));
        }
    }

    /** The height the parts need at the narrowest the card gets, from its settings alone. */
    private minimumHeight(): number {
        // Each part at its tallest, measured live at every width from 288 px up with the longest texts: the header's
        // lines wrap beside the sky on a narrow card, the three boxes go to two rows, and the timeline's legend to two
        // lines. The few pixels at the end are the only slack, so a part that grows shows up here.
        const gap = 12;
        const config = this.config;
        let height = 2 * PADDING + (shows(config, "show_sky") ? 100 : 91);
        if (shows(config, "show_map")) {
            height += gap + MAP_HEIGHT + (shows(config, "show_timeline") ? 0 : 36);
        } else if (shows(config, "show_tonight")) {
            height += gap + 140;
        }
        if (shows(config, "show_timeline")) {
            height += gap + (shows(config, "show_clouds") || shows(config, "show_kp") ? 151 : 116);
        }
        return height + 4;
    }

    private measureSoon(): void {
        cancelAnimationFrame(this.frame ?? 0);
        this.frame = requestAnimationFrame(() => this.fillRows());
    }

    /**
     * In a sections view whose rows are left automatic, the card takes the whole rows its content needs, or the half rows
     * with `row_step: half`, so the cards under it stay on the rows. The room left over is split above and below the
     * content, as the card has no title. A card held to a height that leaves less than a row over its content splits that
     * room the same way, and more goes under the content.
     */
    private fillRows(): void {
        const card = this.renderRoot.querySelector<HTMLElement>("ha-card");
        const content = card?.querySelector<HTMLElement>(":scope > .content");
        if (!card || !content || !card.clientWidth) {
            return;
        }
        const limit = fillLimit(this.config ?? {}, this.layout, this.minimumHeight());
        const held = !limit && Boolean(heightStyle(this.config ?? {}, this.layout, this.minimumHeight()));
        if (!limit && !held) {
            this.filled = 0;
            this.spare = 0;
            return;
        }
        const last = content.lastElementChild as HTMLElement | null;
        if (!last) {
            return;
        }
        // Drawn sizes are unscaled, as the padding and border added to them are the layout's.
        const scale = drawnScale(card);
        const style = getComputedStyle(content);
        const top = px(style.paddingTop) - PADDING;
        const needed =
            (last.getBoundingClientRect().bottom - card.getBoundingClientRect().top) / scale -
            top +
            PADDING +
            px(getComputedStyle(card).borderBottomWidth);
        if (held) {
            this.filled = 0;
            this.spare = heldSpare(card.getBoundingClientRect().height / scale, needed);
            return;
        }
        const filled = filledHeight(needed, this.config ?? {}, limit);
        this.filled = filled;
        this.spare = spareRoom(filled, needed);
    }

    private cardStyle(): string {
        const style = filledStyle(this.config ?? {}, this.layout, this.minimumHeight(), this.filled);
        return this.spare ? [style, `--spare: ${this.spare}px`].filter(Boolean).join("; ") : style;
    }

    private timeZone(): string | undefined {
        return this.hass?.locale?.time_zone === "server" ? this.hass.config?.time_zone : undefined;
    }

    /** A time of day in the viewer's language and clock. */
    private clock(at: number): string {
        return new Intl.DateTimeFormat(this.language(), {
            hour: "numeric",
            minute: "2-digit",
            ...this.cycle(),
            timeZone: this.timeZone(),
        }).format(at);
    }

    private hour(at: number): string {
        return new Intl.DateTimeFormat(this.language(), { hour: "numeric", ...this.cycle(), timeZone: this.timeZone() }).format(at);
    }

    /** The user's choice of clock in their profile. hourCycle rather than hour12: false, which some engines turn into 24.00. */
    private cycle(): { hour12?: boolean; hourCycle?: "h23" } {
        switch (this.hass?.locale?.time_format) {
            case "12":
                return { hour12: true };
            case "24":
                return { hourCycle: "h23" };
            case "system":
                return new Intl.DateTimeFormat(undefined, { hour: "numeric" }).resolvedOptions().hour12
                    ? { hour12: true }
                    : { hourCycle: "h23" };
            default:
                return {};
        }
    }

    /** A text in the viewer's language, with `{name}` in it replaced, so a translation can put the value where it reads right. */
    private text(key: string, values: Record<string, string> = {}): string {
        return translate(this.language(), key).replace(/\{(\w+)\}/g, (match, name: string) => values[name] ?? match);
    }

    private language(): string {
        return this.hass?.locale?.language ?? this.hass?.language ?? browserLanguage();
    }

    static get styles(): CSSResultGroup {
        return css`
            :host {
                --aurora-unlikely: var(--state-icon-color, #44739e);
                --aurora-possible: var(--amber-color, #ffc107);
                --aurora-likely: var(--green-color, #4caf50);
            }
            ha-card {
                position: relative;
                container-type: inline-size;
                transition: none;
                overflow: hidden;
            }
            /* Above the pointer, to its right, or to its left on the card's right half so it stays inside the card. */
            .tip {
                position: absolute;
                z-index: 1;
                transform: translate(10px, calc(-100% - 10px));
                padding: 4px 8px;
                border-radius: 4px;
                background: var(--card-background-color, #fff);
                box-shadow: 0 1px 6px rgba(0, 0, 0, 0.35);
                color: var(--primary-text-color);
                font-size: 12px;
                line-height: 1.4;
                white-space: nowrap;
                pointer-events: none;
                font-variant-numeric: tabular-nums;
            }
            .tip.left {
                transform: translate(calc(-100% - 10px), calc(-100% - 10px));
            }
            .now-chip {
                height: 22px;
                margin-left: 8px;
                padding: 0 10px;
                border: 1px solid var(--divider-color);
                border-radius: 11px;
                background: none;
                color: var(--primary-color);
                font: inherit;
                cursor: pointer;
            }
            .place-ring {
                fill: none;
                stroke: var(--primary-text-color);
                stroke-width: 1.5;
            }
            .place-dot {
                fill: var(--primary-text-color);
            }
            .content {
                display: flex;
                flex-direction: column;
                gap: 12px;
                padding: calc(${PADDING}px + var(--spare, 0px) / 2) ${PADDING}px;
            }
            .message {
                color: var(--secondary-text-color);
            }
            .header {
                display: flex;
                gap: 12px;
                align-items: flex-start;
            }
            .grow {
                flex: 1;
                min-width: 0;
            }
            .state {
                display: flex;
                align-items: center;
                gap: 12px;
            }
            .state-icon {
                --mdc-icon-size: 32px;
                flex: none;
            }
            .unlikely {
                color: var(--aurora-unlikely);
            }
            .possible {
                color: var(--aurora-possible);
            }
            .likely {
                color: var(--aurora-likely);
            }
            .state-text {
                min-width: 0;
            }
            .state-icon.none {
                color: var(--disabled-text-color);
            }
            .title {
                overflow: hidden;
                font-size: 12px;
                line-height: 16px;
                color: var(--secondary-text-color);
                white-space: nowrap;
                text-overflow: ellipsis;
            }
            .level {
                font-size: 19px;
                font-weight: 500;
                line-height: 1.3;
                /* "Epätodennäköistä" is wider than the room beside the sky on the card picker's narrow preview. */
                overflow-wrap: anywhere;
            }
            /* Below 340 px of card the longest state, "Epätodennäköistä", has no room beside the icon and the sky. The
               icon goes, as the sky shows the state's colour. */
            @container (max-width: 338px) {
                .header.with-sky .state-icon {
                    display: none;
                }
                .header.with-sky .level {
                    font-size: 17px;
                }
            }
            .where {
                font-size: 13px;
                color: var(--secondary-text-color);
            }
            .dark {
                margin-top: 6px;
                font-size: 12px;
                color: var(--secondary-text-color);
                opacity: 0.8;
            }
            svg text {
                font-family: inherit;
                font-size: 10px;
                fill: var(--secondary-text-color);
            }
            .sky {
                flex: none;
                display: block;
            }
            .sky .dome {
                fill: color-mix(in srgb, var(--primary-background-color) 70%, black);
                stroke: var(--divider-color);
            }
            .sky .ring {
                fill: none;
                stroke: var(--divider-color);
                stroke-dasharray: 2 3;
            }
            .sky .zenith {
                fill: var(--secondary-text-color);
            }
            .sky text {
                text-anchor: middle;
            }
            .sky text.north {
                fill: var(--primary-text-color);
                font-weight: 500;
            }
            .sky .aurora {
                fill: none;
                stroke: currentColor;
                stroke-width: 7;
                stroke-linecap: round;
                opacity: 0.85;
            }
            .sky .overhead {
                fill: currentColor;
            }
            .boxes {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(100px, 1fr));
                gap: 8px;
            }
            .box {
                background: color-mix(in srgb, var(--primary-text-color) 4%, transparent);
                border-radius: 4px;
                padding: 6px 8px;
            }
            .box .key,
            .box .detail {
                font-size: 11.5px;
                color: var(--secondary-text-color);
            }
            .box .value {
                font-size: 16px;
                font-weight: 500;
            }
            .map-row {
                display: flex;
                gap: 12px;
                align-items: center;
            }
            .map-row.alone {
                justify-content: center;
            }
            .map {
                flex: none;
                display: block;
            }
            .map .land {
                fill: color-mix(in srgb, var(--primary-text-color) 12%, transparent);
                stroke: color-mix(in srgb, var(--primary-text-color) 25%, transparent);
            }
            .map .dot {
                fill: var(--aurora-unlikely);
            }
            .map .dot.possible {
                fill: var(--aurora-possible);
            }
            .map .dot.likely {
                fill: var(--aurora-likely);
            }
            .map .dot.none {
                fill: var(--disabled-text-color, #888);
            }
            .map .code {
                font-size: 9px;
            }
            .list {
                flex: 1;
                min-width: 0;
                font-size: 13px;
            }
            .list .row {
                display: flex;
                justify-content: space-between;
                gap: 8px;
                padding: 3px 0;
            }
            .list .row span:first-child {
                color: var(--secondary-text-color);
            }
            .list .row span:last-child {
                text-align: end;
            }
            .scrub {
                display: flex;
                align-items: center;
                gap: 4px;
                margin-top: 6px;
            }
            .scrub input {
                flex: 1;
                min-width: 0;
                accent-color: var(--state-icon-color);
            }
            .scrub .at {
                font-size: 12px;
                font-variant-numeric: tabular-nums;
                color: var(--secondary-text-color);
                min-width: 40px;
                text-align: end;
            }
            .head {
                display: flex;
                justify-content: space-between;
                align-items: center;
                gap: 8px;
                min-height: 24px;
                font-size: 12px;
                color: var(--secondary-text-color);
            }
            .head-right {
                display: flex;
                align-items: center;
                font-variant-numeric: tabular-nums;
            }
            /* HA renamed the button's size variable when it left mwc. Both are set, so older versions keep the size too. */
            .play {
                --ha-icon-button-size: 32px;
                --mdc-icon-button-size: 32px;
                --mdc-icon-size: 22px;
                color: var(--state-icon-color);
                margin: -4px -6px -4px 0;
            }
            .timeline {
                display: block;
                touch-action: pan-y;
                cursor: crosshair;
            }
            /* A shade darker than the card in a dark theme, and a faint grey in a light one, where black would swamp it. */
            .timeline .night {
                fill: var(--primary-text-color);
                opacity: 0.06;
            }
            .dark-theme .timeline .night {
                fill: color-mix(in srgb, var(--primary-background-color) 55%, black);
                opacity: 0.6;
            }
            .timeline .cloud {
                fill: var(--primary-text-color);
                opacity: 0.22;
            }
            .timeline .cloud.past {
                opacity: 0.1;
            }
            .timeline .kp {
                fill: var(--aurora-possible);
            }
            .timeline .kp-label {
                fill: var(--aurora-possible);
                text-anchor: middle;
            }
            .timeline .limit {
                stroke: var(--aurora-likely);
                stroke-dasharray: 3 3;
                opacity: 0.7;
            }
            .timeline .axis.end {
                text-anchor: end;
            }
            .timeline .axis.middle {
                text-anchor: middle;
            }
            .timeline .area {
                fill: var(--aurora-likely);
                opacity: 0.16;
            }
            .timeline .activity {
                fill: none;
                stroke: var(--aurora-likely);
                stroke-width: 1.6;
            }
            .timeline .now {
                stroke: var(--secondary-text-color);
                opacity: 0.5;
            }
            .timeline .hover {
                stroke: var(--secondary-text-color);
                stroke-dasharray: 2 2;
            }
            .timeline .cursor {
                stroke: var(--state-icon-color);
                stroke-width: 1.5;
            }
            .timeline .cursor-dot {
                fill: var(--state-icon-color);
            }
            .legend {
                display: flex;
                flex-wrap: wrap;
                justify-content: center;
                gap: 2px 10px;
                margin-top: 3px;
                font-size: 11px;
                color: var(--secondary-text-color);
            }
            .swatch {
                display: inline-block;
                width: 10px;
                height: 3px;
                margin-right: 4px;
                vertical-align: middle;
            }
            .swatch.activity {
                background: var(--aurora-likely);
            }
            .swatch.limit {
                width: 12px;
                background: repeating-linear-gradient(90deg, var(--aurora-likely) 0 3px, transparent 3px 6px);
                opacity: 0.7;
            }
            .swatch.cloud {
                width: 8px;
                height: 8px;
                background: var(--primary-text-color);
                opacity: 0.4;
            }
            .swatch.kp {
                background: var(--aurora-possible);
            }
        `;
    }
}

/** The colour class of an activity against the lower limit: at the limit, more likely than not, and from 0.6 a chance. */
function ratioClass(ratio: number): string {
    return ratio >= 1 ? "likely" : ratio >= 0.6 ? "possible" : "unlikely";
}

function px(value: string): number {
    return Number.parseFloat(value) || 0;
}

interface CardRegistration {
    type: string;
    name: string;
    description: string;
    documentationURL?: string;
    preview?: boolean;
}

if (!customElements.get("aurora-finland-card")) {
    console.info(
        `%c  AURORA-FINLAND-CARD \n%c  ${CARD_VERSION}    `,
        "color: lightgreen; font-weight: bold; background: black",
        "color: white; font-weight: bold; background: dimgray",
    );

    const registry = window as unknown as { customCards?: CardRegistration[] };
    registry.customCards = registry.customCards ?? [];
    registry.customCards.push({
        type: "aurora-finland-card",
        name: translate(browserLanguage(), "common.name"),
        description: translate(browserLanguage(), "common.description"),
        documentationURL: "https://github.com/jesmak/aurora_finland#card",
        preview: true,
    });
    customElements.define("aurora-finland-card", AuroraFinlandCard);
}

declare global {
    interface HTMLElementTagNameMap {
        "aurora-finland-card": AuroraFinlandCard;
    }
}
