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

function interpolateRoutePoint(route, indexValue) {
  if (!Array.isArray(route) || !route.length) return null;
  if (route.length === 1) return route[0];

  const clamped = Math.max(0, Math.min(route.length - 1, Number(indexValue) || 0));
  const lowerIdx = Math.floor(clamped);
  const upperIdx = Math.min(route.length - 1, Math.ceil(clamped));
  const lowerPoint = route[lowerIdx];
  const upperPoint = route[upperIdx];
  if (!lowerPoint || !upperPoint) return lowerPoint || upperPoint || null;
  if (lowerIdx === upperIdx) return lowerPoint;

  const ratio = clamped - lowerIdx;
  return {
    lat: lowerPoint.lat + (upperPoint.lat - lowerPoint.lat) * ratio,
    lng: lowerPoint.lng + (upperPoint.lng - lowerPoint.lng) * ratio
  };
}

function advanceIndexByDistance(route, currentIndex, travelDirection, distanceKm) {
  if (!Array.isArray(route) || route.length < 2) {
    return {
      nextIndex: 0,
      hitStartBoundary: false,
      hitEndBoundary: false
    };
  }

  let remainingKm = Math.max(0, Number(distanceKm) || 0);
  let indexValue = Math.max(0, Math.min(route.length - 1, Number(currentIndex) || 0));
  const direction = Number(travelDirection) === -1 ? -1 : 1;

  while (remainingKm > 0.00001) {
    const baseIdx = direction === 1 ? Math.floor(indexValue) : Math.ceil(indexValue);
    const nextIdx = baseIdx + direction;

    if (nextIdx < 0) {
      return {
        nextIndex: 0,
        hitStartBoundary: true,
        hitEndBoundary: false
      };
    }

    if (nextIdx >= route.length) {
      return {
        nextIndex: route.length - 1,
        hitStartBoundary: false,
        hitEndBoundary: true
      };
    }

    const segmentStart = route[baseIdx];
    const segmentEnd = route[nextIdx];
    const segmentKm = distance(segmentStart, segmentEnd);
    if (!Number.isFinite(segmentKm) || segmentKm <= 0.000001) {
      indexValue = nextIdx;
      continue;
    }

    const progressWithinSegment =
      direction === 1 ? indexValue - baseIdx : baseIdx - indexValue;
    const remainingFraction = Math.max(0, 1 - progressWithinSegment);
    const remainingSegmentKm = segmentKm * remainingFraction;

    if (remainingKm < remainingSegmentKm) {
      const fractionMove = remainingKm / segmentKm;
      indexValue += direction * fractionMove;
      remainingKm = 0;
      break;
    }

    indexValue = nextIdx;
    remainingKm -= remainingSegmentKm;
  }

  return {
    nextIndex: Math.max(0, Math.min(route.length - 1, indexValue)),
    hitStartBoundary: false,
    hitEndBoundary: false
  };
}

function buildOrderedStopRouteIndexMap(route, routeStopIds, stopById) {
  const map = new Map();
  if (!Array.isArray(route) || !route.length) return map;
  if (!Array.isArray(routeStopIds) || !routeStopIds.length) return map;

  let searchStart = 0;
  routeStopIds.forEach(stopId => {
    const stop = stopById.get(String(stopId));
    if (!stop?.location) {
      map.set(String(stopId), searchStart);
      return;
    }

    let bestIdx = searchStart;
    let bestDistanceKm = Infinity;
    for (let i = searchStart; i < route.length; i++) {
      const km = distance(route[i], stop.location);
      if (km < bestDistanceKm) {
        bestDistanceKm = km;
        bestIdx = i;
      }
    }
    map.set(String(stopId), bestIdx);
    searchStart = bestIdx;
  });

  return map;
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

function isTerminalRouteIndex(routeIndex, routeLength) {
  if (!Number.isInteger(routeIndex) || routeLength < 2) return false;
  return routeIndex === 0 || routeIndex === routeLength - 1;
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

function normalizeIncidentType(type) {
  const raw = String(type || "").trim().toLowerCase();
  if (raw === "accident") return "Accident";
  if (raw === "road work") return "Road Work";
  if (raw === "traffic jam") return "Traffic Jam";
  if (raw === "flood") return "Flood";
  return "Other";
}

module.exports = function startSimulation(io, buses, incidents, stops, onTickPersist, options = {}) {
  const predictEta = typeof options.predictEta === "function" ? options.predictEta : null;
  const predictEtaRange = typeof options.predictEtaRange === "function" ? options.predictEtaRange : null;
  const predictDelayRisk = typeof options.predictDelayRisk === "function" ? options.predictDelayRisk : null;
  const predictIncidentFactor =
    typeof options.predictIncidentFactor === "function" ? options.predictIncidentFactor : null;
  const getExternalWeather =
    typeof options.getExternalWeather === "function" ? options.getExternalWeather : null;
  const getRouteStopIds =
    typeof options.getRouteStopIds === "function" ? options.getRouteStopIds : null;
  const SPEED_KMPH = 30;
  const TICK_MS = 800;
  const MOVEMENT_SCALE = Math.max(1, Number(process.env.SIM_MOVEMENT_SCALE || 4));
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
      const stopRouteIndexMap = routeStopIds.length
        ? buildOrderedStopRouteIndexMap(route, routeStopIds, stopById)
        : null;
      const firstRouteStopId = routeStopIds[0] || null;
      const lastRouteStopId = routeStopIds[routeStopIds.length - 1] || null;
      const firstRouteStopIdx = firstRouteStopId ? stopRouteIndexMap?.get(String(firstRouteStopId)) : null;
      const lastRouteStopIdx = lastRouteStopId ? stopRouteIndexMap?.get(String(lastRouteStopId)) : null;

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
          bus.etaLower = bus.eta;
          bus.etaUpper = bus.eta;
          bus.etaConfidencePlusMinus = 0;
          bus.delayRiskLabel = "ON_TIME";
          bus.delayRiskConfidence = 1;
          bus.predictedDelayMinutes = 0;
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
          bus.etaLower = bus.eta;
          bus.etaUpper = bus.eta;
          bus.etaConfidencePlusMinus = 0;
          bus.delayRiskLabel = "ON_TIME";
          bus.delayRiskConfidence = 1;
          bus.predictedDelayMinutes = 0;
          return;
        }
        bus.running = true;
        bus.status = "ON_TIME";
      }

      if (!bus.running) return;

      const maxIndex = route.length - 1;
      const tickDistanceKm = (SPEED_KMPH * (TICK_MS / 3600000)) * MOVEMENT_SCALE;
      const movement = advanceIndexByDistance(
        route,
        bus.index,
        bus.travelDirection,
        tickDistanceKm
      );
      const nextIndex = movement.nextIndex;

      const hitEndBoundary = movement.hitEndBoundary || nextIndex >= maxIndex;
      const hitStartBoundary = movement.hitStartBoundary || nextIndex <= 0;

      if (hitEndBoundary) {
        bus.index = maxIndex;
        bus.location = route[maxIndex];
        bus.travelDirection = -1;
        bus.running = false;
        bus.status = "STOPPED_AT_STOP";
        bus.dwellRemainingSec = Math.max(1, Math.round(Number(TERMINAL_DWELL_SEC) || 5 * 60));
        bus.dwellUntilTs = nowTs + bus.dwellRemainingSec * 1000;
        bus.eta = Math.max(1, Math.round(bus.dwellRemainingSec / 60));
        bus.etaLower = bus.eta;
        bus.etaUpper = bus.eta;
        bus.etaConfidencePlusMinus = 0;
        bus.delayRiskLabel = "ON_TIME";
        bus.delayRiskConfidence = 1;
        bus.predictedDelayMinutes = 0;
        bus.prevDistanceToNextStop = null;
        if (routeStopIds.length) {
          bus.nextStop = isTerminalRouteIndex(lastRouteStopIdx, route.length)
            ? getNextStopIdInSequence(routeStopIds, lastRouteStopId, bus.travelDirection)
            : lastRouteStopId;
        }
        return;
      }

      if (hitStartBoundary) {
        bus.index = 0;
        bus.location = route[0];
        bus.travelDirection = 1;
        bus.running = false;
        bus.status = "STOPPED_AT_STOP";
        bus.dwellRemainingSec = Math.max(1, Math.round(Number(TERMINAL_DWELL_SEC) || 5 * 60));
        bus.dwellUntilTs = nowTs + bus.dwellRemainingSec * 1000;
        bus.eta = Math.max(1, Math.round(bus.dwellRemainingSec / 60));
        bus.etaLower = bus.eta;
        bus.etaUpper = bus.eta;
        bus.etaConfidencePlusMinus = 0;
        bus.delayRiskLabel = "ON_TIME";
        bus.delayRiskConfidence = 1;
        bus.predictedDelayMinutes = 0;
        bus.prevDistanceToNextStop = null;
        if (routeStopIds.length) {
          bus.nextStop = isTerminalRouteIndex(firstRouteStopIdx, route.length)
            ? getNextStopIdInSequence(routeStopIds, firstRouteStopId, bus.travelDirection)
            : firstRouteStopId;
        }
        return;
      }

      bus.index = nextIndex;

      const currIdx = clampIndex(
        bus.travelDirection === -1 ? Math.ceil(bus.index) : Math.floor(bus.index),
        route.length
      );
      bus.location = interpolateRoutePoint(route, bus.index) || route[currIdx];

      const bearingTargetIdx = bus.travelDirection === -1 ? currIdx - 1 : currIdx + 1;
      if (bearingTargetIdx >= 0 && bearingTargetIdx < route.length) {
        bus.bearing = bearing(route[currIdx], route[bearingTargetIdx]);
      }

      let arrivedStop = null;
      let arrivedStopRouteIdx = null;
      if (routeStopIds.length && bus.nextStop) {
        const targetStop = stopById.get(String(bus.nextStop));
        if (!targetStop) {
          bus.nextStop = getNextStopIdInSequence(routeStopIds, bus.nextStop, bus.travelDirection);
        }
        const distanceToTarget =
          targetStop && bus.location ? distance(bus.location, targetStop.location) : Infinity;
        if (distanceToTarget <= STOP_RADIUS_KM) {
          arrivedStop = targetStop;
          arrivedStopRouteIdx = stopRouteIndexMap?.get(String(bus.nextStop)) ?? null;
        } else if (targetStop?.location && stopRouteIndexMap) {
          const targetRouteIdx = stopRouteIndexMap.get(String(bus.nextStop));
          if (Number.isInteger(targetRouteIdx)) {
            const crossedTarget =
              bus.travelDirection === -1 ? currIdx <= targetRouteIdx : currIdx >= targetRouteIdx;
            const withinCorridor = distanceToTarget <= STOP_RADIUS_KM * 3;
            const nearRoutePoint = Math.abs(currIdx - targetRouteIdx) === 0;
            const prevDistance = Number(bus.prevDistanceToNextStop);
            const hasPassedClosestPoint =
              Number.isFinite(prevDistance) &&
              prevDistance <= STOP_RADIUS_KM * 2 &&
              distanceToTarget > prevDistance + 0.001;
            if (crossedTarget && (withinCorridor || hasPassedClosestPoint || nearRoutePoint)) {
              arrivedStop = targetStop;
              arrivedStopRouteIdx = targetRouteIdx;
            }
          }
        }
      } else {
        const nearest = getNearestStop(stops, bus.location);
        arrivedStop = nearest.distanceKm <= STOP_RADIUS_KM ? nearest.stop : null;
      }

      if (arrivedStop) {
        const arrivedStopId = String(arrivedStop._id || arrivedStop.id || "");
        if (Number.isInteger(arrivedStopRouteIdx) && route[arrivedStopRouteIdx]) {
          bus.index = arrivedStopRouteIdx;
          bus.location = route[arrivedStopRouteIdx];
        }
        const terminalStop =
          isTerminalStopId(routeStopIds, arrivedStopId) &&
          isTerminalRouteIndex(arrivedStopRouteIdx, route.length);
        if (terminalStop) {
          if (arrivedStopId === String(routeStopIds[0])) {
            bus.travelDirection = 1;
          } else if (arrivedStopId === String(routeStopIds[routeStopIds.length - 1])) {
            bus.travelDirection = -1;
          }
        }
        const dwellSec = terminalStop
          ? Math.max(1, Math.round(Number(TERMINAL_DWELL_SEC) || 5 * 60))
          : Math.max(1, Math.round(Number(STOP_DWELL_SEC) || 60));
        bus.running = false;
        bus.status = "STOPPED_AT_STOP";
        bus.dwellRemainingSec = dwellSec;
        bus.dwellUntilTs = nowTs + dwellSec * 1000;
        bus.eta = Math.max(1, Math.round(dwellSec / 60));
        bus.etaLower = bus.eta;
        bus.etaUpper = bus.eta;
        bus.etaConfidencePlusMinus = 0;
        bus.delayRiskLabel = "ON_TIME";
        bus.delayRiskConfidence = 1;
        bus.predictedDelayMinutes = 0;
        if (routeStopIds.length) {
          bus.nextStop = getNextStopIdInSequence(routeStopIds, arrivedStopId, bus.travelDirection);
        } else {
          bus.nextStop = arrivedStop._id || arrivedStop.id || null;
        }
        bus.prevDistanceToNextStop = null;
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

      const nextStopNow = stopById.get(String(bus.nextStop || ""));
      const distanceToNextStopNow =
        nextStopNow && bus.location ? distance(bus.location, nextStopNow.location) : null;
      bus.distanceToNextStop = distanceToNextStopNow;
      bus.prevDistanceToNextStop = Number.isFinite(distanceToNextStopNow) ? distanceToNextStopNow : null;

      const remainingKm =
        bus.travelDirection === -1
          ? distanceAlongRoute(route, 0, currIdx)
          : distanceAlongRoute(route, currIdx, route.length - 1);

      let delayFactor = 1;
      let severe = false;
      let nearbyIncidentCount = 0;
      const incidentTypeCounts = {
        Accident: 0,
        "Road Work": 0,
        "Traffic Jam": 0,
        Flood: 0,
        Other: 0
      };
      let closestIncidentType = null;
      let closestIncidentDistanceKm = Infinity;

      incidents.forEach(incident => {
        const d = distance(bus.location, incident.location);
        if (d < closestIncidentDistanceKm) {
          closestIncidentDistanceKm = d;
          closestIncidentType = normalizeIncidentType(incident?.type);
        }
        if (d < 0.3) nearbyIncidentCount += 1;
        if (d < 0.3) {
          const type = normalizeIncidentType(incident?.type);
          incidentTypeCounts[type] = (incidentTypeCounts[type] || 0) + 1;
        }
        if (d < 0.1) severe = true;
        else if (d < 0.3) delayFactor = Math.max(delayFactor, 1.5);
      });

      const externalWeather = getExternalWeather ? getExternalWeather(bus) : null;
      const weekendTrafficImpact = (() => {
        const day = new Date().getUTCDay();
        return day === 0 || day === 6 ? 1.07 : 1;
      })();
      const externalTrafficImpact =
        externalWeather && Number.isFinite(Number(externalWeather.trafficImpact))
          ? Math.max(0.8, Number(externalWeather.trafficImpact)) * weekendTrafficImpact
          : weekendTrafficImpact;

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
      bus.externalHolidayName = null;
      bus.externalHolidayImpact = weekendTrafficImpact;
      bus.closestIncidentType =
        Number.isFinite(closestIncidentDistanceKm) && closestIncidentType
          ? closestIncidentType
          : null;
      bus.closestIncidentDistanceKm =
        Number.isFinite(closestIncidentDistanceKm) ? closestIncidentDistanceKm : null;
      bus.accidentNearby = incidentTypeCounts.Accident || 0;
      bus.roadWorkNearby = incidentTypeCounts["Road Work"] || 0;
      bus.trafficJamNearby = incidentTypeCounts["Traffic Jam"] || 0;
      bus.floodNearby = incidentTypeCounts.Flood || 0;

      const learnedIncidentFactor = predictIncidentFactor
        ? Number(
            predictIncidentFactor({
              bus,
              incidentsNearby: nearbyIncidentCount,
              closestIncidentType: bus.closestIncidentType,
              closestIncidentDistanceKm: bus.closestIncidentDistanceKm,
              accidentNearby: bus.accidentNearby,
              roadWorkNearby: bus.roadWorkNearby,
              trafficJamNearby: bus.trafficJamNearby,
              floodNearby: bus.floodNearby
            })
          )
        : NaN;
      const incidentDelayFactor = Number.isFinite(learnedIncidentFactor)
        ? Math.max(delayFactor, learnedIncidentFactor)
        : delayFactor;
      const effectiveDelayFactor = incidentDelayFactor * externalTrafficImpact;
      bus.trafficFactor = effectiveDelayFactor;
      bus.incidentsNearby = nearbyIncidentCount;

      if (!severe && incidentDelayFactor >= 2.6 && nearbyIncidentCount >= 2) {
        severe = true;
      }

      if (severe) {
        bus.status = "STOPPED";
        bus.eta = null;
        bus.etaLower = null;
        bus.etaUpper = null;
        bus.etaConfidencePlusMinus = null;
        bus.delayRiskLabel = "SEVERE";
        bus.delayRiskConfidence = 1;
        bus.predictedDelayMinutes = null;
        return;
      }

      const dwellNowMin = (bus.dwellRemainingSec || 0) / 60;
      const nextStopDistanceKm = Number.isFinite(distanceToNextStopNow)
        ? Number(distanceToNextStopNow)
        : remainingKm;
      const etaFormulaMin = (nextStopDistanceKm / SPEED_KMPH) * 60 * effectiveDelayFactor + dwellNowMin;
      const etaFeatureInput = {
        timestamp: new Date(),
        distanceToNextStop: Number.isFinite(bus.distanceToNextStop)
          ? bus.distanceToNextStop
          : nextStopDistanceKm,
        dwellTime: bus.dwellRemainingSec || 0,
        incidentsNearby: bus.incidentsNearby || 0,
        trafficFactor: effectiveDelayFactor,
        externalTempC: bus.externalTempC,
        externalPrecipMm: bus.externalPrecipMm,
        externalWindSpeedKph: bus.externalWindSpeedKph,
        externalWeatherSeverity: bus.externalWeatherSeverity,
        externalTrafficImpact: bus.externalTrafficImpact || 1,
        eta: etaFormulaMin
      };
      const etaPredicted = predictEta ? predictEta(bus, etaFeatureInput) : null;
      const usePredictedEta =
        Number.isFinite(etaPredicted) &&
        etaPredicted >= Math.max(0, etaFormulaMin * 0.5) &&
        etaPredicted <= Math.max(6, etaFormulaMin * 1.8);
      const etaMin = usePredictedEta
        ? etaFormulaMin * 0.7 + Number(etaPredicted) * 0.3
        : etaFormulaMin;
      const hasOperationalDelay = nearbyIncidentCount > 0;
      bus.status = hasOperationalDelay ? "DELAYED" : "ON_TIME";
      bus.eta = Math.max(0, Math.round(etaMin));

      const etaRange = predictEtaRange ? predictEtaRange(bus, etaFeatureInput, etaMin) : null;
      if (etaRange && Number.isFinite(etaRange.lower) && Number.isFinite(etaRange.upper)) {
        bus.etaLower = Math.max(0, Math.round(etaRange.lower));
        bus.etaUpper = Math.max(bus.etaLower, Math.round(etaRange.upper));
        bus.etaConfidencePlusMinus = Math.max(0, Math.round(etaRange.plusMinus || 0));
      } else {
        bus.etaLower = null;
        bus.etaUpper = null;
        bus.etaConfidencePlusMinus = null;
      }

      const delayRisk = predictDelayRisk ? predictDelayRisk(bus, etaFeatureInput) : null;
      if (delayRisk?.label) {
        bus.delayRiskLabel = delayRisk.label;
        bus.delayRiskConfidence = Number.isFinite(delayRisk.confidence)
          ? Math.max(0, Math.min(1, delayRisk.confidence))
          : null;
      } else {
        bus.delayRiskLabel = nearbyIncidentCount > 0 ? "DELAYED" : "ON_TIME";
        bus.delayRiskConfidence = null;
      }
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
          isWeekend: (() => {
            const day = new Date().getUTCDay();
            return day === 0 || day === 6 ? 1 : 0;
          })(),
          externalHolidayName: bus.externalHolidayName || null,
          externalHolidayImpact: bus.externalHolidayImpact || 1,
          closestIncidentType: bus.closestIncidentType || null,
          closestIncidentDistanceKm: bus.closestIncidentDistanceKm ?? null,
          accidentNearby: bus.accidentNearby || 0,
          roadWorkNearby: bus.roadWorkNearby || 0,
          trafficJamNearby: bus.trafficJamNearby || 0,
          floodNearby: bus.floodNearby || 0,
          actualETAT: bus.status === "STOPPED_AT_STOP" ? new Date() : null,
          eta: bus.eta,
          etaLower: bus.etaLower ?? null,
          etaUpper: bus.etaUpper ?? null,
          etaConfidencePlusMinus: bus.etaConfidencePlusMinus ?? null,
          delayRiskLabel: bus.delayRiskLabel || null,
          delayRiskConfidence: bus.delayRiskConfidence ?? null,
          predictedDelayMinutes: bus.predictedDelayMinutes ?? null,
          clusterId: bus.clusterId ?? null,
          mappedLabel: bus.mappedLabel || null,
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
