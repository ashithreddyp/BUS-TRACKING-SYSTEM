import {
  bestMatchScore,
  normalizeSearchText,
  sanitizeStopName
} from "./appHelpers";

export function buildVisibleBoundaryMarkers({
  passengerMode,
  passengerFocusedRouteIds = [],
  passengerRoutesCatalog = [],
  adminBoundaryRouteContext = null
}) {
  const buildMarkerEntry = route => {
    const routeId = String(route?._id || route?.id || "");
    const points = (route?.polyline || [])
      .map(point => [Number(point?.lat), Number(point?.lng)])
      .filter(point => Number.isFinite(point[0]) && Number.isFinite(point[1]));
    if (points.length < 2) return [];

    const routeStops = Array.isArray(route?.stops) ? route.stops : [];
    const startStopRef = routeStops[0] || null;
    const endStopRef = routeStops[routeStops.length - 1] || null;
    const startStopId = String(startStopRef?._id || startStopRef?.id || startStopRef || "");
    const endStopId = String(endStopRef?._id || endStopRef?.id || endStopRef || "");
    const routeNumber = String(route?.routeNumber || "");

    return [
      {
        key: `${routeId || routeNumber || "route"}:start`,
        routeId,
        routeNumber,
        boundaryType: "start",
        position: points[0],
        stopId: startStopId,
        name: route?.startPointName || "Start Point"
      },
      {
        key: `${routeId || routeNumber || "route"}:end`,
        routeId,
        routeNumber,
        boundaryType: "end",
        position: points[points.length - 1],
        stopId: endStopId,
        name: route?.endPointName || "End Point"
      }
    ];
  };

  if (passengerMode) {
    const ids = (passengerFocusedRouteIds || []).map(String).filter(Boolean);
    if (!ids.length) return [];
    return ids.flatMap(id => {
      const route = passengerRoutesCatalog.find(item => String(item?._id || "") === id);
      return route ? buildMarkerEntry(route) : [];
    });
  }

  return adminBoundaryRouteContext ? buildMarkerEntry(adminBoundaryRouteContext) : [];
}

export function findSelectedBoundaryMarker({
  selectedBoundaryPoint,
  selectedBoundaryRouteId,
  visibleBoundaryMarkers = []
}) {
  if (!selectedBoundaryPoint) return null;
  if (selectedBoundaryRouteId) {
    return (
      visibleBoundaryMarkers.find(
        marker =>
          marker.boundaryType === selectedBoundaryPoint &&
          String(marker.routeId || "") === String(selectedBoundaryRouteId)
      ) || null
    );
  }
  return (
    visibleBoundaryMarkers.find(marker => marker.boundaryType === selectedBoundaryPoint) || null
  );
}

export function buildPassengerSearchResults({
  query,
  buses = [],
  stops = [],
  passengerRoutesCatalog = []
}) {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return [];

  const queryWithoutBusPrefix = normalizedQuery.replace(/^bus\s+/, "").trim();
  const isBusKeywordQuery = normalizedQuery === "bus" || normalizedQuery.startsWith("bus ");
  const routeNumbersByStopId = new Map();

  passengerRoutesCatalog.forEach(route => {
    const routeNumber = String(route?.routeNumber || "").trim();
    if (!routeNumber) return;
    (route?.stops || []).forEach(stopRef => {
      const stopId = String(stopRef?._id || stopRef?.id || stopRef || "").trim();
      if (!stopId) return;
      const set = routeNumbersByStopId.get(stopId) || new Set();
      set.add(routeNumber);
      routeNumbersByStopId.set(stopId, set);
    });
  });

  const ranked = [];

  buses.forEach(bus => {
    const busId = String(bus.id || "").trim();
    if (!busId) return;
    const normalizedBusId = normalizeSearchText(busId);
    const score =
      (isBusKeywordQuery && !queryWithoutBusPrefix
        ? 0
        : bestMatchScore(normalizedQuery, [`bus ${normalizedBusId}`, normalizedBusId])) ??
      (queryWithoutBusPrefix ? bestMatchScore(queryWithoutBusPrefix, [normalizedBusId]) : null);
    if (score == null) return;
    ranked.push({
      type: "bus",
      id: busId,
      label: busId,
      status: bus.status || "ON_TIME",
      score,
      typePriority: 0
    });
  });

  stops.forEach(stop => {
    const stopId = String(stop.id || stop._id || "");
    if (!stopId) return;
    const baseName = sanitizeStopName(stop.name) || "Unnamed Stop";
    const routeNumbers = [...(routeNumbersByStopId.get(stopId) || [])].sort();
    const routeSuffix =
      routeNumbers.length > 0
        ? ` (${routeNumbers.slice(0, 2).join(", ")}${routeNumbers.length > 2 ? `, +${routeNumbers.length - 2}` : ""})`
        : "";
    const label = `${baseName}${routeSuffix}`;
    const normalizedLabel = normalizeSearchText(label);
    const normalizedStopId = normalizeSearchText(stopId);
    const normalizedRouteNumbers = routeNumbers.map(rn => normalizeSearchText(rn));
    const score = bestMatchScore(normalizedQuery, [
      `stop ${normalizedLabel}`,
      normalizedLabel,
      normalizedStopId,
      ...normalizedRouteNumbers
    ]);
    if (score == null) return;
    ranked.push({
      type: "stop",
      id: stopId,
      label,
      score,
      typePriority: 1
    });
  });

  passengerRoutesCatalog.forEach(route => {
    const routeId = String(route?._id || "").trim();
    const routeNumber = String(route?.routeNumber || "").trim();
    if (!routeId) return;
    const boundaryRows = [
      {
        type: "boundary-start",
        label: `${route?.startPointName || "Start Point"}${routeNumber ? ` (${routeNumber})` : ""}`
      },
      {
        type: "boundary-end",
        label: `${route?.endPointName || "End Point"}${routeNumber ? ` (${routeNumber})` : ""}`
      }
    ];

    boundaryRows.forEach(row => {
      const normalizedLabel = normalizeSearchText(row.label);
      const score = bestMatchScore(normalizedQuery, [
        normalizedLabel,
        `route ${normalizeSearchText(routeNumber)} ${normalizedLabel}`,
        `${row.type === "boundary-start" ? "start" : "end"} ${normalizedLabel}`
      ]);
      if (score == null) return;
      ranked.push({
        type: row.type,
        id: routeId,
        label: row.label,
        score,
        typePriority: 2
      });
    });
  });

  return ranked
    .sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score;
      if (a.typePriority !== b.typePriority) return a.typePriority - b.typePriority;
      return String(a.label).localeCompare(String(b.label));
    })
    .slice(0, 12)
    .map(({ score, typePriority, ...item }) => item);
}
