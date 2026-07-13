# NFL Tracker

A no-build Cloudflare Worker app for NFL scores, standings, statistical leaders,
teams, rosters, and player profiles. Data comes from ESPN's public sports feeds
and is normalized behind short-lived edge-cached API routes.

## Run locally

```bash
npx wrangler@4 dev
```

## Deploy

```bash
npx wrangler@4 deploy
```

The static app lives in `public/`; the API is implemented in `src/worker.js`.
