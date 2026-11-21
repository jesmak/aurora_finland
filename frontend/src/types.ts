import type { LovelaceCardConfig } from "./hass";
import type { RowStepConfig } from "./rows";

export interface AuroraCardConfig extends LovelaceCardConfig, RowStepConfig {
    /** The place's visibility sensor, through which the card finds the place's other sensors. */
    entity: string;
    show_sky?: boolean;
    show_tonight?: boolean;
    show_map?: boolean;
    show_timeline?: boolean;
    /** Tonight's cloud cover on the timeline. */
    show_clouds?: boolean;
    /** Kp's peak on the timeline. */
    show_kp?: boolean;
}

/** Every part but the map is on unless switched off. */
export const DEFAULTS = {
    show_sky: true,
    show_tonight: true,
    show_map: false,
    show_timeline: true,
    show_clouds: true,
    show_kp: true,
} as const;

export type Part = keyof typeof DEFAULTS;

export function shows(config: AuroraCardConfig | undefined, part: Part): boolean {
    const value = config?.[part];
    return typeof value === "boolean" ? value : DEFAULTS[part];
}
