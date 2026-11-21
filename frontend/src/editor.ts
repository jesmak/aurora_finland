/** The card's visual editor: the visibility sensor, the parts shown and the height's rounding. */
import { LitElement, html, nothing } from "lit";
import type { TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";

import { visibilitySensors } from "./aurora";
import type { HomeAssistant } from "./hass";
import { browserLanguage, translate } from "./localize/localize";
import { rowStepData, rowStepSchema, tidyRowStep } from "./rows";
import { DEFAULTS, shows } from "./types";
import type { AuroraCardConfig } from "./types";

interface SchemaEntry {
    name: string;
}

function schema(hass: HomeAssistant, config: AuroraCardConfig, text: (key: string) => string) {
    const timeline = shows(config, "show_timeline");
    return [
        { name: "entity", required: true, selector: { entity: { include_entities: visibilitySensors(hass) } } },
        { name: "show_sky", selector: { boolean: {} } },
        { name: "show_tonight", selector: { boolean: {} } },
        { name: "show_map", selector: { boolean: {} } },
        { name: "show_timeline", selector: { boolean: {} } },
        ...(timeline
            ? [
                  { name: "show_clouds", selector: { boolean: {} } },
                  { name: "show_kp", selector: { boolean: {} } },
              ]
            : []),
        ...rowStepSchema(config, text),
    ];
}

export class AuroraFinlandCardEditor extends LitElement {
    @property({ attribute: false }) public hass?: HomeAssistant;
    @state() private config: AuroraCardConfig = { type: "custom:aurora-finland-card", entity: "" };

    public setConfig(config: AuroraCardConfig): void {
        this.config = { ...config };
    }

    protected render(): TemplateResult | typeof nothing {
        if (!this.hass) {
            return nothing;
        }
        return html`
            <ha-form
                .hass=${this.hass}
                .data=${{ ...DEFAULTS, ...rowStepData(this.config) }}
                .schema=${schema(this.hass, this.config, (key) => this.text(key))}
                .computeLabel=${(entry: SchemaEntry) => this.text(`editor.${entry.name}`)}
                .computeHelper=${(entry: SchemaEntry) => this.helper(entry.name)}
                @value-changed=${this.valueChanged}
            ></ha-form>
        `;
    }

    private valueChanged(event: CustomEvent<{ value: AuroraCardConfig }>): void {
        const config: AuroraCardConfig = tidyRowStep(event.detail.value);
        // The defaults are shown in the form but left out of the configuration.
        for (const [key, value] of Object.entries(DEFAULTS)) {
            if (config[key] === value || config[key] === undefined || config[key] === null) {
                delete config[key];
            }
        }
        this.dispatchEvent(new CustomEvent("config-changed", { detail: { config }, bubbles: true, composed: true }));
    }

    private text(key: string): string {
        return translate(this.language(), key);
    }

    private helper(name: string): string | undefined {
        const key = `editor.${name}_helper`;
        const helper = translate(this.language(), key);
        return helper === key ? undefined : helper;
    }

    private language(): string {
        return this.hass?.locale?.language ?? this.hass?.language ?? browserLanguage();
    }
}

if (!customElements.get("aurora-finland-card-editor")) {
    customElements.define("aurora-finland-card-editor", AuroraFinlandCardEditor);
}

declare global {
    interface HTMLElementTagNameMap {
        "aurora-finland-card-editor": AuroraFinlandCardEditor;
    }
}
