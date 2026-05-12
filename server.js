const express = require('express');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { parse } = require('csv-parse/sync');
const GtfsRealtimeBindings = require('gtfs-realtime-bindings');

const app = express();
const PORT = 8181;
const GTFS_ZIP_URL = 'https://chouette.enroute.mobi/api/v1/datas/OpendataRLA/gtfs.zip';

// ——— In-memory хранилище ———
let stops = {};          // stop_id → { stop_id, stop_name, stop_lat, stop_lon }
let routes = {};         // route_id → { route_id, route_short_name, route_long_name }
let trips = {};          // trip_id → { route_id, direction_id }
let stopTimes = {};      // trip_id → [{ stop_id, stop_sequence, arrival_time, departure_time }]
let tripStopsCache = {}; // "routeId_dir" → [{ stop_id, stop_name, ... }]

// GTFS-RT: trip_update → Map<trip_id, Map<stop_id, arrival_timestamp>>
let rtUpdates = new Map();
let rtLastFetch = 0;

// ——— Загрузка GTFS static ———
async function loadGtfsStatic() {
  console.log('[GTFS] Downloading static data...');
  const resp = await fetch(GTFS_ZIP_URL);
  const buf = Buffer.from(await resp.arrayBuffer());
  const zip = new AdmZip(buf);

  // routes.txt
  const routesRaw = parse(zip.readAsText('routes.txt'), { columns: true, skip_empty_lines: true, delimiter: ',' });
  routes = {};
  for (const r of routesRaw) {
    routes[r.route_id] = { route_id: r.route_id, route_short_name: r.route_short_name, route_long_name: r.route_long_name };
  }

  // trips.txt
  const tripsRaw = parse(zip.readAsText('trips.txt'), { columns: true, skip_empty_lines: true, delimiter: ',' });
  trips = {};
  for (const t of tripsRaw) {
    trips[t.trip_id] = { route_id: t.route_id, direction_id: t.direction_id, trip_id: t.trip_id };
  }

  // stops.txt
  const stopsRaw = parse(zip.readAsText('stops.txt'), { columns: true, skip_empty_lines: true, delimiter: ',' });
  stops = {};
  for (const s of stopsRaw) {
    stops[s.stop_id] = { stop_id: s.stop_id, stop_name: s.stop_name, stop_lat: s.stop_lat, stop_lon: s.stop_lon };
  }

  // stop_times.txt
  const stRaw = parse(zip.readAsText('stop_times.txt'), { columns: true, skip_empty_lines: true, delimiter: ',' });
  stopTimes = {};
  for (const st of stRaw) {
    if (!stopTimes[st.trip_id]) stopTimes[st.trip_id] = [];
    stopTimes[st.trip_id].push({ stop_id: st.stop_id, stop_sequence: parseInt(st.stop_sequence), arrival_time: st.arrival_time, departure_time: st.departure_time });
  }

  // Строим кеш остановок по маршруту+направлению
  tripStopsCache = {};
  for (const t of Object.values(trips)) {
    const key = `${t.route_id}_${t.direction_id}`;
    if (!tripStopsCache[key] && stopTimes[t.trip_id]) {
      const seen = new Set();
      tripStopsCache[key] = stopTimes[t.trip_id]
        .map(st => stops[st.stop_id])
        .filter(s => s && !seen.has(s.stop_id) && seen.add(s.stop_id));
    }
  }

  console.log(`[GTFS] Loaded: ${Object.keys(routes).length} routes, ${Object.keys(stops).length} stops, ${Object.keys(trips).length} trips`);
}

// ——— Загрузка GTFS-RT ———
async function fetchRtUpdates() {
  try {
    const resp = await fetch('https://ara-api.enroute.mobi/rla/gtfs/trip-updates');
    const buf = Buffer.from(await resp.arrayBuffer());
    const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(buf);
    const newRt = new Map();
    for (const entity of feed.entity) {
      if (!entity.tripUpdate) continue;
      const tripId = entity.tripUpdate.trip.tripId;
      const stopMap = new Map();
      for (const stu of entity.tripUpdate.stopTimeUpdate) {
        if (stu.arrival && (stu.arrival.time || stu.arrival.delay !== undefined)) {
          let t;
          if (stu.arrival.time) {
            t = Number(stu.arrival.time); // POSIX timestamp
          } else {
            t = Math.floor(Date.now() / 1000) + Number(stu.arrival.delay);
          }
          stopMap.set(stu.stopId, t);
        }
        if (stu.departure && (stu.departure.time || stu.departure.delay !== undefined)) {
          let t;
          if (stu.departure.time) {
            t = Number(stu.departure.time);
          } else {
            t = Math.floor(Date.now() / 1000) + Number(stu.departure.delay);
          }
          if (!stopMap.has(stu.stopId)) stopMap.set(stu.stopId, t);
        }
      }
      if (stopMap.size > 0) newRt.set(tripId, stopMap);
    }
    rtUpdates = newRt;
    rtLastFetch = Date.now();
  } catch (e) {
    console.error('[RT] Fetch error:', e.message);
  }
}

// ——— Преобразование времени HH:MM:SS → POSIX today ———
function timeToPosix(timeStr) {
  if (!timeStr) return null;
  const parts = timeStr.split(':');
  if (parts.length < 2) return null;
  const h = parseInt(parts[0]), m = parseInt(parts[1]), s = parseInt(parts[2] || '0');
  const now = new Date();
  const dayOffset = Math.floor(h / 24);
  const hour = h % 24;
  return Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, hour, m, s).getTime() / 1000);
}

// ——— API: список маршрутов ———
app.get('/api/routes', (req, res) => {
  const list = Object.values(routes)
    .filter(r => r.route_short_name && !isNaN(r.route_short_name))
    .map(r => ({
      id: r.route_id,
      name: r.route_short_name,
      directions: [0, 1].filter(dir => tripStopsCache[`${r.route_id}_${dir}`]).map(dir => {
        const stops = (tripStopsCache[`${r.route_id}_${dir}`] || []).map(s => ({ id: s.stop_id, name: s.stop_name }));
        return { direction: dir, stopCount: stops.length, stops, terminalName: stops[stops.length - 1]?.name };
      })
    }))
    .sort((a, b) => parseInt(a.name) - parseInt(b.name));
  res.json(list);
});

// ——— API: остановки маршрута+направления ———
app.get('/api/routes/:routeId/directions/:direction/stops', (req, res) => {
  const key = `${req.params.routeId}_${req.params.direction}`;
  const list = tripStopsCache[key] || [];
  res.json(list.map(s => ({ id: s.stop_id, name: s.stop_name, lat: s.stop_lat, lon: s.stop_lon })));
});

// ——— API: ближайшие отправления ———
app.get('/api/departures', (req, res) => {
  const { stop, route, direction } = req.query;
  if (!stop || !route) return res.status(400).json({ error: 'Missing stop or route' });

  const now = Math.floor(Date.now() / 1000);
  const results = [];
  const seenTimes = new Set();

  // Найти все trip_id для этого маршрута+направления
  const relevantTrips = Object.values(trips).filter(t =>
    t.route_id === route && (direction === undefined || t.direction_id === direction)
  );

  for (const t of relevantTrips) {
    const stList = stopTimes[t.trip_id];
    if (!stList) continue;
    const st = stList.find(s => s.stop_id === stop);
    if (!st) continue;

    const scheduled = timeToPosix(st.arrival_time || st.departure_time);
    if (!scheduled) continue;

    let predicted = scheduled;
    const rtStop = rtUpdates.get(t.trip_id);
    if (rtStop && rtStop.has(stop)) {
      predicted = rtStop.get(stop);
    }

    const eta = predicted - now;
    if (eta < -120) continue;

    if (seenTimes.has(predicted)) continue;
    seenTimes.add(predicted);

    results.push({
      tripId: t.trip_id,
      scheduledTs: scheduled,
      predictedTs: predicted,
      etaSeconds: eta,
      etaMinutes: Math.max(0, Math.round(eta / 60)),
      isRealtime: rtStop && rtStop.has(stop)
    });
  }

  results.sort((a, b) => a.etaSeconds - b.etaSeconds);
  res.json(results.slice(0, 4));
});

// ——— Health check ———
app.get('/api/health', (req, res) => res.json({ ok: true, trips: rtUpdates.size }));

// ——— Запуск ———
async function start() {
  await loadGtfsStatic();
  await fetchRtUpdates();
  setInterval(fetchRtUpdates, 15000);
  setInterval(loadGtfsStatic, 3600000);

  app.listen(PORT, '127.0.0.1', () => {
    console.log(`[BusServer] Listening on http://127.0.0.1:${PORT}`);
  });
}

start();
