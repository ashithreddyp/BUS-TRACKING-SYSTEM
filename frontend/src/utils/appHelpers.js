import { STOP_REUSE_RADIUS_METERS } from "../constants/appConstants";

export function placeLabel(place, fallback) {
  const display = String(place?.display_name || "").trim();
  if (!display) return fallback;
  return display.split(",")[0].trim() || fallback;
}

export function createEmptyRouteBuilder() {
  return {
    routeNumber: "",
    routeName: "",
    startPointName: "",
    endPointName: "",
    stops: [],
    polyline: [],
    assignedBuses: []
  };
}

export function resolveStopId(stopRef) {
  return String(stopRef?._id || stopRef?.id || stopRef || "");
}

export function resolveBoundaryStopId(route, boundaryType) {
  const routeStops = Array.isArray(route?.stops) ? route.stops : [];
  if (!routeStops.length) return null;
  const boundaryStop =
    boundaryType === "start" ? routeStops[0] : routeStops[routeStops.length - 1];
  const stopId = resolveStopId(boundaryStop);
  return stopId || null;
}

export function distanceMeters(a, b) {
  if (!a || !b) return Number.POSITIVE_INFINITY;
  const lat1 = Number(a.lat);
  const lng1 = Number(a.lng);
  const lat2 = Number(b.lat);
  const lng2 = Number(b.lng);
  if (![lat1, lng1, lat2, lng2].every(Number.isFinite)) return Number.POSITIVE_INFINITY;

  const toRad = v => (v * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const sa = Math.sin(dLat / 2);
  const sb = Math.sin(dLng / 2);
  const h =
    sa * sa +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * sb * sb;
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  return 6371000 * c;
}

export function findNearbyExistingStop(point, stopList, maxMeters = STOP_REUSE_RADIUS_METERS) {
  let best = null;
  (Array.isArray(stopList) ? stopList : []).forEach(stop => {
    const d = distanceMeters(point, stop?.location);
    if (!Number.isFinite(d) || d > maxMeters) return;
    if (!best || d < best.distanceMeters) {
      best = { stop, distanceMeters: d };
    }
  });
  return best;
}

export function sanitizeStopName(name) {
  const raw = String(name || "").trim();
  if (!raw) return "";
  return raw.replace(/\s*\([a-f0-9]{4}\)\s*$/i, "").trim();
}

export function normalizeSearchText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function matchScore(query, target) {
  if (!query || !target) return null;
  if (target === query) return 0;
  if (target.startsWith(query)) return 1;
  const words = target.split(" ").filter(Boolean);
  if (words.some(word => word.startsWith(query))) return 2;
  if (target.includes(query)) return 3;
  return null;
}

export function bestMatchScore(query, targets) {
  let best = null;
  (targets || []).forEach(target => {
    const score = matchScore(query, target);
    if (score == null) return;
    if (best == null || score < best) best = score;
  });
  return best;
}

export function parseOsrmRoutes(data) {
  return (data?.routes || []).map(route =>
    (route?.geometry?.coordinates || []).map(([lng, lat]) => [lat, lng])
  );
}

export function getStatusClassName(status) {
  const value = String(status || "").toUpperCase();
  if (value.includes("DELAY")) return "delay";
  if (value.includes("STOP")) return "stop";
  return "on";
}

export function formatStatusLabel(status) {
  return String(status || "ON_TIME").replaceAll("_", " ");
}

export function formatRouteBusEtaLabel(arrival, routeLabelOverride = null) {
  const routeLabel = String(routeLabelOverride || arrival?.routeNumber || arrival?.routeId || "").trim();
  const busId = String(arrival?.busId || "").trim();
  const etaText = `${Number.isFinite(Number(arrival?.eta)) ? Math.max(0, Math.round(Number(arrival.eta))) : "-"} min`;
  const directionRaw = String(arrival?.direction || "").trim().toUpperCase();
  const directionText = directionRaw === "DOWN" || directionRaw === "UP" ? ` (${directionRaw})` : "";
  const sameRouteAndBus =
    routeLabel &&
    busId &&
    routeLabel.toLowerCase() === busId.toLowerCase();
  if (sameRouteAndBus) return `${routeLabel} - ${etaText}${directionText}`;
  if (routeLabel && busId) return `${routeLabel} / ${busId} - ${etaText}${directionText}`;
  if (busId) return `${busId} - ${etaText}${directionText}`;
  if (routeLabel) return `${routeLabel} - ${etaText}${directionText}`;
  return etaText;
}
