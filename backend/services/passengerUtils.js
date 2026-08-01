function toObjectIdString(v) {
  return v == null ? null : String(v);
}

async function getRouteNumberByIdMap(RouteModel) {
  const routeDocs = await RouteModel.find({}, { _id: 1, routeNumber: 1 }).lean();
  return new Map(routeDocs.map(r => [String(r._id), r.routeNumber]));
}

function normalizeBusLive(bus, routeNumberById) {
  const routeIdStr = toObjectIdString(bus.routeId);
  return {
    ...bus,
    id: String(bus.id || bus._id),
    routeId: routeIdStr,
    routeNumber: routeIdStr ? routeNumberById.get(routeIdStr) || null : null,
    nextStop: toObjectIdString(bus.nextStop || null)
  };
}

function distanceKm(a, b) {
  const latA = Number(a?.lat);
  const lngA = Number(a?.lng);
  const latB = Number(b?.lat);
  const lngB = Number(b?.lng);
  if (![latA, lngA, latB, lngB].every(Number.isFinite)) return null;

  const toRad = value => (value * Math.PI) / 180;
  const earthRadiusKm = 6371;
  const dLat = toRad(latB - latA);
  const dLng = toRad(lngB - lngA);
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(latA)) * Math.cos(toRad(latB)) * Math.sin(dLng / 2) ** 2;
  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function buildStopTimeline(stopsList, busesList) {
  const STOP_HOP_MIN = 2;
  const AVG_SPEED_KMPH = Math.max(8, Number(process.env.SIM_SPEED_KMPH || 30) || 30);
  const STOP_DWELL_MIN = Math.max(
    0,
    Math.round((Number(process.env.STOP_DWELL_SEC || 60) || 0) / 60)
  );
  const TERMINAL_DWELL_MIN = Math.max(
    0,
    Math.round((Number(process.env.TERMINAL_DWELL_SEC || 5 * 60) || 0) / 60)
  );
  const stopIdToIndex = new Map(stopsList.map((s, idx) => [String(s._id), idx]));
  const timeline = stopsList.map((stop, idx) => ({
    stopId: String(stop._id),
    stopName: stop.name || null,
    sequence: idx + 1,
    arrivals: []
  }));

  const addArrival = (stopIdx, arrival) => {
    if (stopIdx < 0 || stopIdx >= timeline.length) return;
    const etaValue = Math.max(0, Math.round(arrival.eta || 0));
    const etaOffset = etaValue - Math.max(0, Math.round(arrival.baseEta || etaValue));
    const etaLowerBase = Number.isFinite(Number(arrival.etaLower))
      ? Math.max(0, Math.round(Number(arrival.etaLower)))
      : null;
    const etaUpperBase = Number.isFinite(Number(arrival.etaUpper))
      ? Math.max(0, Math.round(Number(arrival.etaUpper)))
      : null;
    timeline[stopIdx].arrivals.push({
      busId: arrival.busId,
      routeNumber: arrival.routeNumber,
      status: arrival.status,
      direction: arrival.direction,
      eta: etaValue,
      etaLower: etaLowerBase == null ? null : Math.max(0, etaLowerBase + etaOffset),
      etaUpper: etaUpperBase == null ? null : Math.max(0, etaUpperBase + etaOffset),
      delayRiskLabel: arrival.delayRiskLabel || null,
      delayRiskConfidence: Number.isFinite(Number(arrival.delayRiskConfidence))
        ? Number(arrival.delayRiskConfidence)
        : null
    });
  };

  const dwellAt = stopIdx => {
    if (stopIdx < 0 || stopIdx >= timeline.length) return 0;
    if (stopIdx === 0 || stopIdx === timeline.length - 1) return TERMINAL_DWELL_MIN;
    return STOP_DWELL_MIN;
  };

  const legTravelMin = (fromIdx, toIdx) => {
    if (fromIdx < 0 || toIdx < 0 || fromIdx >= stopsList.length || toIdx >= stopsList.length) {
      return STOP_HOP_MIN;
    }
    const km = distanceKm(stopsList[fromIdx]?.location, stopsList[toIdx]?.location);
    if (!Number.isFinite(km)) return STOP_HOP_MIN;
    return Math.max(1, Math.min(18, Math.round((km / AVG_SPEED_KMPH) * 60)));
  };

  const projectEtaBetween = (fromIdx, toIdx, startEta) => {
    if (fromIdx === toIdx) return startEta;
    const step = fromIdx < toIdx ? 1 : -1;
    let eta = startEta;
    let idx = fromIdx;
    while (idx !== toIdx) {
      eta += dwellAt(idx);
      const nextIdx = idx + step;
      eta += legTravelMin(idx, nextIdx);
      idx = nextIdx;
    }
    return eta;
  };

  const estimateCurrentStopIdx = bus => {
    if (bus.status !== "STOPPED_AT_STOP" || !bus.location) return null;
    let bestIndex = null;
    let bestScore = Infinity;
    stopsList.forEach((stop, index) => {
      const latA = Number(stop?.location?.lat);
      const lngA = Number(stop?.location?.lng);
      const latB = Number(bus?.location?.lat);
      const lngB = Number(bus?.location?.lng);
      if (![latA, lngA, latB, lngB].every(Number.isFinite)) return;
      const score = (latA - latB) ** 2 + (lngA - lngB) ** 2;
      if (score < bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    });
    return bestIndex;
  };

  for (const bus of busesList) {
    if (bus.eta == null || !bus.nextStop) continue;
    const nextIdx = stopIdToIndex.get(String(bus.nextStop));
    if (nextIdx == null) continue;
    const baseEta = Math.max(0, Number(bus.eta) || 0);
    const lastIdx = timeline.length - 1;
    const currentStopIdx = estimateCurrentStopIdx(bus);
    const nextArrivalEta =
      currentStopIdx != null && currentStopIdx !== nextIdx
        ? baseEta + legTravelMin(currentStopIdx, nextIdx)
        : baseEta;

    const direction = Number(bus.travelDirection) === -1 ? "DOWN" : "UP";
    for (let stopIdx = 0; stopIdx < timeline.length; stopIdx++) {
      let etaValue = null;
      let arrivalDirection = direction;

      if (currentStopIdx != null && stopIdx === currentStopIdx) {
        etaValue = 0;
      } else if (direction === "UP") {
        if (stopIdx >= nextIdx) {
          etaValue = projectEtaBetween(nextIdx, stopIdx, nextArrivalEta);
          arrivalDirection = "UP";
        } else {
          const terminalEta = projectEtaBetween(nextIdx, lastIdx, nextArrivalEta);
          etaValue = projectEtaBetween(lastIdx, stopIdx, terminalEta + TERMINAL_DWELL_MIN);
          arrivalDirection = "DOWN";
        }
      } else {
        if (stopIdx <= nextIdx) {
          etaValue = projectEtaBetween(nextIdx, stopIdx, nextArrivalEta);
          arrivalDirection = "DOWN";
        } else {
          const terminalEta = projectEtaBetween(nextIdx, 0, nextArrivalEta);
          etaValue = projectEtaBetween(0, stopIdx, terminalEta + TERMINAL_DWELL_MIN);
          arrivalDirection = "UP";
        }
      }

      if (!Number.isFinite(etaValue)) continue;
      addArrival(stopIdx, {
        busId: bus.id,
        routeNumber: bus.routeNumber,
        status: bus.status,
        direction: arrivalDirection,
        eta: etaValue,
        baseEta,
        etaLower: bus.etaLower,
        etaUpper: bus.etaUpper,
        delayRiskLabel: bus.delayRiskLabel,
        delayRiskConfidence: bus.delayRiskConfidence
      });
    }
  }

  timeline.forEach(t => t.arrivals.sort((a, b) => (a.eta ?? Infinity) - (b.eta ?? Infinity)));
  return timeline;
}

function buildStopArrivalsForStop(stopId, routesList, busesList) {
  const targetStopId = String(stopId || "");
  if (!targetStopId) return [];

  const arrivals = [];
  (Array.isArray(routesList) ? routesList : []).forEach(routeDoc => {
    const routeId = String(routeDoc?._id || "");
    const routeNumber = routeDoc?.routeNumber || null;
    const routeStops = Array.isArray(routeDoc?.stops) ? routeDoc.stops : [];
    if (!routeId || !routeStops.length) return;

    const servesTargetStop = routeStops.some(
      stopRef => String(stopRef?._id || stopRef?.id || stopRef || "") === targetStopId
    );
    if (!servesTargetStop) return;

    const routeBuses = (Array.isArray(busesList) ? busesList : []).filter(
      bus => String(bus?.routeId || "") === routeId
    );
    if (!routeBuses.length) return;

    const timeline = buildStopTimeline(routeStops, routeBuses);
    const stopEntry =
      timeline.find(entry => String(entry?.stopId || "") === targetStopId) || null;
    const stopArrivals = Array.isArray(stopEntry?.arrivals) ? stopEntry.arrivals : [];

    stopArrivals.forEach(arrival => {
      arrivals.push({
        ...arrival,
        routeId,
        routeNumber: arrival.routeNumber || routeNumber || null,
        stopId: targetStopId
      });
    });
  });

  return arrivals.sort((a, b) => (a.eta ?? Infinity) - (b.eta ?? Infinity));
}

module.exports = {
  toObjectIdString,
  getRouteNumberByIdMap,
  normalizeBusLive,
  buildStopTimeline,
  buildStopArrivalsForStop
};
