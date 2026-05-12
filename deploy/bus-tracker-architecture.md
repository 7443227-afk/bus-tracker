# Bus Tracker — Architecture

## Overview

Bus Tracker показывает ближайшие отправления автобусов Lignes d'Azur (Nice) в реальном времени.

```
Браузер → HTTPS (auth_basic) → nginx (your-domain.example.com)
  ├── /buses.html           → статика /var/www/html/
  ├── /bus-api/*            → proxy_pass → Node.js :8181
  │                            ├── GTFS static (routes, stops, trips, stop_times)
  │                            └── GTFS-RT trip_updates (protobuf) ← ara-api.enroute.mobi
  └── /services.html        → карточка Bus Tracker
```

## Components

### 1. Node.js backend (`bus-server`)
- **Service**: `bus-server.service` (systemd, user=ubuntu)
- **Port**: 8181 (loopback only)
- **Working dir**: `/home/ubuntu/bus-server/`
- **Stack**: Express.js + gtfs-realtime-bindings + adm-zip + csv-parse
- **GTFS source**: `https://chouette.enroute.mobi/api/v1/datas/OpendataRLA/gtfs.zip`
- **GTFS-RT source**: `https://ara-api.enroute.mobi/rla/gtfs/trip-updates`

### 2. Frontend (`buses.html`)
- Location: `/var/www/html/buses.html`
- Served statically by nginx
- Communicates with backend via `/bus-api/*` (nginx proxy)
- No framework — vanilla JS
- localStorage для избранного и темы

### 3. Nginx
- Config: `/etc/nginx/sites-enabled/ai`
- `location = /buses.html {}` — отдаёт статику
- `location /bus-api/` → `proxy_pass http://127.0.0.1:8181/api/` — прокси на Node.js
- Защита: auth_basic

## Data flow

### Startup
```
start()
  → loadGtfsStatic()       // GTFS .zip → routes, stops, trips, stopTimes, tripStopsCache
  → fetchRtUpdates()        // GTFS-RT trip_updates → rtUpdates (Map<tripId, Map<stopId, timestamp>>)
  → setInterval(fetchRtUpdates, 15s)
  → setInterval(loadGtfsStatic, 1h)
  → app.listen(8181)
```

### Request: departures
```
GET /api/departures?stop={stopId}&route={routeId}&direction={0|1}

  1. Filter trips by route_id + direction_id
  2. For each trip, find matching stop_time entry for stopId
  3. scheduled = HH:MM:SS → POSIX timestamp (timeToPosix)
  4. predicted = rtUpdates.get(tripId)?.get(stopId) || scheduled
  5. Filter out departed trips (eta < -120s)
  6. Deduplicate by predictedTs
  7. Sort by eta, return top 4
```

## Data structures (in-memory)

| Store | Key | Value |
|-------|-----|-------|
| `routes` | route_id | `{ route_id, route_short_name, route_long_name }` |
| `stops` | stop_id | `{ stop_id, stop_name, stop_lat, stop_lon }` |
| `trips` | trip_id | `{ route_id, direction_id, trip_id }` |
| `stopTimes` | trip_id | `[{ stop_id, stop_sequence, arrival_time, departure_time }]` |
| `tripStopsCache` | `{routeId}_{direction}` | `[{ stop_id, stop_name, ... }]` — deduplicated ordered stops |
| `rtUpdates` | trip_id | `Map<stop_id, arrival_timestamp>` — GTFS-RT data |

## Refresh intervals

| Data | Interval | Mechanism |
|------|----------|-----------|
| GTFS static | 1 hour | `setInterval(loadGtfsStatic, 3600000)` |
| GTFS-RT trip_updates | 15 seconds | `setInterval(fetchRtUpdates, 15000)` |
| Frontend auto-refresh | 30 seconds | `setInterval` in browser JS |

## Theme

- Day/night toggle stored in localStorage key `busTheme`
- All colors defined as CSS custom properties on `:root` / `body.day`
- Transition duration: 0.25s
