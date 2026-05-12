# Bus Tracker — API Reference

Base URL (via nginx): `https://your-domain.example.com/bus-api/`  
Base URL (direct): `http://127.0.0.1:8181/api/`

All endpoints return JSON. All requests are protected by auth_basic.

---

## `GET /api/routes`

Returns all numeric routes with directions and stop lists.

### Response
```json
[
  {
    "id": "05",
    "name": "05",
    "directions": [
      {
        "direction": 0,
        "stopCount": 27,
        "stops": [
          { "id": "1434", "name": "Deloye / Dubouchage" },
          { "id": "1179", "name": "Masséna / Guitry" }
        ],
        "terminalName": "Rimiez Les Sources"
      },
      {
        "direction": 1,
        "stopCount": 18,
        "stops": [
          { "id": "263", "name": "Col de Villefranche" }
        ],
        "terminalName": "Deloye / Dubouchage"
      }
    ]
  }
]
```

### Notes
- Filters out non-numeric routes (letters only, like `N100`)
- Sorted by route number
- `direction`: `0` = направление A, `1` = направление B
- `terminalName`: last stop in the direction

---

## `GET /api/routes/:routeId/directions/:direction/stops`

Returns stops for a specific route+direction with coordinates.

### Response
```json
[
  { "id": "1434", "name": "Deloye / Dubouchage", "lat": "43.696", "lon": "7.277" }
]
```

---

## `GET /api/departures`

Returns upcoming departures for a given stop on a route.

### Query parameters

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `stop` | string | yes | Stop ID (from routes data) |
| `route` | string | yes | Route ID (e.g. `"05"`, `"33"`) |
| `direction` | string | no | `"0"` or `"1"` |

### Response
```json
[
  {
    "tripId": "6867914-05_A_99_0508_14:11-...",
    "scheduledTs": 1778595060,
    "predictedTs": 1778587985,
    "etaSeconds": 283,
    "etaMinutes": 5,
    "isRealtime": true
  },
  {
    "tripId": "6699316-05_A_99_0501_12:13-...",
    "scheduledTs": 1778587980,
    "predictedTs": 1778587980,
    "etaSeconds": 384,
    "etaMinutes": 6,
    "isRealtime": false
  }
]
```

### Fields

| Field | Type | Description |
|-------|------|-------------|
| `tripId` | string | GTFS trip identifier |
| `scheduledTs` | number | Scheduled arrival (POSIX timestamp, seconds) |
| `predictedTs` | number | Real-time adjusted arrival (POSIX timestamp) |
| `etaSeconds` | number | Seconds until arrival (may be negative if passed) |
| `etaMinutes` | number | Minutes until arrival (clamped to ≥ 0) |
| `isRealtime` | boolean | `true` if time comes from GTFS-RT |

### Behavior
- Returns up to 4 departures, sorted by eta
- Departures more than 2 minutes in the past are excluded
- Duplicate `predictedTs` values are collapsed (first wins)
- `isRealtime` is `true` when GTFS-RT `trip_update` exists for this trip+stop

---

## `GET /api/health`

Simple health check.

### Response
```json
{
  "ok": true,
  "trips": 903
}
```

- `trips`: number of GTFS-RT trip updates currently cached

---

## Error responses

### 400 Bad Request
```json
{ "error": "Missing stop or route" }
```

Returned when required query params are missing from `/api/departures`.
