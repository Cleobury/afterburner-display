# Afterburner Display (Stream Deck Plugin)

A Stream Deck plugin that displays live MSI Afterburner telemetry on key tiles.

It ships with a bundled sidecar (`AfterburnerReader.exe`) that is **automatically launched on boot** — no manual setup required. The plugin reads metrics from the sidecar's local endpoint (default: `http://localhost:9696/metrics`), lets you choose which metric to render, and supports multiple visual styles with deep layout/theme customization.

## Features

- Live metric polling from local sidecar JSON endpoint
- Metric picker in Property Inspector (auto-loads available metric keys)
- Visual styles:
  - Value only
  - Line chart
  - Filled line chart
  - Gauge
- Theme presets (`default`, `neon`, `minimal`, `retro`) plus fully custom colors
- Independent label/value styling controls:
  - Position and size
  - Border color and border thickness
- Suffix display modes:
  - Beside value
  - Below value
  - Hidden
- Graph scaling controls:
  - Auto scale
  - Custom min/max range
- Polling interval and decimal precision controls
- Defensive value formatting (invalid or exponent output displays as `0`)
- Sidecar auto-boot support on Windows when local endpoint is unreachable

## Requirements

- Stream Deck software `7.1+`
- Node.js `24` (matches plugin manifest)
- A telemetry sidecar that serves JSON at `/metrics`
  - Default endpoint: `http://localhost:9696/metrics`

Expected response shape:

```json
{
  "status": "ok",
  "metrics": {
    "gpu1_temperature": 62.3,
    "gpu1_usage": 97
  },
  "error": null
}
```

## Project Layout

- `src/plugin.ts`: plugin entry and action registration
- `src/actions/increment-counter.ts`: main telemetry action logic and SVG rendering
- `src/AfterburnerReader.exe`: bundled sidecar executable (Windows)
- `com.lee-cleobury.afterburner-display.sdPlugin/manifest.json`: Stream Deck plugin manifest
- `com.lee-cleobury.afterburner-display.sdPlugin/ui/increment-counter.html`: Property Inspector UI
- `rollup.config.mjs`: build configuration and sidecar EXE emit logic

## Setup

Install dependencies:

```bash
npm install
```

Build plugin:

```bash
npm run build
```

Watch mode (rebuild + restart plugin on changes):

```bash
npm run watch
```

## Using The Plugin

1. Build the plugin.
2. Install/load the `.sdPlugin` folder into Stream Deck (dev workflow).
3. Add **Metric Display** action to a key — the sidecar starts automatically if it is not already running.
4. Open Property Inspector and configure:
   - Endpoint URL
   - Metric
   - Style/theme
   - Label/value layout and borders
   - Suffix mode
   - Polling, decimals, graph scale

## Development Notes

- Output bundle path: `com.lee-cleobury.afterburner-display.sdPlugin/bin/plugin.js`
- In non-watch builds, output is minified.
- Rollup emits `AfterburnerReader.exe` only when not already present in `bin` to avoid file-lock (`EBUSY`) issues.

## Troubleshooting

- **Blank/ERR tile**
  - The plugin will attempt to auto-start the sidecar on boot; if the tile still shows an error, verify the endpoint is reachable in a browser: `http://localhost:9696/metrics`
  - Confirm `AfterburnerReader.exe` is present in `bin/` and was not blocked by antivirus
- **No metrics in dropdown**
  - Ensure response has a `metrics` object
  - Check endpoint URL in Property Inspector
- **Graph scale looks wrong**
  - Disable custom scale for auto-scaling, or set valid min/max range
- **Unexpected large/exponent values**
  - Renderer falls back to `0` for invalid/scientific notation output

## License

MIT Innit
