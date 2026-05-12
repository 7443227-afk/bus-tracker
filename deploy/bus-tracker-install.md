# Bus Tracker — установка на портал NVS26

Подробная пошаговая инструкция для реализации в новом окне чата AI-ассистента.

---

## Архитектура

```
Браузер → HTTPS (auth_basic) → nginx (your-domain.example.com)
  ├── /buses.html           → статика /var/www/html/
  ├── /bus-api/*            → proxy_pass → Node.js :8181
  │                            ├── GTFS static (stops, routes, trips)
  │                            └── GTFS-RT trip_updates (protobuf) ← ara-api.enroute.mobi
  └── /services.html        → изменён (добавлена карточка)
```

---

## Шаг 1. Создать директорию и установить npm-пакеты

```bash
mkdir -p /home/ubuntu/bus-server
cd /home/ubuntu/bus-server
npm init -y
npm install express gtfs-realtime-bindings adm-zip csv-parse
```

---

## Шаг 2. Создать `server.js`

Файл: `/home/ubuntu/bus-server/server.js`

```javascript
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
    // console.log(`[RT] Fetched ${feed.entity.length} entities, ${rtUpdates.size} trips with updates`);
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
  // Если час >= 24, это "следующий день" — нормально для GTFS
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
      directions: [0, 1].filter(dir => tripStopsCache[`${r.route_id}_${dir}`]).map(dir => ({
        direction: dir,
        stopCount: tripStopsCache[`${r.route_id}_${dir}`]?.length || 0,
        stops: (tripStopsCache[`${r.route_id}_${dir}`] || []).map(s => ({ id: s.stop_id, name: s.stop_name }))
      }))
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

  // Найти все trip_id для этого маршрута+направления
  const relevantTrips = Object.values(trips).filter(t =>
    t.route_id === route && (direction === undefined || t.direction_id === direction)
  );

  for (const t of relevantTrips) {
    const stList = stopTimes[t.trip_id];
    if (!stList) continue;
    const st = stList.find(s => s.stop_id === stop);
    if (!st) continue;

    // Теоретическое время
    const scheduled = timeToPosix(st.arrival_time || st.departure_time);
    if (!scheduled) continue;

    // Реальное время из GTFS-RT
    let predicted = scheduled;
    const rtStop = rtUpdates.get(t.trip_id);
    if (rtStop && rtStop.has(stop)) {
      predicted = rtStop.get(stop);
    }

    const eta = predicted - now;
    if (eta < -120) continue; // уже прошло (с запасом 2 мин)

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
  setInterval(fetchRtUpdates, 15000);  // обновление RT каждые 15 сек
  setInterval(loadGtfsStatic, 3600000); // обновление GTFS static раз в час

  app.listen(PORT, '127.0.0.1', () => {
    console.log(`[BusServer] Listening on http://127.0.0.1:${PORT}`);
  });
}

start();
```

---

## Шаг 3. Создать `buses.html`

Файл: `/var/www/html/buses.html`

```html
<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Bus Tracker — Lignes d'Azur</title>
  <link rel="stylesheet" href="/css/portal.css">
  <style>
    .bus-grid { display: grid; gap: 16px; }
    .bus-row { display: flex; gap: 12px; flex-wrap: wrap; }
    .bus-row > div { flex: 1; min-width: 180px; }
    .bus-label { display: block; margin-bottom: 6px; font-size: 0.9rem; color: var(--text-muted); font-weight: 600; }
    .bus-select { width: 100%; min-height: 48px; border-radius: var(--radius-sm); border: 1px solid rgba(148,163,184,0.16); background: rgba(2,6,23,0.7); color: var(--text-main); padding: 10px 14px; font-size: 16px; outline: none; }
    .bus-select:focus { border-color: rgba(96,165,250,0.6); box-shadow: 0 0 0 3px rgba(59,130,246,0.14); }
    .bus-select optgroup { color: #94a3b8; }
    .bus-select option { color: var(--text-main); background: #0b1220; }
    .departure-card { background: rgba(15,23,42,0.78); border: 1px solid rgba(148,163,184,0.14); border-radius: var(--radius-md); padding: 20px 24px; backdrop-filter: blur(12px); box-shadow: var(--shadow); }
    .departure-row { display: flex; align-items: baseline; gap: 12px; padding: 12px 0; border-bottom: 1px solid rgba(148,163,184,0.08); }
    .departure-row:last-child { border-bottom: none; }
    .departure-time { font-size: clamp(1.6rem, 5vw, 2.4rem); font-weight: 850; letter-spacing: -0.03em; line-height: 1; }
    .departure-label { color: var(--text-muted); font-size: 0.88rem; }
    .departure-eta { color: #93c5fd; font-size: 0.92rem; font-weight: 600; }
    .rt-badge { display: inline-block; padding: 2px 8px; border-radius: 999px; background: rgba(34,197,94,0.2); color: #4ade80; font-size: 0.72rem; font-weight: 700; margin-left: 8px; }
    .fav-card { display: flex; align-items: center; gap: 12px; padding: 14px 18px; cursor: pointer; transition: border-color 0.15s; }
    .fav-card:hover { border-color: rgba(96,165,250,0.4); }
    .fav-info { flex: 1; }
    .fav-name { font-weight: 700; font-size: 1rem; }
    .fav-sub { color: var(--text-muted); font-size: 0.84rem; }
    .fav-del { background: none; border: none; color: #ef4444; cursor: pointer; font-size: 1.2rem; padding: 4px 8px; border-radius: 8px; }
    .fav-del:hover { background: rgba(239,68,68,0.15); }
    .empty-msg { color: var(--text-muted); text-align: center; padding: 40px 20px; }
    .auto-status { display: flex; align-items: center; gap: 10px; color: var(--text-muted); font-size: 0.85rem; margin-top: 8px; }
    .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
    .dot-green { background: #22c55e; }
    .dot-yellow { background: #eab308; }
    .status-bar { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; }
    @media (min-width: 576px) { .bus-row > div { min-width: 200px; } }
  </style>
</head>
<body>
  <div class="portal-page">
    <main class="portal-shell portal-stack">

      <!-- Избранное -->
      <section class="portal-card portal-pad portal-stack" id="favorites-section" style="display:none">
        <div class="portal-stack" style="gap:10px">
          <span class="portal-kicker">⭐ Избранное</span>
          <div id="favorites-list" class="bus-grid"></div>
        </div>
      </section>

      <!-- Заголовок -->
      <section class="portal-card portal-pad portal-stack">
        <div class="portal-stack" style="gap:10px">
          <span class="portal-kicker">🚌 Temps réel</span>
          <h1 class="portal-title" style="font-size:clamp(1.8rem,8vw,3.2rem)">Bus Tracker</h1>
          <p class="portal-subtitle">Отслеживание автобусов Lignes d'Azur в реальном времени. Выберите маршрут, направление и остановку.</p>
        </div>
      </section>

      <!-- Выбор маршрута -->
      <section class="portal-card portal-pad portal-stack">
        <div class="bus-row">
          <div>
            <label class="bus-label">Маршрут</label>
            <select id="route-select" class="bus-select"><option value="">— выберите маршрут —</option></select>
          </div>
          <div>
            <label class="bus-label">Направление</label>
            <select id="direction-select" class="bus-select" disabled><option value="">— сначала выберите маршрут —</option></select>
          </div>
          <div>
            <label class="bus-label">Остановка</label>
            <select id="stop-select" class="bus-select" disabled><option value="">— сначала выберите направление —</option></select>
          </div>
        </div>

        <div class="portal-actions" style="margin-top:8px">
          <button class="portal-btn portal-btn--primary" id="show-btn" disabled>Показать</button>
          <button class="portal-btn portal-btn--secondary" id="fav-btn" disabled>⭐ В избранное</button>
        </div>
      </section>

      <!-- Результаты -->
      <section class="departure-card portal-stack" id="results-section" style="display:none; gap:0">
        <div style="display:flex; align-items:center; justify-content:space-between; padding:0 0 12px 0; border-bottom:1px solid rgba(148,163,184,0.12)">
          <span id="result-title" style="font-weight:700;font-size:1.05rem"></span>
          <span id="result-time" style="color:var(--text-muted);font-size:0.82rem"></span>
        </div>
        <div id="result-list"></div>
        <div class="auto-status" id="auto-status">
          <span class="dot" id="status-dot"></span>
          <span id="status-text">Ожидание...</span>
        </div>
      </section>

      <a class="portal-back" href="/services.html">← Назад к сервисам</a>
    </main>
  </div>

  <script>
    const LS_KEY = 'busFavorites';
    let routesData = [];
    let autoInterval = null;
    let currentQuery = null;

    // ——— Загрузка маршрутов ———
    async function loadRoutes() {
      const r = await fetch('/bus-api/routes');
      routesData = await r.json();
      const sel = document.getElementById('route-select');
      sel.innerHTML = '<option value="">— выберите маршрут —</option>';
      for (const rt of routesData) {
        const opt = document.createElement('option');
        opt.value = rt.id;
        opt.textContent = rt.name;
        sel.appendChild(opt);
      }
    }

    // ——— Переключение направления ———
    document.getElementById('route-select').addEventListener('change', function() {
      const rt = routesData.find(r => r.id === this.value);
      const dirSel = document.getElementById('direction-select');
      dirSel.innerHTML = '';
      if (!rt || !rt.directions.length) {
        dirSel.innerHTML = '<option value="">— нет направлений —</option>';
        dirSel.disabled = true;
        document.getElementById('stop-select').disabled = true;
        document.getElementById('show-btn').disabled = true;
        document.getElementById('fav-btn').disabled = true;
        return;
      }
      dirSel.disabled = false;
      dirSel.innerHTML = '<option value="">— выберите направление —</option>';
      rt.directions.forEach((d, i) => {
        const opt = document.createElement('option');
        opt.value = d.direction;
        opt.textContent = `Направление ${d.direction === '0' ? 'A' : 'B'} (${d.stopCount} ост.)`;
        dirSel.appendChild(opt);
      });
      document.getElementById('stop-select').disabled = true;
      document.getElementById('show-btn').disabled = true;
      document.getElementById('fav-btn').disabled = true;
    });

    // ——— Переключение остановки ———
    document.getElementById('direction-select').addEventListener('change', function() {
      const rt = routesData.find(r => r.id === document.getElementById('route-select').value);
      if (!rt) return;
      const dir = rt.directions.find(d => String(d.direction) === this.value);
      const stopSel = document.getElementById('stop-select');
      stopSel.innerHTML = '';
      if (!dir || !dir.stops.length) {
        stopSel.innerHTML = '<option value="">— нет остановок —</option>';
        stopSel.disabled = true;
        document.getElementById('show-btn').disabled = true;
        document.getElementById('fav-btn').disabled = true;
        return;
      }
      stopSel.disabled = false;
      stopSel.innerHTML = '<option value="">— выберите остановку —</option>';
      dir.stops.forEach(s => {
        const opt = document.createElement('option');
        opt.value = s.id;
        opt.textContent = s.name;
        stopSel.appendChild(opt);
      });
      document.getElementById('show-btn').disabled = true;
      document.getElementById('fav-btn').disabled = true;
    });

    // ——— Выбор остановки ———
    document.getElementById('stop-select').addEventListener('change', function() {
      document.getElementById('show-btn').disabled = !this.value;
      document.getElementById('fav-btn').disabled = !this.value;
    });

    // ——— Получение departures ———
    async function fetchDepartures(route, direction, stop, callback) {
      const url = `/bus-api/departures?stop=${stop}&route=${route}&direction=${direction}`;
      const r = await fetch(url);
      return await r.json();
    }

    // ——— Отображение результатов ———
    function renderDepartures(data, routeName, stopName) {
      const section = document.getElementById('results-section');
      const list = document.getElementById('result-list');
      const title = document.getElementById('result-title');
      const timeEl = document.getElementById('result-time');

      section.style.display = 'grid';
      title.textContent = `Маршрут ${routeName} · ${stopName}`;
      timeEl.textContent = `Обновлено: ${new Date().toLocaleTimeString('ru-RU')}`;

      list.innerHTML = '';
      if (!data || data.length === 0) {
        list.innerHTML = '<div class="empty-msg">Нет ближайших отправлений</div>';
        return;
      }

      data.forEach((d, i) => {
        const div = document.createElement('div');
        div.className = 'departure-row';
        const minLabel = i === 0 ? 'Следующий' : i === 1 ? 'Затем' : 'Далее';
        div.innerHTML = `
          <div class="departure-time">${d.etaMinutes} <span style="font-size:0.5em;font-weight:400;color:var(--text-muted)">мин</span></div>
          <div>
            <div>${minLabel} <span class="departure-label">в ${d.predictedTime}</span>${d.isRealtime ? '<span class="rt-badge">реальное</span>' : ''}</div>
            <div class="departure-eta">${d.etaMinutes > 0 ? `≈ ${d.etaMinutes} мин` : 'менее 1 мин'}</div>
          </div>
        `;
        list.appendChild(div);
      });
    }

    // ——— Показать ———
    document.getElementById('show-btn').addEventListener('click', async () => {
      const route = document.getElementById('route-select').value;
      const dir = document.getElementById('direction-select').value;
      const stop = document.getElementById('stop-select').value;
      const rt = routesData.find(r => r.id === route);
      if (!rt || !stop) return;
      const dirObj = rt.directions.find(d => String(d.direction) === dir);
      const stopObj = dirObj?.stops.find(s => s.id === stop);
      const stopName = stopObj?.name || stop;
      currentQuery = { route, dir, stop, routeName: rt.name, stopName };

      const data = await fetchDepartures(route, dir, stop);
      renderDepartures(data, rt.name, stopName);
      document.getElementById('status-text').textContent = 'Автообновление каждые 30 сек';
      document.getElementById('status-dot').className = 'dot dot-green';
      startAutoRefresh();
    });

    // ——— В избранное ———
    document.getElementById('fav-btn').addEventListener('click', () => {
      const route = document.getElementById('route-select').value;
      const dir = document.getElementById('direction-select').value;
      const stop = document.getElementById('stop-select').value;
      const rt = routesData.find(r => r.id === route);
      if (!rt || !stop) return;
      const dirObj = rt.directions.find(d => String(d.direction) === dir);
      const stopObj = dirObj?.stops.find(s => s.id === stop);
      const favs = JSON.parse(localStorage.getItem(LS_KEY) || '[]');
      const key = `${route}_${dir}_${stop}`;
      if (favs.some(f => f.key === key)) return;
      favs.push({ key, route, dir, stop, routeName: rt.name, dirLabel: dir === '0' ? 'A' : 'B', stopName: stopObj?.name || stop });
      localStorage.setItem(LS_KEY, JSON.stringify(favs));
      renderFavorites();
    });

    // ——— Избранное ———
    function renderFavorites() {
      const favs = JSON.parse(localStorage.getItem(LS_KEY) || '[]');
      const section = document.getElementById('favorites-section');
      const list = document.getElementById('favorites-list');
      if (!favs.length) { section.style.display = 'none'; return; }
      section.style.display = 'grid';
      list.innerHTML = '';
      favs.forEach(f => {
        const div = document.createElement('div');
        div.className = 'portal-card portal-pad fav-card';
        div.innerHTML = `
          <div class="fav-info">
            <div class="fav-name">🚌 ${f.routeName} · ${f.stopName}</div>
            <div class="fav-sub">Направление ${f.dirLabel}</div>
          </div>
          <button class="fav-del" data-key="${f.key}" title="Удалить">✕</button>
        `;
        div.querySelector('.fav-del').addEventListener('click', (e) => {
          e.stopPropagation();
          const favs2 = JSON.parse(localStorage.getItem(LS_KEY) || '[]');
          localStorage.setItem(LS_KEY, JSON.stringify(favs2.filter(x => x.key !== f.key)));
          renderFavorites();
        });
        div.addEventListener('click', () => {
          document.getElementById('route-select').value = f.route;
          document.getElementById('route-select').dispatchEvent(new Event('change'));
          setTimeout(() => {
            document.getElementById('direction-select').value = f.dir;
            document.getElementById('direction-select').dispatchEvent(new Event('change'));
            setTimeout(() => {
              document.getElementById('stop-select').value = f.stop;
              document.getElementById('show-btn').disabled = false;
              document.getElementById('fav-btn').disabled = false;
              document.getElementById('show-btn').click();
            }, 100);
          }, 100);
        });
        list.appendChild(div);
      });
    }

    // ——— Автообновление ———
    function startAutoRefresh() {
      if (autoInterval) clearInterval(autoInterval);
      autoInterval = setInterval(async () => {
        if (!currentQuery) return;
        const data = await fetchDepartures(currentQuery.route, currentQuery.dir, currentQuery.stop);
        renderDepartures(data, currentQuery.routeName, currentQuery.stopName);
      }, 30000);
    }

    // ——— Инициализация ———
    loadRoutes();
    renderFavorites();
  </script>
</body>
</html>
```

---

## Шаг 4. Изменить `/etc/nginx/sites-enabled/ai`

Добавить в блок `server { listen 443 ssl; ... }` (после location `/news.html {}`):

```nginx
    location = /buses.html {}

    location /bus-api/ {
        limit_req zone=api burst=20 nodelay;
        proxy_pass http://127.0.0.1:8181/api/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
```

Проверить и перезагрузить nginx:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

---

## Шаг 5. Создать systemd-сервис

Файл: `/etc/systemd/system/bus-server.service`

```ini
[Unit]
Description=Bus Tracker Backend (Lignes d'Azur)
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/bus-server
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

Запустить:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now bus-server
sudo systemctl status bus-server
```

---

## Шаг 6. Добавить карточку в `/var/www/html/services.html`

Добавить перед последней карточкой (перед NVIDIA AI Chat) или после неё:

```html
<a class="card" href="/buses.html">
  <div class="card-title">Bus Tracker</div>
  <div class="card-desc">Отслеживание автобусов Lignes d'Azur в реальном времени. Выбор маршрута, остановки, избранное.</div>
</a>
```

---

## Шаг 7. Проверить работу

```bash
# Проверка сервера
curl http://127.0.0.1:8181/api/health
curl http://127.0.0.1:8181/api/routes | python3 -m json.tool | head -20

# Проверка nginx (замените на ваш домен)
curl -sI https://your-domain.example.com/buses.html | head -5
curl -s https://your-domain.example.com/bus-api/health | head -5

# Логи сервера
sudo journalctl -u bus-server -n 50 --no-pager
```

Открыть браузер: `https://your-domain.example.com/buses.html`

---

## Особенности реализации

### User=ubuntu (не www-data)
Домашняя директория `/home/ubuntu/` имеет права `750` — www-data не может читать файлы.
Сервис работает от пользователя `ubuntu`.

### proxy_pass с /api/
```nginx
proxy_pass http://127.0.0.1:8181/api/;
```
Слэш в конце означает, что nginx заменяет `/bus-api/` на `/api/`.
Без этого запрос `/bus-api/routes` уходил бы как `/routes`, а нужно `/api/routes`.

### Тема день/ночь
- Переключается кнопкой 🌙/☀️ в топбаре
- Сохраняется в `localStorage` (ключ `busTheme`)
- Цвета заданы через CSS-переменные (`--bg`, `--text`, `--accent` и т.д.)
- Плавный переход 0.25s

### Время
- Сервер отдаёт raw POSIX-таймстемпы (`scheduledTs`, `predictedTs`)
- Браузер форматирует в локальном часовом поясе пользователя
- Часы в топбаре обновляются каждую секунду

### Реальное время
- Бейдж «реальное» = данные из GTFS-RT trip_updates
- В кружке отображается только рейс с реальным временем
- Если реальных рейсов нет — кружок скрывается, отображается только расписание

### Дедупликация
Результаты `/api/departures` дедуплицируются по `predictedTs`:
если несколько trip-ов имеют одинаковое время на остановке, возвращается только один.

---

## Обслуживание

### Просмотр логов
```bash
sudo journalctl -u bus-server -n 50 --no-pager      # последние строки
sudo journalctl -u bus-server -f                      # в реальном времени
```

### Перезапуск
```bash
sudo systemctl restart bus-server
```

### Проверка состояния
```bash
sudo systemctl status bus-server
curl http://127.0.0.1:8181/api/health
```

### Обновление nginx
```bash
sudo nginx -t && sudo systemctl reload nginx
```

---

## Известные ограничения

1. **GTFS-RT trip_updates** обновляется каждые 15 секунд сервером — данные актуальны
2. **Автообновление страницы** — каждые 30 секунд (регулируется в `startAutoRefresh()`)
3. **Избранное** хранится в localStorage браузера — не синхронизируется между устройствами
4. **CSP не меняется** — все запросы на `'self'` (новые источники данных потребуют изменения CSP)
5. **auth_basic защищает** и страницу, и API — без логина доступ закрыт
6. Сервер слушает только `127.0.0.1:8181` — недоступен извне напрямую
7. **Нет фильтрации по календарю GTFS** — trips не отсеиваются по дням недели, возвращаются все варианты расписания. Дедупликация по времени частично решает проблему
8. **Модификации маршрутов (детуры)** не отражаются — GTFS-RT Alerts не используются, только trip_updates (корректировка времени)
9. **GTFS static обновляется раз в час** — изменения маршрутной сети видны не сразу

---

## Файлы проекта

| Файл | Назначение |
|------|-----------|
| `/home/ubuntu/bus-server/server.js` | Backend (Express) |
| `/home/ubuntu/bus-server/package.json` | npm-зависимости |
| `/var/www/html/buses.html` | Frontend |
| `/etc/nginx/sites-enabled/ai` | Nginx config (location /bus-api/) |
| `/etc/systemd/system/bus-server.service` | systemd unit |
| `/home/ubuntu/portal-deploy/bus-tracker-install.md` | Инструкция по установке |
| `/home/ubuntu/portal-deploy/bus-tracker-architecture.md` | Архитектура проекта |
| `/home/ubuntu/portal-deploy/bus-tracker-api.md` | API-документация |
