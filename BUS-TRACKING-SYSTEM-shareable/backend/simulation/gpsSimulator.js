const SimulationLog = require("../models/SimulationLog");

function distance(a, b) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;

  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) *
      Math.cos((b.lat * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;

  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function bearing(a, b) {
  const toRad = d => (d * Math.PI) / 180;
  const toDeg = r => (r * 180) / Math.PI;
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLng = toRad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function distanceAlongRoute(route, fromIdx, toIdx) {
  if (!Array.isArray(route) || route.length < 2) return 0;
  const start = Math.max(0, Math.min(fromIdx, route.length - 1));
  const end = Math.max(0, Math.min(toIdx, route.length - 1));
  if (end <= start) return 0;

  let km = 0;
  for (let i = start; i < end; i++) {
    km += distance(route[i], route[i + 1]);
  }
  return km;
}

function clampIndex(value, routeLength) {
  const max = Math.max(0, routeLength - 1);
  return Math.max(0, Math.min(max, value));
}

function pickInitialNextStopId(routeStopIds, travelDirection) {
  if (!Array.isArray(routeStopIds) || !routeStopIds.length) return null;
  return travelDirection === -1
    ? routeStopIds[routeStopIds.length - 1]
    : routeStopIds[0];
}

function getNextStopIdInSequence(routeStopIds, currentStopId, travelDirection) {
  if (!Array.isArray(routeStopIds) || !routeStopIds.length) return null;
  const currentIdx = routeStopIds.indexOf(String(currentStopId || ""));
  if (currentIdx === -1) {
    return pickInitialNextStopId(routeStopIds, travelDirection);
  }

  if (travelDirection === -1) {
    if (currentIdx > 0) return routeStopIds[currentIdx - 1];
    return routeStopIds.length > 1 ? routeStopIds[1] : routeStopIds[0];
  }

  if (currentIdx < routeStopIds.length - 1) return routeStopIds[currentIdx + 1];
  return routeStopIds.length > 1 ? routeStopIds[routeStopIds.length - 2] : routeStopIds[0];
}

function isTerminalStopId(routeStopIds, stopId) {
  if (!Array.isArray(routeStopIds) || routeStopIds.length < 2 || !stopId) return false;
  const sid = String(stopId);
  return sid === String(routeStopIds[0]) || sid === String(routeStopIds[routeStopIds.length - 1]);
}

function getNearestStop(stops, location, maxKm) {
  if (!location || !Array.isArray(stops) || !stops.length) {
    return { stop: null, distanceKm: Infinity };
  }

  let nearestStop = null;
  let nearestDistanceKm = Infinity;

  for (const stop of stops) {
    const km = distance(location, stop.location);
    if (km < nearestDistanceKm) {
      nearestDistanceKm = km;
      nearestStop = stop;
    }
  }

  if (typeof maxKm === "number" && nearestDistanceKm > maxKm) {
    return { stop: null, distanceKm: nearestDistanceKm };
  }

  return { stop: nearestStop, distanceKm: nearestDistanceKm };
}

module.exports = function startSimulation(io, buses, incidents, stops, onTickPersist, options = {}) {
  const predictEta = typeof options.predictEta === "function" ? options.predictEta : null;
  const getExternalWeather =
    typeof options.getExternalWeather === "function" ? options.getExternalWeather : null;
  const getRouteStopIds =
    typeof options.getRouteStopIds === "function" ? options.getRouteStopIds : null;
  const SPEED_KMPH = 30;
  const TICK_MS = 800;
  const STEP_POINTS = 0.5;
  const STOP_RADIUS_KM = 0.02;
  const STOP_DWELL_SEC = Number(process.env.STOP_DWELL_SEC || 60);
  const TERMINAL_DWELL_SEC = Number(process.env.TERMINAL_DWELL_SEC || 5 * 60);

  setInterval(() => {
    const stopById = new Map(
      stops.map(stop => [String(stop._id || stop.id), stop])
    );

    buses.forEach(bus => {
      if (!bus.route?.length) return;
      const route = bus.route;
      if (route.length < 2) return;
      if (bus.travelDirection !== -1) bus.travelDirection = 1;
      const routeStopIds = getRouteStopIds
        ? (getRouteStopIds(bus) || []).map(String).filter(Boolean)
        : [];

      if (routeStopIds.length) {
        if (!bus.nextStop || !routeStopIds.includes(String(bus.nextStop))) {
          bus.nextStop = pickInitialNextStopId(routeStopIds, bus.travelDirection);
        }
      }

      const nowTs = Date.now();
      if (Number.isFinite(Number(bus.dwellUntilTs))) {
        const remainingSec = (Number(bus.dwellUntilTs) - nowTs) / 1000;
        if (remainingSec > 0) {
          bus.dwellRemainingSec = remainingSec;
          bus.running = false;
          bus.status = "STOPPED_AT_STOP";
          // While dwelling, ETA should reflect remaining hold time at this stop.
          bus.eta = Math.max(1, Math.round(remainingSec / 60));
          return;
        }
        bus.dwellUntilTs = null;
        bus.dwellRemainingSec = 0;
        bus.running = true;
        bus.status = "ON_TIME";
      } else if (bus.dwellRemainingSec && bus.dwellRemainingSec > 0) {
        // Backward-compatible fallback if older persisted state has only dwellRemainingSec.
        bus.dwellRemainingSec = Math.max(0, Number(bus.dwellRemainingSec) - TICK_MS / 1000);
        bus.status = "STOPPED_AT_STOP";
        bus.running = false;
        if (bus.dwellRemainingSec > 0) {
          bus.eta = Math.max(1, Math.round(bus.dwellRemainingSec / 60));
          return;
        }
        bus.running = true;
        bus.status = "ON_TIME";
      }

      if (!bus.running) return;

      const maxIndex = route.length - 1;
      const nextIndex = (Number(bus.index) || 0) + STEP_POINTS * bus.travelDirection;

      if (nextIndex >= maxIndex) {
        bus.index = maxIndex;
        bus.travelDirection = -1;
      } else if (nextIndex <= 0) {
        bus.index = 0;
        bus.travelDirection = 1;
      } else {
        bus.index = nextIndex;
      }

      const currIdx = clampIndex(
        bus.travelDirection === -1 ? Math.ceil(bus.index) : Math.floor(bus.index),
        route.length
      );
      bus.location = route[currIdx];

      const bearingTargetIdx = bus.travelDirection === -1 ? currIdx - 1 : currIdx + 1;
      if (bearingTargetIdx >= 0 && bearingTargetIdx < route.length) {
        bus.bearing = bearing(route[currIdx], route[bearingTargetIdx]);
      }

      let arrivedStop = null;
      if (routeStopIds.length && bus.nextStop) {
        const targetStop = stopById.get(String(bus.nextStop));
        const distanceToTarget =
          targetStop && bus.location ? distance(bus.location, targetStop.location) : Infinity;
        if (distanceToTarget <= STOP_RADIUS_KM) {
          arrivedStop = targetStop;
        }
      } else {
        const nearest = getNearestStop(stops, bus.location);
        arrivedStop = nearest.distanceKm <= STOP_RADIUS_KM ? nearest.stop : null;
      }

      if (arrivedStop) {
        const arrivedStopId = String(arrivedStop._id || arrivedStop.id || "");
        const dwellSec = isTerminalStopId(routeStopIds, arrivedStopId)
          ? TERMINAL_DWELL_SEC
          : STOP_DWELL_SEC;
        bus.running = false;
        bus.status = "STOPPED_AT_STOP";
        bus.dwellRemainingSec = dwellSec;
        bus.dwellUntilTs = nowTs + dwellSec * 1000;
        bus.eta = Math.max(1, Math.round(dwellSec / 60));
        if (routeStopIds.length) {
          bus.nextStop = getNextStopIdInSequence(routeStopIds, bus.nextStop, bus.travelDirection);
        } else {
          bus.nextStop = arrivedStop._id || arrivedStop.id || null;
        }
        return;
      }

      if (!routeStopIds.length) {
        const nearest = getNearestStop(stops, bus.location);
        const upcomingStop = nearest.distanceKm <= STOP_RADIUS_KM * 3 ? nearest.stop : null;
        if (upcomingStop) {
          bus.nextStop = upcomingStop._id;
        } else {
          bus.nextStop = null;
        }
      }

      const remainingKm =
        bus.travelDirection === -1
          ? distanceAlongRoute(route, 0, currIdx)
          : distanceAlongRoute(route, currIdx, route.length - 1);

      let delayFactor = 1;
      let severe = false;
      let nearbyIncidentCount = 0;

      incidents.forEach(incident => {
        const d = distance(bus.location, incident.location);
        if (d < 0.3) nearbyIncidentCount += 1;
        if (d < 0.1) severe = true;
        else if (d < 0.3) delayFactor = Math.max(delayFactor, 1.5);
      });

      const externalWeather = getExternalWeather ? getExternalWeather(bus) : null;
      const externalTrafficImpact =
        externalWeather && Number.isFinite(Number(externalWeather.trafficImpact))
          ? Math.max(0.8, Number(externalWeather.trafficImpact))
          : 1;

      bus.externalTempC =
        externalWeather && Number.isFinite(Number(externalWeather.temperatureC))
          ? Number(externalWeather.temperatureC)
          : null;
      bus.externalPrecipMm =
        externalWeather && Number.isFinite(Number(externalWeather.precipitationMm))
          ? Number(externalWeather.precipitationMm)
          : null;
      bus.externalWindSpeedKph =
        externalWeather && Number.isFinite(Number(externalWeather.windSpeedKph))
          ? Number(externalWeather.windSpeedKph)
          : null;
      bus.externalWeatherCode =
        externalWeather && Number.isFinite(Number(externalWeather.weatherCode))
          ? Number(externalWeather.weatherCode)
          : null;
      bus.externalWeatherSeverity =
        externalWeather && Number.isFinite(Number(externalWeather.weatherSeverity))
          ? Number(externalWeather.weatherSeverity)
          : 0;
      bus.externalTrafficImpact = externalTrafficImpact;

      const effectiveDelayFactor = delayFactor * externalTrafficImpact;
      bus.trafficFactor = effectiveDelayFactor;
      bus.incidentsNearby = nearbyIncidentCount;

      if (severe) {
        bus.status = "STOPPED";
        bus.eta = null;
        return;
      }

      const dwellNowMin = (bus.dwellRemainingSec || 0) / 60;
      const etaFormulaMin = (remainingKm / SPEED_KMPH) * 60 * effectiveDelayFactor + dwellNowMin;
      const etaPredicted = predictEta ? predictEta(bus) : null;
      const etaMin = Number.isFinite(etaPredicted) ? etaPredicted : etaFormulaMin;
      bus.status = effectiveDelayFactor > 1 || dwellNowMin > 0 ? "DELAYED" : "ON_TIME";
      bus.eta = Math.max(0, Math.round(etaMin));
    });

    buses.forEach(async bus => {
      try {
        if (onTickPersist) await onTickPersist(bus);

        const nextStop = stopById.get(String(bus.nextStop || ""));
        const distanceToNextStop =
          nextStop && bus.location ? distance(bus.location, nextStop.location) : null;
        bus.distanceToNextStop = distanceToNextStop;

        await SimulationLog.create({
          busId: bus.id,
          routeId: bus.routeId || null,
          timestamp: new Date(),
          currentLat: bus.location?.lat ?? null,
          currentLng: bus.location?.lng ?? null,
          nextStopId: bus.nextStop || null,
          distanceToNextStop,
          dwellTime: bus.dwellRemainingSec || 0,
          incidentsNearby: bus.incidentsNearby || 0,
          trafficFactor: bus.trafficFactor || 1,
          externalTempC: bus.externalTempC,
          externalPrecipMm: bus.externalPrecipMm,
          externalWindSpeedKph: bus.externalWindSpeedKph,
          externalWeatherCode: bus.externalWeatherCode,
          externalWeatherSeverity: bus.externalWeatherSeverity || 0,
          externalTrafficImpact: bus.externalTrafficImpact || 1,
          actualETAT: bus.status === "STOPPED_AT_STOP" ? new Date() : null,
          eta: bus.eta,
          status: bus.status,
          location: bus.location
        });
      } catch (e) {
        console.error("Simulation tick persistence failed", e.message);
      } finally {
        io.emit("busUpdate", bus);
      }
    });
  }, TICK_MS);
};
