import {
	action,
	DidReceiveSettingsEvent,
	KeyAction,
	KeyDownEvent,
	PropertyInspectorDidAppearEvent,
	SendToPluginEvent,
	SingletonAction,
	WillAppearEvent,
	WillDisappearEvent,
} from "@elgato/streamdeck";
import streamDeck from "@elgato/streamdeck";
import type { JsonValue } from "@elgato/utils";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SIDECAR_EXE_NAME = "AfterburnerReader.exe";
const SVG_SIZE = 144;
const CARD_RADIUS = 18;

@action({ UUID: "com.lee-cleobury.afterburner-display.increment" })
export class IncrementCounter extends SingletonAction<DisplaySettings> {
	private readonly settingsByActionId = new Map<string, NormalizedDisplaySettings>();
	private readonly historyByActionId = new Map<string, number[]>();
	private pollTimer: NodeJS.Timeout | undefined;
	private sidecarBootPromise: Promise<void> | undefined;

	override async onWillAppear(ev: WillAppearEvent<DisplaySettings>): Promise<void> {
		const settings = normalizeSettings(ev.payload.settings);
		this.settingsByActionId.set(ev.action.id, settings);
		void this.ensureSidecarRunningIfNeeded(settings.endpointUrl);

		if (JSON.stringify(ev.payload.settings) !== JSON.stringify(settings)) {
			await ev.action.setSettings(settings);
		}

		await ev.action.setTitle("");
		await ev.action.setImage(renderStatusCard("Connecting", "Loading", "#8be9fd"));
		this.ensurePolling();
	}

	override onWillDisappear(ev: WillDisappearEvent<DisplaySettings>): void {
		this.settingsByActionId.delete(ev.action.id);
		this.historyByActionId.delete(ev.action.id);
		if (this.settingsByActionId.size === 0 && this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = undefined;
		}
	}

	override onDidReceiveSettings(ev: DidReceiveSettingsEvent<DisplaySettings>): void {
		this.settingsByActionId.set(ev.action.id, normalizeSettings(ev.payload.settings));
		this.ensurePolling();
	}

	override onPropertyInspectorDidAppear(ev: PropertyInspectorDidAppearEvent<DisplaySettings>): void {
		const settings = this.settingsByActionId.get(ev.action.id) ?? DEFAULT_SETTINGS;
		void this.sendMetricsListToInspector(settings.endpointUrl);
	}

	override onSendToPlugin(ev: SendToPluginEvent<JsonValue, DisplaySettings>): void {
		if (!isRequestMetricsPayload(ev.payload)) {
			return;
		}

		void this.sendMetricsListToInspector(ev.payload.endpointUrl ?? DEFAULT_SETTINGS.endpointUrl);
	}

	override async onKeyDown(ev: KeyDownEvent<DisplaySettings>): Promise<void> {
		await this.pollAndRender();
		await ev.action.showOk();
	}

	private ensurePolling(): void {
		if (this.settingsByActionId.size === 0) {
			return;
		}

		const fastestRefreshMs = Math.min(...Array.from(this.settingsByActionId.values()).map((settings) => settings.refreshMs));

		if (this.pollTimer) {
			clearInterval(this.pollTimer);
		}

		this.pollTimer = setInterval(() => {
			void this.pollAndRender();
		}, fastestRefreshMs);

		void this.pollAndRender();
	}

	private async pollAndRender(): Promise<void> {
		const actions = Array.from(this.actions).filter((action): action is KeyAction<DisplaySettings> => action.isKey());
		if (actions.length === 0) {
			return;
		}

		const groups = new Map<string, KeyAction<DisplaySettings>[]>();
		for (const action of actions) {
			const settings = this.settingsByActionId.get(action.id) ?? normalizeSettings({});
			const list = groups.get(settings.endpointUrl) ?? [];
			list.push(action);
			groups.set(settings.endpointUrl, list);
		}

		for (const [endpointUrl, endpointActions] of groups.entries()) {
			try {
				const metrics = await this.fetchMetricsWithBootstrap(endpointUrl);
				await Promise.all(endpointActions.map(async (action) => {
					const settings = this.settingsByActionId.get(action.id) ?? normalizeSettings({ endpointUrl });
					await this.renderMetricForAction(action, settings, metrics);
				}));
			} catch (error) {
				const message = error instanceof Error ? error.message : "No data";
				await Promise.all(endpointActions.map(async (action) => {
					const settings = this.settingsByActionId.get(action.id) ?? normalizeSettings({ endpointUrl });
					const label = settings.label || shortMetricLabel(settings.metricKey);
					await action.setTitle("");
					await action.setImage(renderStatusCard(label, "ERR", "#ff6b6b", message));
				}));
			}
		}
	}

	private async renderMetricForAction(action: KeyAction<DisplaySettings>, settings: NormalizedDisplaySettings, metrics: Record<string, number | string | boolean | null>): Promise<void> {
		const label = settings.label || shortMetricLabel(settings.metricKey);
		const rawValue = metrics[settings.metricKey];

		if (rawValue === undefined || rawValue === null) {
			await action.setTitle("");
			await action.setImage(renderStatusCard(label, "N/A", "#f2c94c"));
			return;
		}

		if (typeof rawValue !== "number") {
			await action.setTitle("");
			await action.setImage(renderStatusCard(label, String(rawValue), "#8be9fd"));
			return;
		}

		const history = this.pushHistory(action.id, rawValue, settings.lineSamples);
		const image = renderMetricCard(settings, settings.metricKey, label, rawValue, history);
		await action.setTitle("");
		await action.setImage(image);
	}

	private pushHistory(actionId: string, value: number, maxSamples: number): number[] {
		const nextHistory = [...(this.historyByActionId.get(actionId) ?? []), value].slice(-maxSamples);
		this.historyByActionId.set(actionId, nextHistory);
		return nextHistory;
	}

	private async sendMetricsListToInspector(endpointUrl: string): Promise<void> {
		const payload: MetricsListToInspector = { type: "metrics-list", endpointUrl, keys: [] };
		try {
			const metrics = await this.fetchMetricsWithBootstrap(endpointUrl);
			payload.keys = Object.keys(metrics).sort((left, right) => left.localeCompare(right));
		} catch (error) {
			payload.error = error instanceof Error ? error.message : "Unable to load metrics";
		}
		await streamDeck.ui.sendToPropertyInspector(payload);
	}

	private async fetchMetricsWithBootstrap(endpointUrl: string): Promise<Record<string, number | string | boolean | null>> {
		const normalizedEndpointUrl = normalizeEndpointUrl(endpointUrl);
		try {
			return await fetchMetrics(normalizedEndpointUrl);
		} catch (error) {
			if (!shouldAttemptSidecarBoot(normalizedEndpointUrl)) {
				throw error;
			}
			await this.ensureSidecarRunningIfNeeded(normalizedEndpointUrl);
			await delay(5000);
			return fetchMetrics(normalizedEndpointUrl);
		}
	}

	private async ensureSidecarRunningIfNeeded(endpointUrl: string): Promise<void> {
		if (process.platform !== "win32" || !shouldAttemptSidecarBoot(endpointUrl)) {
			return;
		}
		if (this.sidecarBootPromise) {
			await this.sidecarBootPromise;
			return;
		}
		this.sidecarBootPromise = this.ensureSidecarRunningInternal();
		try {
			await this.sidecarBootPromise;
		} finally {
			this.sidecarBootPromise = undefined;
		}
	}

	private async ensureSidecarRunningInternal(): Promise<void> {
		if (await isAfterburnerReaderRunning()) {
			return;
		}
		const exePath = await resolveAfterburnerReaderPath();
		if (!exePath) {
			streamDeck.logger.error("AfterburnerReader.exe not found in plugin output folder.");
			return;
		}
		try {
			const child = spawn(exePath, [], { detached: true, stdio: "ignore", windowsHide: true });
			child.unref();
		} catch (error) {
			streamDeck.logger.error(`Failed to start AfterburnerReader.exe: ${String(error)}`);
		}
	}
}

type DisplaySettings = {
	endpointUrl?: string;
	metricKey?: string;
	label?: string;
	hideLabel?: boolean;
	labelX?: number;
	labelY?: number;
	labelSize?: number;
	labelStrokeColor?: string;
	labelStrokeWidth?: number;
	valueX?: number;
	valueY?: number;
	valueSize?: number;
	valueStrokeColor?: string;
	valueStrokeWidth?: number;
	suffixMode?: SuffixMode;
	useCustomScale?: boolean;
	scaleMin?: number;
	scaleMax?: number;
	decimals?: number;
	refreshMs?: number;
	viewStyle?: ViewStyle;
	fontSize?: number;
	fontFamily?: string;
	lineSamples?: number;
	theme?: Theme;
	customBg0?: string;
	customBg1?: string;
	customBorderColor?: string;
	customLabelColor?: string;
	customValueColor?: string;
	customAccentColor?: string;
	customTrackColor?: string;
};

type Theme = "default" | "neon" | "minimal" | "retro" | "custom";

type ViewStyle = "value" | "line" | "line-filled" | "gauge";

type SuffixMode = "off" | "inline" | "below";

type NormalizedDisplaySettings = Required<DisplaySettings>;

type SidecarPayload = {
	status?: string;
	metrics?: Record<string, number | string | boolean | null>;
	error?: string | null;
};

type RequestMetricsPayload = {
	type: "request-metrics-list";
	endpointUrl?: string;
};

type MetricsListToInspector = {
	type: "metrics-list";
	endpointUrl: string;
	keys: string[];
	error?: string;
};

const DEFAULT_SETTINGS: NormalizedDisplaySettings = {
	endpointUrl: "http://localhost:9696/metrics",
	metricKey: "gpu1_temperature",
	label: "GPU1 Temp",
	hideLabel: false,
	labelX: 72,
	labelY: 34,
	labelSize: 14,
	labelStrokeColor: "#000000",
	labelStrokeWidth: 0,
	valueX: 72,
	valueY: 86,
	valueSize: 48,
	valueStrokeColor: "#000000",
	valueStrokeWidth: 0,
	suffixMode: "inline",
	useCustomScale: false,
	scaleMin: 0,
	scaleMax: 100,
	decimals: 0,
	refreshMs: 1000,
	viewStyle: "value",
	fontSize: 48,
	fontFamily: "Segoe UI",
	lineSamples: 30,
	theme: "default",
	customBg0: "#0f172a",
	customBg1: "#1e293b",
	customBorderColor: "#ffffff20",
	customLabelColor: "#cbd5e1",
	customValueColor: "#f8fafc",
	customAccentColor: "#22d3ee",
	customTrackColor: "#334155",
};

function normalizeSettings(input: DisplaySettings): NormalizedDisplaySettings {
	const normalizedValueSize = clampInt(input.valueSize ?? input.fontSize, 24, 72, DEFAULT_SETTINGS.valueSize);
	return {
		endpointUrl: normalizeEndpointUrl(input.endpointUrl),
		metricKey: input.metricKey?.trim() || DEFAULT_SETTINGS.metricKey,
		label: input.label !== undefined ? input.label.trim() : DEFAULT_SETTINGS.label,
		hideLabel: input.hideLabel === true,
		labelX: clampInt(input.labelX, 8, 128, DEFAULT_SETTINGS.labelX),
		labelY: clampInt(input.labelY, 12, 132, DEFAULT_SETTINGS.labelY),
		labelSize: clampInt(input.labelSize, 10, 24, DEFAULT_SETTINGS.labelSize),
		labelStrokeColor: normalizeColor(input.labelStrokeColor, DEFAULT_SETTINGS.labelStrokeColor),
		labelStrokeWidth: clampNumber(input.labelStrokeWidth, 0, 6, DEFAULT_SETTINGS.labelStrokeWidth),
		valueX: clampInt(input.valueX, 8, 128, DEFAULT_SETTINGS.valueX),
		valueY: clampInt(input.valueY, 24, 132, DEFAULT_SETTINGS.valueY),
		valueSize: normalizedValueSize,
		valueStrokeColor: normalizeColor(input.valueStrokeColor, DEFAULT_SETTINGS.valueStrokeColor),
		valueStrokeWidth: clampNumber(input.valueStrokeWidth, 0, 6, DEFAULT_SETTINGS.valueStrokeWidth),
		suffixMode: normalizeSuffixMode(input.suffixMode),
		useCustomScale: input.useCustomScale === true,
		scaleMin: clampNumber(input.scaleMin, -100000, 100000, DEFAULT_SETTINGS.scaleMin),
		scaleMax: clampNumber(input.scaleMax, -100000, 100000, DEFAULT_SETTINGS.scaleMax),
		decimals: clampInt(input.decimals, 0, 3, DEFAULT_SETTINGS.decimals),
		refreshMs: clampInt(input.refreshMs, 500, 5000, DEFAULT_SETTINGS.refreshMs),
		viewStyle: normalizeViewStyle(input.viewStyle),
		fontSize: normalizedValueSize,
		fontFamily: input.fontFamily?.trim() || DEFAULT_SETTINGS.fontFamily,
		lineSamples: clampInt(input.lineSamples, 10, 60, DEFAULT_SETTINGS.lineSamples),
		theme: normalizeTheme(input.theme),
		customBg0: normalizeColor(input.customBg0, DEFAULT_SETTINGS.customBg0),
		customBg1: normalizeColor(input.customBg1, DEFAULT_SETTINGS.customBg1),
		customBorderColor: normalizeColor(input.customBorderColor, DEFAULT_SETTINGS.customBorderColor),
		customLabelColor: normalizeColor(input.customLabelColor, DEFAULT_SETTINGS.customLabelColor),
		customValueColor: normalizeColor(input.customValueColor, DEFAULT_SETTINGS.customValueColor),
		customAccentColor: normalizeColor(input.customAccentColor, DEFAULT_SETTINGS.customAccentColor),
		customTrackColor: normalizeColor(input.customTrackColor, DEFAULT_SETTINGS.customTrackColor),
	};
}

function normalizeTheme(value: string | undefined): Theme {
	if (value === "neon" || value === "minimal" || value === "retro" || value === "custom") {
		return value;
	}
	return "default";
}

function normalizeSuffixMode(value: string | undefined): SuffixMode {
	if (value === "off" || value === "below") {
		return value;
	}
	return "inline";
}

function normalizeColor(value: string | undefined, fallback: string): string {
	const trimmed = value?.trim();
	if (!trimmed) {
		return fallback;
	}
	return trimmed;
}

type ThemePalette = {
	bg0: string;
	bg1: string;
	borderColor: string;
	labelColor: string;
	valueColor: string;
	trackColor: string;
	fontFamily: string;
};

function themeFor(settings: NormalizedDisplaySettings): ThemePalette {
	switch (settings.theme) {
		case "neon":
			return {
				bg0: "#04030d",
				bg1: "#0d0d2b",
				borderColor: "#00ff9930",
				labelColor: "#6e6e9e",
				valueColor: "#e0e0ff",
				trackColor: "#1a1a3a",
				fontFamily: settings.fontFamily === "Segoe UI" ? "Consolas, Courier New" : settings.fontFamily,
			};
		case "minimal":
			return {
				bg0: "#000000",
				bg1: "#000000",
				borderColor: "#ffffff08",
				labelColor: "#71717a",
				valueColor: "#ffffff",
				trackColor: "#27272a",
				fontFamily: settings.fontFamily,
			};
		case "retro":
			return {
				bg0: "#000800",
				bg1: "#001200",
				borderColor: "#00cc0030",
				labelColor: "#007700",
				valueColor: "#00ee00",
				trackColor: "#002200",
				fontFamily: settings.fontFamily === "Segoe UI" ? "Courier New" : settings.fontFamily,
			};
		case "custom":
			return {
				bg0: settings.customBg0,
				bg1: settings.customBg1,
				borderColor: settings.customBorderColor,
				labelColor: settings.customLabelColor,
				valueColor: settings.customValueColor,
				trackColor: settings.customTrackColor,
				fontFamily: settings.fontFamily,
			};
		default:
			return {
				bg0: "#0f172a",
				bg1: "#1e293b",
				borderColor: "#ffffff20",
				labelColor: "#cbd5e1",
				valueColor: "#f8fafc",
				trackColor: "#334155",
				fontFamily: settings.fontFamily,
			};
	}
}

function themeAccentColor(settings: NormalizedDisplaySettings, metricKey: string): string {
	if (settings.theme === "custom") {
		return settings.customAccentColor;
	}
	if (settings.theme === "retro") {
		return "#00cc00";
	}
	if (settings.theme === "minimal") {
		return "#a1a1aa";
	}
	if (settings.theme === "neon") {
		if (metricKey.includes("temperature")) return "#ff6ec7";
		if (metricKey.includes("power")) return "#00ff99";
		if (metricKey.includes("clock")) return "#7b5ea7";
		if (metricKey.includes("fan")) return "#00d4ff";
		return "#00e5ff";
	}
	return accentColor(metricKey);
}

function normalizeViewStyle(value: string | undefined): ViewStyle {
	if (value === "line" || value === "line-filled" || value === "gauge") {
		return value;
	}
	return "value";
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
	if (typeof value !== "number" || Number.isNaN(value)) {
		return fallback;
	}
	return Math.min(max, Math.max(min, Math.round(value)));
}

function clampNumber(value: number | undefined, min: number, max: number, fallback: number): number {
	if (typeof value !== "number" || Number.isNaN(value)) {
		return fallback;
	}
	return Math.min(max, Math.max(min, value));
}

async function fetchMetrics(endpointUrl: string): Promise<Record<string, number | string | boolean | null>> {
	const response = await fetch(endpointUrl, { headers: { accept: "application/json" } });
	if (!response.ok) {
		throw new Error(`HTTP ${response.status}`);
	}
	const payload = (await response.json()) as SidecarPayload;
	if (payload.status && payload.status !== "ok") {
		throw new Error(payload.error || "Sidecar reported non-ok status");
	}
	if (!payload.metrics || typeof payload.metrics !== "object") {
		throw new Error("No metrics field in payload");
	}
	return payload.metrics;
}

function shortMetricLabel(metricKey: string): string {
	if (metricKey === "gpu1_temperature") {
		return "GPU1 Temp";
	}
	if (metricKey === "gpu2_temperature") {
		return "GPU2 Temp";
	}
	if (metricKey === "cpu_temperature") {
		return "CPU Temp";
	}
	return metricKey;
}

function inferUnit(metricKey: string): string {
	if (metricKey.includes("temperature")) {
		return "C";
	}
	if (metricKey.includes("usage") || metricKey.includes("percent")) {
		return "%";
	}
	if (metricKey.includes("clock")) {
		return " MHz";
	}
	if (metricKey.includes("power") && !metricKey.includes("percent")) {
		return " W";
	}
	if (metricKey.includes("fan_tachometer")) {
		return " RPM";
	}
	if (metricKey.includes("memory_usage") || metricKey === "commit_charge") {
		return " MB";
	}
	if (metricKey.includes("frametime")) {
		return " ms";
	}
	if (metricKey.includes("framerate")) {
		return " FPS";
	}
	return "";
}

function formatMetricValue(value: number, decimals: number): string {
	if (!Number.isFinite(value)) {
		return "0";
	}
	if (Math.abs(value) >= 1000) {
		const formatted = value.toFixed(0);
		return isReasonableFormattedValue(formatted) ? formatted : "0";
	}
	const formatted = value.toFixed(decimals);
	return isReasonableFormattedValue(formatted) ? formatted : "0";
}

function isReasonableFormattedValue(valueText: string): boolean {
	if (!valueText) {
		return false;
	}
	// Exponential notation or non-numeric output should not be rendered on the key.
	if (/[eE]/.test(valueText)) {
		return false;
	}
	const parsed = Number(valueText);
	return Number.isFinite(parsed);
}

function renderMetricCard(settings: NormalizedDisplaySettings, metricKey: string, label: string, value: number, history: number[]): string {
	if (settings.viewStyle === "line" || settings.viewStyle === "line-filled") {
		return renderLineChartCard(settings, metricKey, label, value, history, settings.viewStyle === "line-filled");
	}
	if (settings.viewStyle === "gauge") {
		return renderGaugeCard(settings, metricKey, label, value, history);
	}
	return renderValueCard(settings, metricKey, label, value);
}

function renderValueCard(settings: NormalizedDisplaySettings, metricKey: string, label: string, value: number): string {
	const unit = inferUnit(metricKey).trim();
	const valueText = formatMetricValue(value, settings.decimals);
	const accent = themeAccentColor(settings, metricKey);
	const palette = themeFor(settings);
	const safeLabel = escapeXml(label);
	const safeValue = escapeXml(valueText);
	const safeUnit = escapeXml(unit);
	const safeFont = escapeXml(palette.fontFamily);
	const unitY = Math.min(136, settings.valueY + 22);
	const labelStrokeAttrs = textStrokeAttrs(settings.labelStrokeColor, settings.labelStrokeWidth);
	const valueStrokeAttrs = textStrokeAttrs(settings.valueStrokeColor, settings.valueStrokeWidth);
	const labelEl = (!settings.hideLabel && safeLabel)
		? `<text x="${settings.labelX}" y="${settings.labelY}" text-anchor="middle" fill="${palette.labelColor}" font-family="${safeFont}" font-size="${settings.labelSize}" font-weight="600"${labelStrokeAttrs}>${safeLabel}</text>`
		: "";
	const neonGlow = settings.theme === "neon" ? `<filter id="glow"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>` : "";
	const glowAttr = settings.theme === "neon" ? ` filter="url(#glow)"` : "";
	const valueTextWithSuffix = suffixTextWithMode(settings.suffixMode, safeValue, safeUnit, accent, settings.valueSize);
	const belowSuffixEl = suffixBelowElement(settings.suffixMode, safeUnit, settings.valueX, unitY, accent, safeFont, 16, glowAttr);
	return svgToDataUri(`<svg xmlns="http://www.w3.org/2000/svg" width="${SVG_SIZE}" height="${SVG_SIZE}" viewBox="0 0 ${SVG_SIZE} ${SVG_SIZE}"><defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="${palette.bg0}"/><stop offset="100%" stop-color="${palette.bg1}"/></linearGradient>${neonGlow}</defs><rect x="2" y="2" width="140" height="140" rx="${CARD_RADIUS}" fill="url(#bg)"/><rect x="8" y="8" width="128" height="128" rx="${CARD_RADIUS - 4}" fill="none" stroke="${palette.borderColor}"/>${labelEl}<text x="${settings.valueX}" y="${settings.valueY}" text-anchor="middle" fill="${palette.valueColor}" font-family="${safeFont}" font-size="${settings.valueSize}" font-weight="700"${valueStrokeAttrs}${glowAttr}>${valueTextWithSuffix}</text>${belowSuffixEl}</svg>`);
}

function renderLineChartCard(settings: NormalizedDisplaySettings, metricKey: string, label: string, value: number, history: number[], filled: boolean): string {
	const accent = themeAccentColor(settings, metricKey);
	const palette = themeFor(settings);
	const unit = inferUnit(metricKey).trim();
	const safeLabel = escapeXml(label);
	const safeValue = escapeXml(formatMetricValue(value, settings.decimals));
	const safeUnit = escapeXml(unit);
	const safeFont = escapeXml(palette.fontFamily);
	const unitY = Math.min(136, settings.valueY + 22);
	const labelStrokeAttrs = textStrokeAttrs(settings.labelStrokeColor, settings.labelStrokeWidth);
	const valueStrokeAttrs = textStrokeAttrs(settings.valueStrokeColor, settings.valueStrokeWidth);
	const valueTextWithSuffix = suffixTextWithMode(settings.suffixMode, safeValue, safeUnit, accent, settings.valueSize);
	const belowSuffixEl = suffixBelowElement(settings.suffixMode, safeUnit, settings.valueX, unitY, accent, safeFont, 14);
	const lineLabelEl = (!settings.hideLabel && safeLabel)
		? `<text x="${settings.labelX}" y="${settings.labelY}" text-anchor="middle" fill="${palette.labelColor}" font-family="${safeFont}" font-size="${settings.labelSize}" font-weight="600"${labelStrokeAttrs}>${safeLabel}</text>`
		: "";
	const chartLeft = 12;
	const chartTop = 16;
	const chartWidth = 120;
	const chartHeight = 112;
	const values = history.length > 1 ? history : [value, value];
	const autoMin = Math.min(...values);
	const autoMax = Math.max(...values);
	const { min, max } = resolveScaleRange(settings, autoMin, autoMax);
	const span = Math.max(1, max - min);
	const points = values.map((point, index) => {
		const x = chartLeft + (index / Math.max(1, values.length - 1)) * chartWidth;
		const normalized = Math.max(0, Math.min(1, (point - min) / span));
		const y = chartTop + chartHeight - normalized * chartHeight;
		return { x, y };
	});
	const linePath = points.map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(" ");
	const areaPath = `M${points[0].x.toFixed(2)},${(chartTop + chartHeight).toFixed(2)} ${linePath.replaceAll("M", "L")} L${points[points.length - 1].x.toFixed(2)},${(chartTop + chartHeight).toFixed(2)} Z`;
	return svgToDataUri(`<svg xmlns="http://www.w3.org/2000/svg" width="${SVG_SIZE}" height="${SVG_SIZE}" viewBox="0 0 ${SVG_SIZE} ${SVG_SIZE}"><defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="${palette.bg0}"/><stop offset="100%" stop-color="${palette.bg1}"/></linearGradient><linearGradient id="fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${accent}" stop-opacity="0.45"/><stop offset="100%" stop-color="${accent}" stop-opacity="0.02"/></linearGradient></defs><rect x="2" y="2" width="140" height="140" rx="${CARD_RADIUS}" fill="url(#bg)"/><rect x="8" y="8" width="128" height="128" rx="${CARD_RADIUS - 4}" fill="none" stroke="${palette.borderColor}"/>${filled ? `<path d="${areaPath}" fill="url(#fill)"/>` : ""}<path d="${linePath}" fill="none" stroke="${accent}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>${lineLabelEl}<text x="${settings.valueX}" y="${settings.valueY}" text-anchor="middle" fill="${palette.valueColor}" font-family="${safeFont}" font-size="${settings.valueSize}" font-weight="700"${valueStrokeAttrs}>${valueTextWithSuffix}</text>${belowSuffixEl}</svg>`);
}

function renderGaugeCard(settings: NormalizedDisplaySettings, metricKey: string, label: string, value: number, history: number[]): string {
	const palette = themeFor(settings);
	const safeFont = escapeXml(palette.fontFamily);
	const safeLabel = escapeXml(label);
	const unit = inferUnit(metricKey).trim();
	const accent = themeAccentColor(settings, metricKey);
	const gaugeRange = inferGaugeRange(metricKey, history, value);
	const { min, max } = resolveScaleRange(settings, gaugeRange.min, gaugeRange.max);
	const progress = Math.max(0, Math.min(1, (value - min) / Math.max(1, max - min)));
	const startAngle = 135;
	const endAngle = 405;
	const progressAngle = startAngle + (endAngle - startAngle) * progress;
	const center = 72;
	const radius = 48;
	const trackPath = describeArc(center, center, radius, startAngle, endAngle);
	const valuePath = describeArc(center, center, radius, startAngle, progressAngle);
	const safeUnit = escapeXml(unit);
	const safeValue = escapeXml(formatMetricValue(value, settings.decimals));
	const unitY = Math.min(136, settings.valueY + 20);
	const labelStrokeAttrs = textStrokeAttrs(settings.labelStrokeColor, settings.labelStrokeWidth);
	const valueStrokeAttrs = textStrokeAttrs(settings.valueStrokeColor, settings.valueStrokeWidth);
	const valueTextWithSuffix = suffixTextWithMode(settings.suffixMode, safeValue, safeUnit, accent, settings.valueSize);
	const belowSuffixEl = suffixBelowElement(settings.suffixMode, safeUnit, settings.valueX, unitY, accent, safeFont, 14);
	const gaugeLabelEl = (!settings.hideLabel && safeLabel)
		? `<text x="${settings.labelX}" y="${settings.labelY}" text-anchor="middle" fill="${palette.labelColor}" font-family="${safeFont}" font-size="${settings.labelSize}" font-weight="600"${labelStrokeAttrs}>${safeLabel}</text>`
		: "";
	return svgToDataUri(`<svg xmlns="http://www.w3.org/2000/svg" width="${SVG_SIZE}" height="${SVG_SIZE}" viewBox="0 0 ${SVG_SIZE} ${SVG_SIZE}"><defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="${palette.bg0}"/><stop offset="100%" stop-color="${palette.bg1}"/></linearGradient></defs><rect x="2" y="2" width="140" height="140" rx="${CARD_RADIUS}" fill="url(#bg)"/><rect x="8" y="8" width="128" height="128" rx="${CARD_RADIUS - 4}" fill="none" stroke="${palette.borderColor}"/><path d="${trackPath}" fill="none" stroke="${palette.trackColor}" stroke-width="12" stroke-linecap="round"/><path d="${valuePath}" fill="none" stroke="${accent}" stroke-width="12" stroke-linecap="round"/>${gaugeLabelEl}<text x="${settings.valueX}" y="${settings.valueY}" text-anchor="middle" fill="${palette.valueColor}" font-family="${safeFont}" font-size="${settings.valueSize}" font-weight="700"${valueStrokeAttrs}>${valueTextWithSuffix}</text>${belowSuffixEl}</svg>`);
}

function suffixTextWithMode(mode: SuffixMode, safeValue: string, safeUnit: string, accent: string, valueSize: number): string {
	if (mode === "off" || !safeUnit) {
		return safeValue;
	}
	if (mode === "inline") {
		const suffixSize = Math.max(12, Math.round(valueSize * 0.45));
		return `<tspan>${safeValue}</tspan><tspan fill="${escapeXml(accent)}" font-size="${suffixSize}"> ${safeUnit}</tspan>`;
	}
	return safeValue;
}

function suffixBelowElement(mode: SuffixMode, safeUnit: string, x: number, y: number, accent: string, fontFamily: string, fontSize: number, extraAttrs = ""): string {
	if (mode !== "below" || !safeUnit) {
		return "";
	}
	return `<text x="${x}" y="${y}" text-anchor="middle" fill="${accent}" font-family="${fontFamily}" font-size="${fontSize}" font-weight="600"${extraAttrs}>${safeUnit}</text>`;
}

function textStrokeAttrs(color: string, width: number): string {
	if (width <= 0) {
		return "";
	}
	const safeColor = escapeXml(color);
	return ` stroke="${safeColor}" stroke-width="${width.toFixed(2)}" paint-order="stroke fill" stroke-linejoin="round"`;
}

function resolveScaleRange(settings: NormalizedDisplaySettings, autoMin: number, autoMax: number): { min: number; max: number } {
	if (settings.useCustomScale) {
		const customMin = settings.scaleMin;
		const customMax = settings.scaleMax;
		if (customMax <= customMin) {
			return { min: customMin, max: customMin + 1 };
		}
		return { min: customMin, max: customMax };
	}
	if (autoMax <= autoMin) {
		return { min: autoMin, max: autoMin + 1 };
	}
	return { min: autoMin, max: autoMax };
}

function svgToDataUri(svg: string): string {
	return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

function renderStatusCard(label: string, message: string, accent: string, detail?: string): string {
	const safeLabel = escapeXml(label);
	const safeMessage = escapeXml(message);
	const safeDetail = escapeXml((detail ?? "").slice(0, 36));
	return svgToDataUri(`<svg xmlns="http://www.w3.org/2000/svg" width="${SVG_SIZE}" height="${SVG_SIZE}" viewBox="0 0 ${SVG_SIZE} ${SVG_SIZE}"><defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#111827"/><stop offset="100%" stop-color="#0b1220"/></linearGradient></defs><rect x="2" y="2" width="140" height="140" rx="${CARD_RADIUS}" fill="url(#bg)"/><rect x="8" y="8" width="128" height="128" rx="${CARD_RADIUS - 4}" fill="none" stroke="#ffffff16"/><text x="72" y="34" text-anchor="middle" fill="#cbd5e1" font-family="Segoe UI" font-size="13" font-weight="600">${safeLabel}</text><text x="72" y="80" text-anchor="middle" fill="${accent}" font-family="Segoe UI" font-size="28" font-weight="700">${safeMessage}</text><text x="72" y="104" text-anchor="middle" fill="#94a3b8" font-family="Segoe UI" font-size="11">${safeDetail}</text></svg>`);
}

function accentColor(metricKey: string): string {
	if (metricKey.includes("temperature")) return "#f59e0b";
	if (metricKey.includes("power")) return "#22c55e";
	if (metricKey.includes("clock")) return "#a78bfa";
	if (metricKey.includes("fan")) return "#38bdf8";
	return "#22d3ee";
}

function inferGaugeRange(metricKey: string, history: number[], value: number): { min: number; max: number } {
	if (metricKey.includes("usage") || metricKey.includes("percent")) return { min: 0, max: 100 };
	if (metricKey.includes("temperature")) return { min: 0, max: 120 };
	if (metricKey.includes("fan_tachometer")) return { min: 0, max: 3000 };
	if (metricKey.includes("framerate")) return { min: 0, max: 240 };
	if (metricKey.includes("clock")) return { min: 0, max: 8000 };
	if (metricKey.includes("power")) return { min: 0, max: 500 };
	const observedMin = Math.min(...history, value);
	const observedMax = Math.max(...history, value);
	if (observedMax <= observedMin) {
		return { min: observedMin, max: observedMin + 1 };
	}
	return { min: observedMin, max: Math.max(observedMax, observedMax * 1.2) };
}

function polarToCartesian(centerX: number, centerY: number, radius: number, angleDegrees: number): { x: number; y: number } {
	const angleRadians = ((angleDegrees - 90) * Math.PI) / 180;
	return { x: centerX + radius * Math.cos(angleRadians), y: centerY + radius * Math.sin(angleRadians) };
}

function describeArc(centerX: number, centerY: number, radius: number, startAngle: number, endAngle: number): string {
	const start = polarToCartesian(centerX, centerY, radius, endAngle);
	const end = polarToCartesian(centerX, centerY, radius, startAngle);
	const largeArcFlag = endAngle - startAngle <= 180 ? "0" : "1";
	return ["M", start.x, start.y, "A", radius, radius, 0, largeArcFlag, 0, end.x, end.y].join(" ");
}

function escapeXml(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function isRequestMetricsPayload(payload: unknown): payload is RequestMetricsPayload {
	if (!payload || typeof payload !== "object") return false;
	const requestPayload = payload as Partial<RequestMetricsPayload>;
	return requestPayload.type === "request-metrics-list";
}

function normalizeEndpointUrl(endpointUrl: string | undefined): string {
	const rawValue = endpointUrl?.trim();
	if (!rawValue) return DEFAULT_SETTINGS.endpointUrl;
	if (/^https?:\/\//i.test(rawValue)) return rawValue;
	return `http://${rawValue}`;
}

function shouldAttemptSidecarBoot(endpointUrl: string): boolean {
	try {
		const parsed = new URL(endpointUrl);
		if (!["localhost", "127.0.0.1"].includes(parsed.hostname)) return false;
		return parsed.port === "" || parsed.port === "9696";
	} catch {
		return false;
	}
}

async function resolveAfterburnerReaderPath(): Promise<string | null> {
	const pluginBinDir = path.dirname(fileURLToPath(import.meta.url));
	const candidates = [path.join(pluginBinDir, SIDECAR_EXE_NAME), path.join(pluginBinDir, "..", SIDECAR_EXE_NAME)];
	for (const candidatePath of candidates) {
		try {
			await access(candidatePath);
			return candidatePath;
		} catch {
			continue;
		}
	}
	return null;
}

async function isAfterburnerReaderRunning(): Promise<boolean> {
	try {
		const taskListResponse = await fetch(normalizeEndpointUrl(DEFAULT_SETTINGS.endpointUrl), { headers: { accept: "application/json" } });
		return taskListResponse.ok;
	} catch {
		return false;
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
