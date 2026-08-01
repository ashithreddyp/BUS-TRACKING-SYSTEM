function toNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function weatherSeverityFromCode(code) {
  const c = toNumber(code, 0);
  // WMO weather code buckets.
  if ([95, 96, 99].includes(c)) return 3; // thunderstorm
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(c)) return 2; // rain
  if ([71, 73, 75, 77, 85, 86].includes(c)) return 2; // snow
  if ([51, 53, 55, 56, 57].includes(c)) return 1; // drizzle/freezing drizzle
  if ([45, 48].includes(c)) return 1; // fog
  return 0; // clear/partly cloudy/overcast
}

function computeTrafficImpact({ precipitationMm = 0, windSpeedKph = 0, weatherCode = 0 }) {
  let impact = 1;
  const precip = toNumber(precipitationMm, 0);
  const wind = toNumber(windSpeedKph, 0);
  const severity = weatherSeverityFromCode(weatherCode);

  if (precip >= 2) impact += 0.35;
  else if (precip >= 0.2) impact += 0.15;

  if (wind >= 30) impact += 0.2;
  else if (wind >= 18) impact += 0.1;

  if (severity >= 3) impact += 0.3;
  else if (severity >= 2) impact += 0.15;
  else if (severity >= 1) impact += 0.08;

  return clamp(impact, 1, 2.2);
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { "User-Agent": "Bus-Tracking-ML/1.0" }
  });
  if (!response.ok) {
    throw new Error(`External API ${response.status}`);
  }
  return response.json();
}

function parseCurrentWeather(payload) {
  const current = payload?.current || {};
  const temperatureC = toNumber(current.temperature_2m, 0);
  const precipitationMm = toNumber(current.precipitation, 0);
  const windSpeedKph = toNumber(current.wind_speed_10m, 0);
  const weatherCode = toNumber(current.weather_code, 0);
  const weatherSeverity = weatherSeverityFromCode(weatherCode);
  const trafficImpact = computeTrafficImpact({
    precipitationMm,
    windSpeedKph,
    weatherCode
  });
  return {
    temperatureC,
    precipitationMm,
    windSpeedKph,
    weatherCode,
    weatherSeverity,
    trafficImpact,
    fetchedAt: new Date().toISOString()
  };
}

async function fetchCurrentWeatherSnapshot({ latitude, longitude }) {
  const lat = toNumber(latitude);
  const lng = toNumber(longitude);
  const url =
    "https://api.open-meteo.com/v1/forecast" +
    `?latitude=${encodeURIComponent(lat)}` +
    `&longitude=${encodeURIComponent(lng)}` +
    "&current=temperature_2m,precipitation,wind_speed_10m,weather_code" +
    "&timezone=UTC";

  const payload = await fetchJson(url);
  return parseCurrentWeather(payload);
}

function createLiveWeatherProvider({
  latitude,
  longitude,
  intervalMs = 15 * 60 * 1000
}) {
  let lat = toNumber(latitude, 13.0827);
  let lng = toNumber(longitude, 77.5877);
  let snapshot = null;
  let timer = null;

  const refresh = async () => {
    try {
      snapshot = await fetchCurrentWeatherSnapshot({ latitude: lat, longitude: lng });
    } catch {
      // Keep last snapshot if external service is unavailable.
    }
  };

  return {
    start() {
      if (timer) return;
      refresh();
      timer = setInterval(refresh, intervalMs);
      if (typeof timer.unref === "function") timer.unref();
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
    async refreshNow() {
      await refresh();
      return snapshot;
    },
    setLocation(newLat, newLng) {
      lat = toNumber(newLat, lat);
      lng = toNumber(newLng, lng);
    },
    getSnapshot() {
      return snapshot;
    }
  };
}

function toDateOnly(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function toHourKey(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 13) + ":00";
}

function roundedCoord(v) {
  return Math.round(toNumber(v, 0) * 100) / 100;
}

async function fetchHistoricalDayWeather({ latitude, longitude, date }) {
  const url =
    "https://archive-api.open-meteo.com/v1/archive" +
    `?latitude=${encodeURIComponent(latitude)}` +
    `&longitude=${encodeURIComponent(longitude)}` +
    `&start_date=${encodeURIComponent(date)}` +
    `&end_date=${encodeURIComponent(date)}` +
    "&hourly=temperature_2m,precipitation,wind_speed_10m,weather_code" +
    "&timezone=UTC";

  const payload = await fetchJson(url);
  const hourly = payload?.hourly || {};
  const times = hourly.time || [];
  const temps = hourly.temperature_2m || [];
  const precips = hourly.precipitation || [];
  const winds = hourly.wind_speed_10m || hourly.windspeed_10m || [];
  const codes = hourly.weather_code || hourly.weathercode || [];

  const map = new Map();
  for (let i = 0; i < times.length; i++) {
    const weatherCode = toNumber(codes[i], 0);
    const row = {
      temperatureC: toNumber(temps[i], 0),
      precipitationMm: toNumber(precips[i], 0),
      windSpeedKph: toNumber(winds[i], 0),
      weatherCode,
      weatherSeverity: weatherSeverityFromCode(weatherCode)
    };
    row.trafficImpact = computeTrafficImpact(row);
    map.set(times[i], row);
  }

  return map;
}

async function enrichLogsWithHistoricalWeather(logs, opts = {}) {
  const maxRequests = Math.max(1, Math.floor(toNumber(opts.maxRequests, 100)));
  const requestBuckets = new Map();

  for (const log of logs) {
    if (!log || !log.timestamp) continue;
    if (log.externalTrafficImpact != null) continue;
    if (log.currentLat == null || log.currentLng == null) continue;

    const date = toDateOnly(log.timestamp);
    if (!date) continue;

    const lat = roundedCoord(log.currentLat);
    const lng = roundedCoord(log.currentLng);
    const reqKey = `${lat}|${lng}|${date}`;

    if (!requestBuckets.has(reqKey)) {
      requestBuckets.set(reqKey, { lat, lng, date, logs: [] });
    }
    requestBuckets.get(reqKey).logs.push(log);
  }

  const entries = Array.from(requestBuckets.values()).slice(0, maxRequests);
  let updatedCount = 0;
  let requestCount = 0;

  for (const entry of entries) {
    try {
      requestCount += 1;
      const hourMap = await fetchHistoricalDayWeather({
        latitude: entry.lat,
        longitude: entry.lng,
        date: entry.date
      });

      for (const log of entry.logs) {
        const hourKey = toHourKey(log.timestamp);
        if (!hourKey) continue;
        const weather = hourMap.get(hourKey);
        if (!weather) continue;

        log.externalTempC = weather.temperatureC;
        log.externalPrecipMm = weather.precipitationMm;
        log.externalWindSpeedKph = weather.windSpeedKph;
        log.externalWeatherCode = weather.weatherCode;
        log.externalWeatherSeverity = weather.weatherSeverity;
        log.externalTrafficImpact = weather.trafficImpact;
        updatedCount += 1;
      }
    } catch {
      // Skip external-data failures; training should still continue.
    }
  }

  return {
    logs,
    stats: {
      requestedBuckets: entries.length,
      completedRequests: requestCount,
      updatedLogs: updatedCount
    }
  };
}

module.exports = {
  weatherSeverityFromCode,
  computeTrafficImpact,
  createLiveWeatherProvider,
  enrichLogsWithHistoricalWeather
};
