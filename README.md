# Bus Tracker — Lignes d'Azur

Real-time bus departure board for the Lignes d'Azur network (Nice, France).

## Overview

Lightweight Node.js + vanilla JS stack:
- **Backend**: Express.js server that ingests GTFS static and GTFS-RT real-time data
- **Frontend**: Single-page HTML app with drawer navigation, favorites, day/night theme
- **Reverse proxy**: nginx (optional, documented)

## Quick start

```bash
npm install
node server.js
```

Open `http://127.0.0.1:8181/api/health` to verify.

For full setup behind nginx with systemd, see `deploy/bus-tracker-install.md`.

## Project structure

```
bus-tracker/
├── server.js                  # Express backend (port 8181)
├── package.json               # npm dependencies
├── www/
│   └── buses.html             # Frontend SPA
├── deploy/
│   ├── bus-tracker-install.md       # Full installation guide
│   ├── bus-tracker-architecture.md  # Architecture & data flow
│   └── bus-tracker-api.md           # API reference
├── nginx/
│   └── bus-tracker.conf.example     # Sanitized nginx config
├── systemd/
│   └── bus-server.service           # systemd unit
└── README.md
```

## Data sources

- **GTFS static**: `https://chouette.enroute.mobi/api/v1/datas/OpendataRLA/gtfs.zip`
- **GTFS-RT trip updates**: `https://ara-api.enroute.mobi/rla/gtfs/trip-updates`

Both are published under [Licence Ouverte / Open Licence 2.0](https://www.data.gouv.fr/en/licences) by Régie Lignes d'Azur / Métropole Nice Côte d'Azur.
