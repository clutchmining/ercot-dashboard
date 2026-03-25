# ERCOT Mining Dashboard

Small full-stack dashboard for a bitcoin mining project in Lolita, Texas focused on `LZ_SOUTH` pricing in ERCOT.

## What it does

- Pulls the current `LZ_SOUTH` real-time price from ERCOT's public load-zone display.
- Accepts ERCOT historical exports in `.csv` or `.xlsx` and normalizes them to a single time series.
- Stores AEP energy documents so they can be reviewed and mapped into contract logic later.
- Applies strike-price rules to show `compute`, `curtail`, and `sell_back` intervals.
- Calculates effective compute uptime from imported intervals.

## Minimal data sources

- Realtime RTM load-zone display: `https://www.ercot.com/content/cdr/html/hb_lz.html`
- Historical RTM load-zone and hub prices: ERCOT data product `NP6-785`
- Day-ahead settlement prices display: `https://www.ercot.com/content/cdr/html/dam_spp`

## Run locally

```bash
npm install
npm run dev
```

Frontend runs on `5173`. API runs on `8787`.

## Production

```bash
npm run build
npm start
```

## Render deployment

This repo includes [render.yaml](/Users/jl/energy-price-app/render.yaml) for a single-service deploy.

Required environment variables:

- `DASHBOARD_USERNAME`
- `DASHBOARD_PASSWORD`

Recommended values for the current share:

- username: `Clutch`
- password: `ClutchRule$1`

The service uses a persistent disk mounted at `/var/data` so imported ERCOT files, saved strike settings, and uploaded documents persist across deploys.

This is intentionally lighter than standing up Grafana plus a separate time-series database. If you want, the next step can be:

1. Move the normalized pricing tables into Postgres.
2. Provision Grafana against that database.
3. Keep this repo's ingestion logic and use Grafana only for visualization.

## Next steps for your documents

- Upload AEP contracts, tariffs, or settlement documents into the dashboard.
- After that, expand parsing to extract contract strike prices, demand charges, delivery points, and curtailment clauses.
- Add a mine economics layer if you want uptime to be based on BTC gross margin instead of a static strike threshold.
