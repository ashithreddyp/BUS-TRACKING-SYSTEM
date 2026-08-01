import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";
import {
  CircleMarker,
  MapContainer,
  Marker,
  Polyline,
  Popup,
  TileLayer,
  ZoomControl
} from "react-leaflet";
import "leaflet/dist/leaflet.css";
import "leaflet-rotatedmarker";

import "./App.css";
import RouteTimeline from "./pages/RouteTimeline";
import IncidentClicker from "./components/map/IncidentClicker";
import FollowBus from "./components/map/FollowBus";
import FocusPolyline from "./components/map/FocusPolyline";
import BusMarker from "./components/map/BusMarker";
import FloatingHud from "./components/ui/FloatingHud";
import MapLegend from "./components/ui/MapLegend";
import { incidentIcons, stopIcon, startPointIcon, endPointIcon } from "./components/map/icons";
import normalizeBus from "./utils/normalizeBus";

const socket = io("http://localhost:5000");
const THEME_STORAGE_KEY = "theme_mode";
const MODE_STORAGE_KEY = "portal_mode";
const STOP_REUSE_RADIUS_METERS = 25;

async function searchPlaces(q, signal) {
  if (q.length < 3) return [];
  const response = await fetch(`http://localhost:5000/search?q=${q}`, { signal });
  return response.json();
}

function placeLabel(place, fallback) {
  const display = String(place?.display_name || "").trim();
  if (!display) return fallback;
  return display.split(",")[0].trim() || fallback;
}

function createEmptyRouteBuilder() {
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

function resolveStopId(stopRef) {
  return String(stopRef?._id || stopRef?.id || stopRef || "");
}

function resolveBoundaryStopId(route, boundaryType) {
  const routeStops = Array.isArray(route?.stops) ? route.stops : [];
  if (!routeStops.length) return null;
  const boundaryStop =
    boundaryType === "start" ? routeStops[0] : routeStops[routeStops.length - 1];
  const stopId = resolveStopId(boundaryStop);
  return stopId || null;
}

function distanceMeters(a, b) {
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

function findNearbyExistingStop(point, stopList, maxMeters = STOP_REUSE_RADIUS_METERS) {
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

function sanitizeStopName(name) {
  const raw = String(name || "").trim();
  if (!raw) return "";
  return raw.replace(/\s*\([a-f0-9]{4}\)\s*$/i, "").trim();
}

function normalizeSearchText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function matchScore(query, target) {
  if (!query || !target) return null;
  if (target === query) return 0;
  if (target.startsWith(query)) return 1;
  const words = target.split(" ").filter(Boolean);
  if (words.some(word => word.startsWith(query))) return 2;
  if (target.includes(query)) return 3;
  return null;
}

function bestMatchScore(query, targets) {
  let best = null;
  (targets || []).forEach(target => {
    const score = matchScore(query, target);
    if (score == null) return;
    if (best == null || score < best) best = score;
  });
  return best;
}

function parseOsrmRoutes(data) {
  return (data?.routes || []).map(route =>
    (route?.geometry?.coordinates || []).map(([lng, lat]) => [lat, lng])
  );
}

export default function App() {
  const [startQuery, setStartQuery] = useState("");
  const [endQuery, setEndQuery] = useState("");
  const [startResults, setStartResults] = useState([]);
  const [endResults, setEndResults] = useState([]);
  const [activeSearch, setActiveSearch] = useState(null);
  const [startPlace, setStartPlace] = useState(null);
  const [endPlace, setEndPlace] = useState(null);

  const [routes, setRoutes] = useState([]);
  const [activeRouteIndex, setActiveRouteIndex] = useState(0);
  const [selectedRouteIndex, setSelectedRouteIndex] = useState(0);
  const [routePopup, setRoutePopup] = useState(null);

  const [buses, setBuses] = useState([]);
  const [incidents, setIncidents] = useState([]);
  const [stops, setStops] = useState([]);
  const [incidentType, setIncidentType] = useState("Accident");
  const [addingIncident, setAddingIncident] = useState(false);
  const [addingStop, setAddingStop] = useState(false);

  const [darkMode, setDarkMode] = useState(() => {
    const savedTheme = localStorage.getItem(THEME_STORAGE_KEY);
    if (savedTheme === "dark") return true;
    if (savedTheme === "light") return false;
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  });
  const [selectedBus, setSelectedBus] = useState("");
  const [followBus, setFollowBus] = useState(null);
  const [newBusId, setNewBusId] = useState("");

  const [token, setToken] = useState(localStorage.getItem("token") || "");
  const [showLogin, setShowLogin] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState(null);
  const [mlStatus, setMlStatus] = useState({ enabled: false, trainedAt: null, samples: 0 });
  const [incidentPromptQueue, setIncidentPromptQueue] = useState([]);

  const [passengerMode, setPassengerMode] = useState(() => {
    const savedMode = localStorage.getItem(MODE_STORAGE_KEY);
    const hasToken = !!localStorage.getItem("token");
    if (savedMode === "admin") return hasToken ? false : true;
    if (savedMode === "passenger") return true;
    return true;
  });
  const [selectedPassengerRoute, setSelectedPassengerRoute] = useState(null);
  const [passengerOverlayOpen, setPassengerOverlayOpen] = useState(true);
  const [selectedStop, setSelectedStop] = useState(null);
  const [selectedBoundaryPoint, setSelectedBoundaryPoint] = useState(null);
  const [passengerSearchQuery, setPassengerSearchQuery] = useState("");
  const [passengerRoutesCatalog, setPassengerRoutesCatalog] = useState([]);
  const [stopPopupArrivalById, setStopPopupArrivalById] = useState({});
  const [adminRoutes, setAdminRoutes] = useState([]);
  const [selectedAdminRouteNumber, setSelectedAdminRouteNumber] = useState("");
  const [routeBuilder, setRouteBuilder] = useState(createEmptyRouteBuilder());
  const [routeDrawMode, setRouteDrawMode] = useState(false);
  const [routeBusCandidate, setRouteBusCandidate] = useState("");
  const [routeRevisions, setRouteRevisions] = useState([]);
  const [dragStopIndex, setDragStopIndex] = useState(null);
  const [dragOverStopIndex, setDragOverStopIndex] = useState(null);
  const [existingStopCandidate, setExistingStopCandidate] = useState("");
  const [pendingStopPoint, setPendingStopPoint] = useState(null);
  const [pendingStopName, setPendingStopName] = useState("");
  const [pendingExistingStop, setPendingExistingStop] = useState(null);
  const stopMarkerRefs = useRef(new Map());
  const startBoundaryMarkerRef = useRef(null);
  const endBoundaryMarkerRef = useRef(null);
  const placeSearchCacheRef = useRef(new Map());
  const routeCacheRef = useRef(new Map());
  const routeAbortRef = useRef(null);
  const routeRequestSeqRef = useRef(0);
  const incidentPrompt = incidentPromptQueue[0] || null;

  const selectedRoutePolyline = useMemo(() => {
    if (!selectedPassengerRoute?.polyline?.length) return [];
    return selectedPassengerRoute.polyline.map(p => [p.lat, p.lng]);
  }, [selectedPassengerRoute]);

  const focusPolylinePositions = useMemo(() => {
    if (passengerMode) {
      return selectedRoutePolyline.length ? selectedRoutePolyline : [];
    }
    return selectedRoutePolyline.length ? selectedRoutePolyline : routes[activeRouteIndex] || [];
  }, [activeRouteIndex, passengerMode, routes, selectedRoutePolyline]);

  const selectedRouteBuses = useMemo(() => {
    if (!selectedPassengerRoute?._id) return [];
    return buses.filter(b => String(b.routeId || "") === String(selectedPassengerRoute._id));
  }, [buses, selectedPassengerRoute]);

  const selectedRouteStopIds = useMemo(
    () =>
      new Set(
        (selectedPassengerRoute?.stops || []).map(stop =>
          String(stop?._id || stop?.id || stop || "")
        )
      ),
    [selectedPassengerRoute]
  );

  const stopRouteCountById = useMemo(() => {
    const routeSetByStopId = new Map();
    passengerRoutesCatalog.forEach(route => {
      const routeKey = String(route?.routeNumber || route?._id || "");
      if (!routeKey) return;
      (route?.stops || []).forEach(stopRef => {
        const stopId = String(stopRef?._id || stopRef?.id || stopRef || "");
        if (!stopId) return;
        const existing = routeSetByStopId.get(stopId) || new Set();
        existing.add(routeKey);
        routeSetByStopId.set(stopId, existing);
      });
    });

    const counts = new Map();
    routeSetByStopId.forEach((routeSet, stopId) => {
      counts.set(stopId, routeSet.size);
    });
    return counts;
  }, [passengerRoutesCatalog]);

  const adminRoutePolylines = useMemo(
    () =>
      adminRoutes
        .map(route => ({
          route,
          positions: (route.polyline || [])
            .map(point => [Number(point?.lat), Number(point?.lng)])
            .filter(point => Number.isFinite(point[0]) && Number.isFinite(point[1]))
        }))
        .filter(entry => entry.positions.length > 1),
    [adminRoutes]
  );

  const selectedBusNextStopMarker = useMemo(() => {
    const bus = buses.find(b => b.id === selectedBus);
    if (!bus?.nextStop) return null;
    const stop = stops.find(s => String(s.id || s._id) === String(bus.nextStop));
    return stop?.location || null;
  }, [buses, selectedBus, stops]);

  const selectedAdminRoute = useMemo(() => {
    if (!selectedAdminRouteNumber) return null;
    return adminRoutes.find(route => route.routeNumber === selectedAdminRouteNumber) || null;
  }, [adminRoutes, selectedAdminRouteNumber]);

  const activeRouteForStopMarkers = useMemo(() => {
    if (passengerMode) return selectedPassengerRoute || null;
    return selectedAdminRoute;
  }, [passengerMode, selectedAdminRoute, selectedPassengerRoute]);

  const boundaryRoutePoints = useMemo(() => {
    const points = (activeRouteForStopMarkers?.polyline || [])
      .map(point => ({ lat: Number(point?.lat), lng: Number(point?.lng) }))
      .filter(point => Number.isFinite(point.lat) && Number.isFinite(point.lng));
    if (!points.length) return null;

    const routeStops = activeRouteForStopMarkers?.stops || [];
    const getStopId = stopRef => String(stopRef?._id || stopRef?.id || stopRef || "");
    const startStopId = routeStops.length ? getStopId(routeStops[0]) || null : null;
    const endStopId = routeStops.length ? getStopId(routeStops[routeStops.length - 1]) || null : null;

    return {
      startPosition: [points[0].lat, points[0].lng],
      endPosition: [points[points.length - 1].lat, points[points.length - 1].lng],
      startStopId,
      endStopId,
      startName: activeRouteForStopMarkers?.startPointName || "Start Point",
      endName: activeRouteForStopMarkers?.endPointName || "End Point"
    };
  }, [activeRouteForStopMarkers]);

  const passengerSearchResults = useMemo(() => {
    const query = normalizeSearchText(passengerSearchQuery);
    if (!query) return [];

    const queryWithoutBusPrefix = query.replace(/^bus\s+/, "").trim();
    const isBusKeywordQuery = query === "bus" || query.startsWith("bus ");
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
          : bestMatchScore(query, [`bus ${normalizedBusId}`, normalizedBusId])) ??
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
      const score = bestMatchScore(query, [
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
      const boundaryRows = [];
      if (route?.startPointName) {
        boundaryRows.push({
          type: "boundary-start",
          label: `${route.startPointName} (${routeNumber})`
        });
      }
      if (route?.endPointName) {
        boundaryRows.push({
          type: "boundary-end",
          label: `${route.endPointName} (${routeNumber})`
        });
      }

      boundaryRows.forEach(row => {
        const normalizedLabel = normalizeSearchText(row.label);
        const score = bestMatchScore(query, [
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
  }, [buses, passengerRoutesCatalog, passengerSearchQuery, stops]);

  const getStatusClassName = status => {
    const value = String(status || "").toUpperCase();
    if (value.includes("DELAY")) return "delay";
    if (value.includes("STOP")) return "stop";
    return "on";
  };

  const findRouteForBus = useCallback(busId => {
    const bus = buses.find(b => String(b.id) === String(busId));
    if (!bus?.routeId) return null;
    return (
      passengerRoutesCatalog.find(route => String(route._id) === String(bus.routeId)) || null
    );
  }, [buses, passengerRoutesCatalog]);

  const findRouteForStop = useCallback(stopId => {
    const targetStopId = String(stopId);
    if (selectedPassengerRoute) {
      const inSelected = (selectedPassengerRoute.stops || []).some(
        stop => String(stop?._id || stop?.id || stop) === targetStopId
      );
      if (inSelected) return selectedPassengerRoute;
    }
    return (
      passengerRoutesCatalog.find(route =>
        (route.stops || []).some(stop => String(stop?._id || stop?.id || stop) === targetStopId)
      ) || null
    );
  }, [passengerRoutesCatalog, selectedPassengerRoute]);

  const pickDirectionalArrivals = useCallback(rows => {
    const list = Array.isArray(rows) ? rows : [];
    const normalized = list
      .filter(row => row && Number.isFinite(row.eta))
      .sort((a, b) => (a.eta ?? Infinity) - (b.eta ?? Infinity));
    const isDown = row =>
      String(row?.direction || "").toUpperCase() === "DOWN" ||
      Number(row?.travelDirection) === -1;
    const isUp = row =>
      String(row?.direction || "").toUpperCase() === "UP" ||
      Number(row?.travelDirection) === 1 ||
      (!String(row?.direction || "").trim() && Number(row?.travelDirection) !== -1);
    return {
      up: normalized.find(isUp) || null,
      down: normalized.find(isDown) || null
    };
  }, []);

  const buildRouteArrivalGroups = useCallback(rows => {
    const grouped = new Map();
    (Array.isArray(rows) ? rows : []).forEach(row => {
      if (!row || !Number.isFinite(row.eta)) return;
      const routeLabel = String(row.routeNumber || row.routeId || "Route");
      if (!grouped.has(routeLabel)) grouped.set(routeLabel, []);
      grouped.get(routeLabel).push({
        busId: row.busId || "-",
        eta: row.eta,
        direction:
          String(row.direction || "").toUpperCase() === "DOWN" ||
          Number(row.travelDirection) === -1
            ? "DOWN"
            : "UP"
      });
    });

    return [...grouped.entries()]
      .map(([routeLabel, arrivals]) => ({
        routeLabel,
        arrivals: arrivals
          .sort((a, b) => (a.eta ?? Infinity) - (b.eta ?? Infinity))
          .slice(0, 4)
      }))
      .sort((a, b) => {
        const aEta = a.arrivals[0]?.eta ?? Infinity;
        const bEta = b.arrivals[0]?.eta ?? Infinity;
        return aEta - bEta;
      });
  }, []);

  const fetchNearestArrivalForStop = useCallback(async (stopId, route = null) => {

    const response = await fetch(`http://localhost:5000/api/passenger/stop/${encodeURIComponent(stopId)}/arrivals`);
    const data = await response.json().catch(() => ({ arrivals: [] }));
    const arrivals = Array.isArray(data?.arrivals) ? data.arrivals : [];
    const routeKeys = new Set(
      arrivals
        .map(arrival => String(arrival?.routeNumber || arrival?.routeId || "").trim())
        .filter(Boolean)
    );
    const hasMultipleRoutes = routeKeys.size > 1;
    const routeId = route?._id ? String(route._id) : null;
    const routeNumber = route?.routeNumber ? String(route.routeNumber) : null;
    const routeFiltered = route && !hasMultipleRoutes
      ? arrivals.filter(arrival => {
          if (routeId && String(arrival.routeId || "") === routeId) return true;
          if (routeNumber && String(arrival.routeNumber || "") === routeNumber) return true;
          return false;
        })
      : arrivals;
    let activeRows = routeFiltered
      .filter(row => row && Number.isFinite(row.eta))
      .sort((a, b) => (a.eta ?? Infinity) - (b.eta ?? Infinity));
    let directionalSummary = pickDirectionalArrivals(activeRows);

    if (!directionalSummary.up && !directionalSummary.down && route?.routeNumber && !hasMultipleRoutes) {
      const timelineResponse = await fetch(
        `http://localhost:5000/api/passenger/route/${encodeURIComponent(route.routeNumber)}/timeline`
      );
      const timelineData = await timelineResponse.json().catch(() => ({ stopTimeline: [] }));
      const stopTimeline = Array.isArray(timelineData?.stopTimeline) ? timelineData.stopTimeline : [];
      const stopEntry = stopTimeline.find(entry => String(entry?.stopId || "") === String(stopId));
      const arrivalFromTimeline =
        Array.isArray(stopEntry?.arrivals) ? stopEntry.arrivals : [];
      activeRows = arrivalFromTimeline
        .map(arrival => ({
          ...arrival,
          routeNumber: arrival.routeNumber || route.routeNumber || null,
          routeId: route?._id ? String(route._id) : null
        }))
        .filter(row => row && Number.isFinite(row.eta))
        .sort((a, b) => (a.eta ?? Infinity) - (b.eta ?? Infinity));
      directionalSummary = pickDirectionalArrivals(activeRows);
    }

    const routeGroups = buildRouteArrivalGroups(activeRows);
    setStopPopupArrivalById(prev => ({
      ...prev,
      [String(stopId)]: {
        ...directionalSummary,
        hasMultipleRoutes: hasMultipleRoutes || routeGroups.length > 1,
        routeGroups,
        arrivals: activeRows.slice(0, 8)
      }
    }));
  }, [buildRouteArrivalGroups, pickDirectionalArrivals]);

  useEffect(() => {
    if (!passengerMode || !selectedPassengerRoute?.routeNumber) return;
    let cancelled = false;

    (async () => {
      const stopIds = (selectedPassengerRoute.stops || []).map(stop =>
        String(stop?._id || stop?.id || stop || "")
      );
      const preload = {};
      stopIds.forEach(id => {
        if (id) preload[id] = { up: null, down: null, hasMultipleRoutes: false, routeGroups: [], arrivals: [] };
      });

      const timelineResponse = await fetch(
        `http://localhost:5000/api/passenger/route/${encodeURIComponent(selectedPassengerRoute.routeNumber)}/timeline`
      );
      const timelineData = await timelineResponse.json().catch(() => ({ stopTimeline: [] }));
      const stopTimeline = Array.isArray(timelineData?.stopTimeline) ? timelineData.stopTimeline : [];
      stopTimeline.forEach(entry => {
        const stopId = String(entry?.stopId || "");
        if (!stopId) return;
        const directional = pickDirectionalArrivals(entry?.arrivals || []);
        preload[stopId] = {
          ...directional,
          hasMultipleRoutes: false,
          routeGroups: [],
          arrivals: []
        };
      });

      if (cancelled) return;
      setStopPopupArrivalById(prev => ({ ...prev, ...preload }));
    })().catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [passengerMode, pickDirectionalArrivals, selectedPassengerRoute]);

  const handlePassengerBusSelect = useCallback((busId, options = {}) => {
    const fromSearch = !!options.fromSearch;
    setSelectedBus(busId);
    setFollowBus(busId);
    setSelectedStop(null);
    setSelectedBoundaryPoint(null);
    if (!passengerMode) return;
    if (fromSearch) {
      const route = findRouteForBus(busId);
      setSelectedPassengerRoute(route || null);
    }
  }, [findRouteForBus, passengerMode]);

  const handlePassengerStopSelect = useCallback(async (stopId, options = {}) => {
    const fromSearch = !!options.fromSearch;
    const targetStopId = String(stopId);
    setSelectedStop(targetStopId);
    setSelectedBoundaryPoint(null);
    const route = findRouteForStop(targetStopId);
    if (passengerMode && fromSearch) {
      setSelectedPassengerRoute(route || null);
    }
    await fetchNearestArrivalForStop(targetStopId, passengerMode ? (fromSearch ? route : selectedPassengerRoute) : null);
  }, [fetchNearestArrivalForStop, findRouteForStop, passengerMode, selectedPassengerRoute]);

  const handleBoundaryPointSelect = useCallback(async (boundaryType, options = {}) => {
    const fromSearch = !!options.fromSearch;
    if (!boundaryRoutePoints) return;
    if (passengerMode && !fromSearch) return;
    const linkedStopId =
      boundaryType === "start" ? boundaryRoutePoints.startStopId : boundaryRoutePoints.endStopId;
    setSelectedBoundaryPoint(boundaryType);
    setSelectedStop(null);
    if (passengerMode && linkedStopId) {
      await fetchNearestArrivalForStop(linkedStopId, activeRouteForStopMarkers || null);
    }
  }, [activeRouteForStopMarkers, boundaryRoutePoints, fetchNearestArrivalForStop, passengerMode]);

  const handlePassengerBoundarySearchSelect = useCallback(async (routeId, boundaryType) => {
    if (!passengerMode) return;
    const route =
      passengerRoutesCatalog.find(item => String(item?._id || "") === String(routeId)) || null;
    setSelectedPassengerRoute(route);
    setSelectedBus("");
    setFollowBus(null);
    setSelectedStop(null);
    setSelectedBoundaryPoint(boundaryType);
    const linkedStopId = resolveBoundaryStopId(route, boundaryType);
    if (linkedStopId) {
      await fetchNearestArrivalForStop(linkedStopId, route);
    }
  }, [fetchNearestArrivalForStop, passengerMode, passengerRoutesCatalog]);

  const stopNameMap = useMemo(
    () =>
      new Map(
        stops.map(s => [
          String(s.id || s._id),
          sanitizeStopName(s.name) || "Unnamed Stop"
        ])
      ),
    [stops]
  );

  const selectedAdminRouteStopRows = useMemo(() => {
    if (!selectedAdminRoute) return [];
    return (selectedAdminRoute.stops || []).map((stopRef, index) => {
      const stopId = String(stopRef?._id || stopRef?.id || stopRef || "");
      const stopName = sanitizeStopName(stopRef?.name) || stopNameMap.get(stopId) || "Unnamed Stop";
      return {
        key: `${selectedAdminRoute.routeNumber}-${stopId || index}-${index}`,
        sequence: index + 1,
        name: stopName
      };
    });
  }, [selectedAdminRoute, stopNameMap]);

  const existingStopsForBuilder = useMemo(() => {
    const selectedSet = new Set(routeBuilder.stops.map(id => String(id)));
    return stops
      .map(stop => {
        const stopId = String(stop.id || stop._id || "");
        const stopName = sanitizeStopName(stop.name);
        return {
          id: stopId,
          label: stopName || `Stop ${stopId.slice(-4)}`
        };
      })
      .filter(stop => stop.id && !selectedSet.has(stop.id))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [routeBuilder.stops, stops]);

  const isEditingAdminRoute = useMemo(() => {
    const cleanRouteNumber = String(routeBuilder.routeNumber || "").trim();
    if (selectedAdminRouteNumber) return true;
    if (!cleanRouteNumber) return false;
    return adminRoutes.some(
      route => String(route?.routeNumber || "").trim() === cleanRouteNumber
    );
  }, [adminRoutes, routeBuilder.routeNumber, selectedAdminRouteNumber]);

  const dashboardStats = useMemo(() => {
    const delayed = buses.filter(b => String(b.status || "").toUpperCase().includes("DELAY")).length;
    const stopped = buses.filter(b => String(b.status || "").toUpperCase().includes("STOP")).length;
    const running = buses.filter(b => !!b.running).length;
    const onTime = Math.max(0, running - delayed);
    const activeTools = [
      addingIncident ? "Adding Incident" : null,
      addingStop ? "Adding Stop" : null,
      routeDrawMode ? "Drawing Route" : null,
      followBus ? `Following ${followBus}` : null
    ].filter(Boolean);

    return {
      delayed,
      stopped,
      running,
      onTime,
      totalBuses: buses.length,
      totalStops: stops.length,
      totalIncidents: incidents.length,
      modeLabel: passengerMode ? "Passenger" : "Admin",
      routeLabel:
        selectedPassengerRoute?.routeNumber ||
        selectedAdminRouteNumber ||
        "None",
      mlEnabled: !!mlStatus.enabled,
      mlSamples: Number.isFinite(Number(mlStatus.samples)) ? Number(mlStatus.samples) : 0,
      activeTools
    };
  }, [
    buses,
    incidents,
    stops,
    passengerMode,
    selectedPassengerRoute,
    selectedAdminRouteNumber,
    mlStatus,
    addingIncident,
    addingStop,
    routeDrawMode,
    followBus
  ]);

  useEffect(() => {
    const savedTheme = localStorage.getItem(THEME_STORAGE_KEY);
    if (savedTheme === "dark" || savedTheme === "light") return undefined;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = e => setDarkMode(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  const toggleThemeMode = () => {
    setDarkMode(prev => {
      const next = !prev;
      localStorage.setItem(THEME_STORAGE_KEY, next ? "dark" : "light");
      return next;
    });
  };

  useEffect(() => {
    fetch("http://localhost:5000/stops").then(r => r.json()).then(setStops).catch(() => setStops([]));
    fetch("http://localhost:5000/incidents").then(r => r.json()).then(setIncidents).catch(() => setIncidents([]));
    fetch("http://localhost:5000/buses")
      .then(r => r.json())
      .then(data => {
        const list = data.map(normalizeBus);
        setBuses(list);
        if (list.length) setSelectedBus(list[0].id);
      })
      .catch(() => setBuses([]));
  }, []);

  useEffect(() => {
    fetch("http://localhost:5000/api/passenger/ml/status")
      .then(r => r.json())
      .then(setMlStatus)
      .catch(() => setMlStatus({ enabled: false, trainedAt: null, samples: 0 }));
  }, []);

  useEffect(() => {
    fetch("http://localhost:5000/api/passenger/routes")
      .then(r => r.json())
      .then(data => setPassengerRoutesCatalog(Array.isArray(data) ? data : []))
      .catch(() => setPassengerRoutesCatalog([]));
  }, []);

  const fetchAdminRoutes = useCallback(async authToken => {
    if (!authToken) {
      setAdminRoutes([]);
      return;
    }
    const response = await fetch("http://localhost:5000/api/admin/routes", {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    if (!response.ok) return;
    const data = await response.json();
    setAdminRoutes(Array.isArray(data) ? data : []);
  }, []);

  const fetchRouteRevisions = useCallback(async (routeNumber, authToken) => {
    if (!authToken || !routeNumber) {
      setRouteRevisions([]);
      return;
    }
    const response = await fetch(
      `http://localhost:5000/api/admin/routes/${encodeURIComponent(routeNumber)}/revisions`,
      { headers: { Authorization: `Bearer ${authToken}` } }
    );
    if (!response.ok) return;
    const data = await response.json();
    setRouteRevisions(Array.isArray(data) ? data : []);
  }, []);

  useEffect(() => {
    fetchAdminRoutes(token).catch(() => undefined);
  }, [fetchAdminRoutes, token]);

  useEffect(() => {
    if (!token || !selectedAdminRouteNumber) {
      setRouteRevisions([]);
      return;
    }
    fetchRouteRevisions(selectedAdminRouteNumber, token).catch(() => undefined);
  }, [fetchRouteRevisions, selectedAdminRouteNumber, token]);

  useEffect(() => {
    const onBusUpdate = payload => {
      const bus = normalizeBus(payload);
      setBuses(prev => {
        const idx = prev.findIndex(b => b.id === bus.id);
        if (idx === -1) return [...prev, bus];
        const copy = [...prev];
        copy[idx] = bus;
        return copy;
      });
    };

    socket.on("busUpdate", onBusUpdate);
    socket.on("busRemoved", data => {
      if (data?.all) setBuses([]);
      else setBuses(prev => prev.filter(b => b.id !== data.id));
    });
    socket.on("incidentUpdate", setIncidents);
    socket.on("stopsUpdate", setStops);
    socket.on("incidentRemovalPrompt", payload => {
      setIncidentPromptQueue(prev => {
        const incidentId = String(payload?.incidentId || "");
        if (!incidentId) return prev;
        if (prev.some(item => String(item?.incidentId) === incidentId)) return prev;
        return [...prev, payload];
      });
    });

    return () => {
      socket.off("busUpdate", onBusUpdate);
      socket.off("busRemoved");
      socket.off("incidentUpdate");
      socket.off("stopsUpdate");
      socket.off("incidentRemovalPrompt");
    };
  }, []);

  useEffect(() => {
    const query = startQuery.trim();
    if (query.length < 3) {
      setStartResults([]);
      return undefined;
    }

    const cacheKey = normalizeSearchText(query);
    const cached = placeSearchCacheRef.current.get(cacheKey);
    if (cached) {
      setStartResults(cached);
      return undefined;
    }

    let cancelled = false;
    const controller = new AbortController();
    const t = setTimeout(async () => {
      try {
        const results = await searchPlaces(query, controller.signal);
        if (cancelled) return;
        placeSearchCacheRef.current.set(cacheKey, Array.isArray(results) ? results : []);
        setStartResults(Array.isArray(results) ? results : []);
      } catch {
        if (!cancelled) setStartResults([]);
      }
    }, 140);

    return () => {
      cancelled = true;
      clearTimeout(t);
      controller.abort();
    };
  }, [startQuery]);

  useEffect(() => {
    const query = endQuery.trim();
    if (query.length < 3) {
      setEndResults([]);
      return undefined;
    }

    const cacheKey = normalizeSearchText(query);
    const cached = placeSearchCacheRef.current.get(cacheKey);
    if (cached) {
      setEndResults(cached);
      return undefined;
    }

    let cancelled = false;
    const controller = new AbortController();
    const t = setTimeout(async () => {
      try {
        const results = await searchPlaces(query, controller.signal);
        if (cancelled) return;
        placeSearchCacheRef.current.set(cacheKey, Array.isArray(results) ? results : []);
        setEndResults(Array.isArray(results) ? results : []);
      } catch {
        if (!cancelled) setEndResults([]);
      }
    }, 140);

    return () => {
      cancelled = true;
      clearTimeout(t);
      controller.abort();
    };
  }, [endQuery]);

  useEffect(() => {
    const busIds = buses.map(b => String(b.id));
    if (!busIds.length) {
      if (selectedBus) setSelectedBus("");
      if (routeBusCandidate) setRouteBusCandidate("");
      setRouteBuilder(prev =>
        prev.assignedBuses.length ? { ...prev, assignedBuses: [] } : prev
      );
      return;
    }

    if (!busIds.includes(String(selectedBus || ""))) {
      setSelectedBus(busIds[0]);
    }
    if (!busIds.includes(String(routeBusCandidate || ""))) {
      setRouteBusCandidate(busIds[0]);
    }

    setRouteBuilder(prev => {
      const nextAssigned = prev.assignedBuses.filter(id =>
        busIds.includes(String(id))
      );
      if (nextAssigned.length === prev.assignedBuses.length) return prev;
      return { ...prev, assignedBuses: nextAssigned };
    });
  }, [buses, routeBusCandidate, selectedBus]);

  useEffect(() => {
    const ids = existingStopsForBuilder.map(stop => stop.id);
    if (!ids.length) {
      if (existingStopCandidate) setExistingStopCandidate("");
      return;
    }
    if (!ids.includes(String(existingStopCandidate || ""))) {
      setExistingStopCandidate(ids[0]);
    }
  }, [existingStopCandidate, existingStopsForBuilder]);

  useEffect(() => {
    if (!selectedBus) return;
    const exists = buses.some(b => String(b.id) === String(selectedBus));
    if (!exists) return;
    setRouteBusCandidate(String(selectedBus));
  }, [buses, selectedBus]);

  useEffect(() => {
    setIncidentPromptQueue(prev => {
      const next = prev.filter(prompt =>
        incidents.some(i => String(i.id || i._id) === String(prompt.incidentId))
      );
      return next.length === prev.length ? prev : next;
    });
  }, [incidents]);

  useEffect(() => {
    localStorage.setItem(MODE_STORAGE_KEY, passengerMode ? "passenger" : "admin");
  }, [passengerMode]);

  useEffect(() => {
    if (!token && !passengerMode) setPassengerMode(true);
  }, [token, passengerMode]);

  useEffect(() => {
    if (!selectedStop) return;
    const marker = stopMarkerRefs.current.get(String(selectedStop));
    if (marker?.openPopup) marker.openPopup();
  }, [selectedStop, stopPopupArrivalById, stops]);

  useEffect(() => {
    if (!selectedBoundaryPoint) return;
    const marker =
      selectedBoundaryPoint === "start"
        ? startBoundaryMarkerRef.current
        : endBoundaryMarkerRef.current;
    if (marker?.openPopup) marker.openPopup();
  }, [boundaryRoutePoints, selectedBoundaryPoint, stopPopupArrivalById]);

  useEffect(() => {
    setSelectedBoundaryPoint(null);
  }, [selectedAdminRouteNumber, passengerMode]);

  useEffect(() => {
    if (passengerMode) setRoutePopup(null);
  }, [passengerMode]);

  const loginAdmin = async () => {
    try {
      const response = await fetch("http://localhost:5000/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password })
      });
      const data = await response.json();
      if (!data.token) throw new Error("Invalid password");
      setToken(data.token);
      localStorage.setItem("token", data.token);
      setPassengerMode(false);
      setShowLogin(false);
      setPassword("");
    } catch {
      setConfirm({ title: "Login Failed", message: "Invalid password", onConfirm: null });
    }
  };

  const logoutAdmin = () => {
    setToken("");
    localStorage.removeItem("token");
    setPassengerMode(true);
  };

  const togglePassengerAdminMode = () => {
    if (passengerMode) {
      if (!token) {
        setShowLogin(true);
        return;
      }
      setPassengerMode(false);
      return;
    }
    setPassengerMode(true);
  };

  const fetchRoutes = async (start, end) => {
    if (!start || !end) return;
    const startLon = Number(start.lon);
    const startLat = Number(start.lat);
    const endLon = Number(end.lon);
    const endLat = Number(end.lat);
    if (![startLon, startLat, endLon, endLat].every(Number.isFinite)) return;

    setRouteBuilder(prev => ({
      ...prev,
      startPointName: placeLabel(start, prev.startPointName || "Start Point"),
      endPointName: placeLabel(end, prev.endPointName || "End Point")
    }));

    const routeKey = `${startLon.toFixed(5)},${startLat.toFixed(5)}|${endLon.toFixed(5)},${endLat.toFixed(5)}`;
    const cached = routeCacheRef.current.get(routeKey);
    if (cached?.length) {
      setRoutes(cached);
      setSelectedRouteIndex(0);
      setActiveRouteIndex(0);
      return;
    }

    const requestId = ++routeRequestSeqRef.current;
    if (routeAbortRef.current) routeAbortRef.current.abort();
    const controller = new AbortController();
    routeAbortRef.current = controller;

    const baseUrl =
      `https://router.project-osrm.org/route/v1/driving/` +
      `${startLon},${startLat};${endLon},${endLat}`;

    try {
      // Quick first route render for perceived speed.
      const fastUrl = `${baseUrl}?overview=full&geometries=geojson&alternatives=false`;
      const fastData = await (await fetch(fastUrl, { signal: controller.signal })).json();
      const fastParsed = parseOsrmRoutes(fastData);
      if (!controller.signal.aborted && requestId === routeRequestSeqRef.current && fastParsed.length) {
        setRoutes(fastParsed);
        setSelectedRouteIndex(0);
        setActiveRouteIndex(0);
      }

      // Then fetch alternatives and replace if available.
      const fullUrl = `${baseUrl}?overview=full&geometries=geojson&alternatives=true`;
      const fullData = await (await fetch(fullUrl, { signal: controller.signal })).json();
      const fullParsed = parseOsrmRoutes(fullData);
      if (!controller.signal.aborted && requestId === routeRequestSeqRef.current && fullParsed.length) {
        routeCacheRef.current.set(routeKey, fullParsed);
        setRoutes(fullParsed);
        setSelectedRouteIndex(0);
        setActiveRouteIndex(0);
      }
    } catch (e) {
      if (e?.name === "AbortError") return;
    }
  };

  useEffect(() => {
    if (!startPlace || !endPlace) return;
    fetchRoutes(startPlace, endPlace).catch(() => undefined);
  }, [startPlace, endPlace]);

  const addBusNow = async () => {
    const id = (newBusId || "").trim();
    if (!token) return;
    if (!id) {
      setConfirm({ title: "Bus ID Required", message: "Enter a bus ID before adding.", onConfirm: null });
      return;
    }
    await fetch("http://localhost:5000/addBus", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ id })
    });
    setSelectedBus(id);
    setFollowBus(id);
    setNewBusId("");
  };

  const addIncident = async p => {
    const role = token ? "admin" : "user";
    await fetch("http://localhost:5000/incident", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lat: p.lat, lng: p.lng, type: incidentType, createdByRole: role })
    });
    setAddingIncident(false);
  };

  const addStop = p => {
    if (!token) return;
    const nearby = findNearbyExistingStop({ lat: p.lat, lng: p.lng }, stops, STOP_REUSE_RADIUS_METERS);
    if (nearby?.stop) {
      const stopId = String(nearby.stop.id || nearby.stop._id || "");
      setPendingExistingStop({
        stopId,
        stopName: sanitizeStopName(nearby.stop.name) || `Stop ${stopId.slice(-4)}`,
        distanceMeters: Math.round(nearby.distanceMeters)
      });
      setPendingStopPoint({ lat: p.lat, lng: p.lng });
      return;
    }
    setPendingStopPoint({ lat: p.lat, lng: p.lng });
    setPendingStopName(`Stop ${stops.length + 1}`);
  };

  const useNearbyExistingStop = () => {
    const stopId = String(pendingExistingStop?.stopId || "");
    if (!stopId) return;
    setRouteBuilder(prev => {
      if (prev.stops.includes(stopId)) return prev;
      return { ...prev, stops: [...prev.stops, stopId] };
    });
    if (routeBuilder.stops.includes(stopId)) {
      setConfirm({
        title: "Stop Already Added",
        message: `${pendingExistingStop.stopName} is already in this route.`,
        onConfirm: null
      });
    }
    setPendingExistingStop(null);
    setPendingStopPoint(null);
    setPendingStopName("");
  };

  const createNewStopFromNearbyChoice = () => {
    setPendingExistingStop(null);
    setPendingStopName(`Stop ${stops.length + 1}`);
  };

  const savePinnedStop = async () => {
    if (!token || !pendingStopPoint) return;
    const cleanName = String(pendingStopName || "").trim();
    if (!cleanName) {
      setConfirm({ title: "Stop Name Required", message: "Please enter a stop name.", onConfirm: null });
      return;
    }

    const response = await fetch("http://localhost:5000/stops", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        lat: pendingStopPoint.lat,
        lng: pendingStopPoint.lng,
        name: cleanName
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      setConfirm({ title: "Stop Create Failed", message: data.error || "Unable to add stop", onConfirm: null });
      return;
    }

    const createdStopId = String(data?.stop?._id || data?.stop?.id || "");
    if (createdStopId) {
      setRouteBuilder(prev => {
        if (prev.stops.includes(createdStopId)) return prev;
        return { ...prev, stops: [...prev.stops, createdStopId] };
      });
    }
    setPendingExistingStop(null);
    setPendingStopPoint(null);
    setPendingStopName("");
  };

  const cancelPinnedStop = () => {
    setPendingExistingStop(null);
    setPendingStopPoint(null);
    setPendingStopName("");
  };

  const removeBus = async () => {
    if (!selectedBus || !token) return;
    await fetch(`http://localhost:5000/bus/${selectedBus}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` }
    });
  };

  const removeIncident = async incidentId => {
    await fetch(`http://localhost:5000/incident/${incidentId}`, { method: "DELETE" });
    setIncidentPromptQueue(prev =>
      prev.filter(prompt => String(prompt.incidentId) !== String(incidentId))
    );
  };

  const removeExistingStop = async stopId => {
    if (!token) return;
    const targetStopId = String(stopId || "");
    if (!targetStopId) return;

    const response = await fetch(`http://localhost:5000/stops/${encodeURIComponent(targetStopId)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      setConfirm({
        title: "Stop Remove Failed",
        message: data.error || "Unable to remove stop",
        onConfirm: null
      });
      return;
    }

    setRouteBuilder(prev => ({
      ...prev,
      stops: prev.stops.filter(s => String(s) !== targetStopId)
    }));
    setStopPopupArrivalById(prev => {
      const next = { ...prev };
      delete next[targetStopId];
      return next;
    });
    if (String(selectedStop || "") === targetStopId) {
      setSelectedStop(null);
    }
    if (
      boundaryRoutePoints &&
      (String(boundaryRoutePoints.startStopId || "") === targetStopId ||
        String(boundaryRoutePoints.endStopId || "") === targetStopId)
    ) {
      setSelectedBoundaryPoint(null);
    }

    await fetchAdminRoutes(token).catch(() => undefined);
    if (selectedAdminRouteNumber) {
      await fetchRouteRevisions(selectedAdminRouteNumber, token).catch(() => undefined);
    }
  };

  const resetRouteBuilder = () => {
    setSelectedAdminRouteNumber("");
    setRouteBuilder(createEmptyRouteBuilder());
    setRouteDrawMode(false);
    setRouteRevisions([]);
  };

  const loadRouteForEdit = route => {
    if (!route) return;
    setSelectedAdminRouteNumber(route.routeNumber);
    setRouteBuilder({
      routeNumber: route.routeNumber || "",
      routeName: route.routeName || "",
      startPointName: route.startPointName || "",
      endPointName: route.endPointName || "",
      stops: (route.stops || []).map(s => String(s._id || s.id || s)),
      polyline: (route.polyline || []).map(p => ({ lat: Number(p.lat), lng: Number(p.lng) })),
      assignedBuses: (route.assignedBuses || []).map(String)
    });
    setRouteDrawMode(false);
    fetchRouteRevisions(route.routeNumber, token).catch(() => undefined);
  };

  const removeStopFromBuilder = stopId => {
    setRouteBuilder(prev => ({ ...prev, stops: prev.stops.filter(s => s !== stopId) }));
  };

  const addExistingStopToBuilder = () => {
    const stopId = String(existingStopCandidate || "").trim();
    if (!stopId) return;
    setRouteBuilder(prev => {
      if (prev.stops.includes(stopId)) return prev;
      return { ...prev, stops: [...prev.stops, stopId] };
    });
  };

  const moveBuilderStop = (idx, direction) => {
    setRouteBuilder(prev => {
      const next = [...prev.stops];
      const swapIdx = direction === "up" ? idx - 1 : idx + 1;
      if (swapIdx < 0 || swapIdx >= next.length) return prev;
      [next[idx], next[swapIdx]] = [next[swapIdx], next[idx]];
      return { ...prev, stops: next };
    });
  };

  const onBuilderStopDragStart = idx => {
    setDragStopIndex(idx);
    setDragOverStopIndex(idx);
  };

  const onBuilderStopDragOver = idx => {
    setDragOverStopIndex(idx);
  };

  const onBuilderStopDrop = idx => {
    if (dragStopIndex == null || dragStopIndex === idx) {
      setDragStopIndex(null);
      setDragOverStopIndex(null);
      return;
    }
    setRouteBuilder(prev => {
      const next = [...prev.stops];
      const [moved] = next.splice(dragStopIndex, 1);
      next.splice(idx, 0, moved);
      return { ...prev, stops: next };
    });
    setDragStopIndex(null);
    setDragOverStopIndex(null);
  };

  const onBuilderStopDragEnd = () => {
    setDragStopIndex(null);
    setDragOverStopIndex(null);
  };

  const addBusToBuilder = () => {
    const busId = String(routeBusCandidate || "").trim();
    if (!busId) return;
    const exists = buses.some(b => String(b.id) === busId);
    if (!exists) {
      setConfirm({
        title: "Invalid Bus",
        message: `Bus ${busId} is not in fleet. Select an existing bus.`,
        onConfirm: null
      });
      return;
    }
    setRouteBuilder(prev => {
      if (prev.assignedBuses.includes(busId)) return prev;
      return { ...prev, assignedBuses: [...prev.assignedBuses, busId] };
    });
  };

  const removeBusFromBuilder = busId => {
    setRouteBuilder(prev => ({
      ...prev,
      assignedBuses: prev.assignedBuses.filter(b => b !== busId)
    }));
  };

  const addRoutePoint = latlng => {
    setRouteBuilder(prev => ({
      ...prev,
      polyline: [...prev.polyline, { lat: latlng.lat, lng: latlng.lng }]
    }));
  };

  const clearRoutePolyline = () => {
    setRouteBuilder(prev => ({ ...prev, polyline: [] }));
  };

  const useDraftPolyline = () => {
    const draft = routes[selectedRouteIndex];
    if (!draft?.length) return;
    setRouteBuilder(prev => ({
      ...prev,
      polyline: draft.map(([lat, lng]) => ({ lat, lng }))
    }));
  };

  const createAdminRoute = async () => {
    if (!token) return;
    const cleanRouteNumber = routeBuilder.routeNumber.trim();
    if (!cleanRouteNumber) {
      setConfirm({ title: "Route Number Required", message: "Please enter a route number.", onConfirm: null });
      return;
    }
    if (routeBuilder.polyline.length < 2) {
      setConfirm({ title: "Route Line Missing", message: "Pick start/end and set a valid map route first.", onConfirm: null });
      return;
    }
    if (routeBuilder.stops.length < 2) {
      setConfirm({ title: "Stops Required", message: "Add at least 2 stops for this route.", onConfirm: null });
      return;
    }
    const busIdSet = new Set(buses.map(b => String(b.id)));
    const normalizedAssignedBuses = [...new Set(
      routeBuilder.assignedBuses
        .map(id => String(id || "").trim())
        .filter(id => id && busIdSet.has(id))
    )];
    const assignedBuses = normalizedAssignedBuses.length
      ? normalizedAssignedBuses
      : selectedBus && busIdSet.has(String(selectedBus))
        ? [String(selectedBus)]
        : [];
    if (normalizedAssignedBuses.length !== routeBuilder.assignedBuses.length) {
      setRouteBuilder(prev => ({ ...prev, assignedBuses: normalizedAssignedBuses }));
    }
    if (!assignedBuses.length) {
      setConfirm({ title: "Bus Required", message: "Select and assign at least one bus.", onConfirm: null });
      return;
    }

    const selectedRouteNumber = String(selectedAdminRouteNumber || "").trim();
    const sameNumberRoute = adminRoutes.find(
      route => String(route?.routeNumber || "").trim() === cleanRouteNumber
    );
    const isUpdate = !!(selectedRouteNumber || sameNumberRoute);
    const targetRouteNumber = selectedRouteNumber || String(sameNumberRoute?.routeNumber || "");

    const payload = isUpdate
      ? {
          ...(cleanRouteNumber !== targetRouteNumber
            ? { newRouteNumber: cleanRouteNumber }
            : {}),
          routeName: routeBuilder.routeName.trim() || null,
          startPointName: routeBuilder.startPointName.trim() || null,
          endPointName: routeBuilder.endPointName.trim() || null,
          stops: routeBuilder.stops,
          polyline: routeBuilder.polyline,
          assignedBuses
        }
      : {
          routeNumber: cleanRouteNumber,
          routeName: routeBuilder.routeName.trim() || null,
          startPointName: routeBuilder.startPointName.trim() || null,
          endPointName: routeBuilder.endPointName.trim() || null,
          stops: routeBuilder.stops,
          polyline: routeBuilder.polyline,
          assignedBuses
        };
    const response = await fetch(
      isUpdate
        ? `http://localhost:5000/api/admin/routes/${encodeURIComponent(targetRouteNumber)}`
        : "http://localhost:5000/api/admin/routes",
      {
        method: isUpdate ? "PATCH" : "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify(payload)
      }
    );
    const data = await response.json();
    if (!response.ok) {
      setConfirm({ title: "Route Save Failed", message: data.error || "Unable to save route", onConfirm: null });
      return;
    }
    await fetchAdminRoutes(token);
    const startedCount = Array.isArray(data?.startedBusIds) ? data.startedBusIds.length : 0;
    setConfirm({
      title: isUpdate ? "Route Updated and Published" : "Route Added and Published",
      message: startedCount ? `${cleanRouteNumber} | Buses started: ${startedCount}` : cleanRouteNumber,
      onConfirm: null
    });
    setSelectedAdminRouteNumber(cleanRouteNumber);
    await fetchRouteRevisions(cleanRouteNumber, token);
  };

  const deleteAdminRoute = async routeNumberOverride => {
    const targetRouteNumber = String(routeNumberOverride || selectedAdminRouteNumber || "").trim();
    if (!token || !targetRouteNumber) return;
    const response = await fetch(
      `http://localhost:5000/api/admin/routes/${encodeURIComponent(targetRouteNumber)}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` }
      }
    );
    const data = await response.json();
    if (!response.ok) {
      setConfirm({ title: "Route Delete Failed", message: data.error || "Unable to delete route", onConfirm: null });
      return;
    }
    await fetchAdminRoutes(token);
    if (targetRouteNumber === selectedAdminRouteNumber) {
      resetRouteBuilder();
    }
    setRoutePopup(prev =>
      prev?.type === "admin" && prev?.routeNumber === targetRouteNumber ? null : prev
    );
    setConfirm({ title: "Route Deleted", message: data.routeNumber || "", onConfirm: null });
  };

  const rollbackAdminRoute = async revisionId => {
    if (!token || !selectedAdminRouteNumber || !revisionId) return;
    const response = await fetch(
      `http://localhost:5000/api/admin/routes/${encodeURIComponent(selectedAdminRouteNumber)}/rollback/${encodeURIComponent(revisionId)}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` }
      }
    );
    const data = await response.json();
    if (!response.ok) {
      setConfirm({ title: "Rollback Failed", message: data.error || "Unable to rollback route", onConfirm: null });
      return;
    }

    const rolled = data?.route;
    if (rolled) loadRouteForEdit(rolled);
    await fetchAdminRoutes(token);
    await fetchRouteRevisions(rolled?.routeNumber || selectedAdminRouteNumber, token);
    setConfirm({
      title: "Rollback Complete",
      message: `Route restored from revision ${String(revisionId).slice(-6)}`,
      onConfirm: null
    });
  };

  const trainMlEtaModel = async () => {
    if (!token) return;
    const response = await fetch("http://localhost:5000/api/admin/ml/train-eta", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        days: 30,
        epochs: 500,
        useExternalData: true,
        historicalBackfill: true,
        maxExternalRequests: 120
      })
    });
    const data = await response.json();
    if (!response.ok) {
      const stats = data?.stats || {};
      const statsSummary = [
        Number.isFinite(stats.logs) ? `logs=${stats.logs}` : null,
        Number.isFinite(stats.logsWithEta) ? `logsWithEta=${stats.logsWithEta}` : null,
        Number.isFinite(stats.logsWithNextStop) ? `logsWithNextStop=${stats.logsWithNextStop}` : null,
        Number.isFinite(stats.samples) ? `samples=${stats.samples}` : null
      ]
        .filter(Boolean)
        .join(", ");
      setConfirm({
        title: "ML Training Failed",
        message: [data.error || "Training failed", statsSummary].filter(Boolean).join(" | "),
        onConfirm: null
      });
      return;
    }
    setMlStatus({
      enabled: true,
      trainedAt: data.model?.trainedAt || null,
      samples: data.model?.samples || 0,
      externalWeather: mlStatus.externalWeather
    });
    setConfirm({
      title: "ML Model Trained",
      message: `Samples: ${data.model?.samples || 0}, RMSE: ${(data.metrics?.rmse || 0).toFixed(2)}`,
      onConfirm: null
    });
  };

  const refreshExternalWeather = async () => {
    if (!token) return;
    const response = await fetch("http://localhost:5000/api/admin/ml/weather/refresh", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await response.json();
    if (response.ok) {
      setMlStatus(prev => ({ ...prev, externalWeather: data.weather || prev.externalWeather }));
    }
  };

  return (
    <div className={`${darkMode ? "dark-mode" : "light-mode"} app-shell`}>
      <div className="panel">
        <button className="btn btn-primary" onClick={togglePassengerAdminMode}>
          {passengerMode ? "Admin Mode" : "Passenger Mode"}
        </button>

        <button className="btn btn-secondary" onClick={toggleThemeMode}>
          {darkMode ? "Light" : "Dark"}
        </button>

        {token && <button className="btn btn-danger" onClick={logoutAdmin}>Logout</button>}

        {!passengerMode && (
          <div className="admin-layout">
            <div className="admin-head-card">
              <div className="admin-head-title">Admin Console</div>
              <div className="admin-head-sub">
                Fleet {dashboardStats.totalBuses} | Stops {dashboardStats.totalStops} | Incidents {dashboardStats.totalIncidents}
              </div>
            </div>

            <details className="admin-section admin-section-fleet" open>
              <summary>Fleet Control</summary>
              <div className="admin-section-body">
                <div className="list-box">
                  <label className="field-label">Select Bus</label>
                  <select className="input themed-select" value={selectedBus} onChange={e => setSelectedBus(e.target.value)}>
                    {buses.map(b => (
                      <option key={b.id} value={b.id}>
                        {b.id}
                      </option>
                    ))}
                  </select>
                </div>

                {token && (
                  <div className="admin-inline-row">
                    <input
                      className="input mb-none"
                      placeholder="New bus ID"
                      value={newBusId}
                      onChange={e => setNewBusId(e.target.value)}
                    />
                    <button className="btn btn-secondary" onClick={addBusNow}>Add Bus</button>
                    <button className="btn btn-danger" onClick={removeBus}>Remove Bus</button>
                  </div>
                )}
              </div>
            </details>

            <details className="admin-section admin-section-eta" open>
              <summary>ETA Model</summary>
              <div className="admin-section-body">
                <div className="list-box">
                  <div className="meta-title">ETA ML Model</div>
                  <div className="meta-text">
                    {mlStatus.enabled ? `Trained (${mlStatus.samples} samples)` : "Not trained yet"}
                  </div>
                  {mlStatus.externalWeather && (
                    <div className="meta-text">
                      Weather: {Math.round(mlStatus.externalWeather.temperatureC || 0)} C, rain {mlStatus.externalWeather.precipitationMm || 0} mm
                    </div>
                  )}
                  {token && (
                    <>
                      <button className="btn btn-secondary" onClick={refreshExternalWeather}>
                        Refresh Weather
                      </button>
                      <button className="btn btn-secondary" onClick={trainMlEtaModel}>
                        Train ETA Model
                      </button>
                    </>
                  )}
                </div>
              </div>
            </details>

            <details className="admin-section admin-section-route" open>
              <summary>Route Builder</summary>
              <div className="admin-section-body">
                {token ? (
                  <div className="list-box">
                    <select
                      className="input themed-select"
                      value={selectedAdminRouteNumber}
                      onChange={e => {
                        const number = e.target.value;
                        setSelectedAdminRouteNumber(number);
                        const selected = adminRoutes.find(r => r.routeNumber === number);
                        if (selected) loadRouteForEdit(selected);
                      }}
                    >
                      <option value="">Select existing route (optional)</option>
                      {adminRoutes.map(r => (
                        <option key={String(r._id || r.id || r.routeNumber)} value={r.routeNumber}>
                          {r.routeNumber} {r.routeName ? `- ${r.routeName}` : ""}
                        </option>
                      ))}
                    </select>

                    {selectedAdminRoute && (
                      <div className="list-box selected-route-stops-panel">
                        <div className="meta-title">
                          Selected Route Stops ({selectedAdminRouteStopRows.length})
                        </div>
                        <div className="scroll-box selected-route-stops-scroll">
                          {selectedAdminRouteStopRows.length === 0 && (
                            <div className="meta-muted">No stops configured in this route yet.</div>
                          )}
                          {selectedAdminRouteStopRows.map(row => (
                            <div key={row.key} className="selected-route-stop-row">
                              <span className="selected-route-stop-index">{row.sequence}.</span>
                              <span className="selected-route-stop-name">{row.name}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    <input
                      className="input"
                      placeholder="Route Number"
                      value={routeBuilder.routeNumber}
                      onChange={e => setRouteBuilder(prev => ({ ...prev, routeNumber: e.target.value }))}
                    />
                    <input
                      className="input"
                      placeholder="Route Name"
                      value={routeBuilder.routeName}
                      onChange={e => setRouteBuilder(prev => ({ ...prev, routeName: e.target.value }))}
                    />
                    <input
                      className="input"
                      placeholder="Start Point Name"
                      value={routeBuilder.startPointName}
                      onChange={e => setRouteBuilder(prev => ({ ...prev, startPointName: e.target.value }))}
                    />
                    <input
                      className="input"
                      placeholder="End Point Name"
                      value={routeBuilder.endPointName}
                      onChange={e => setRouteBuilder(prev => ({ ...prev, endPointName: e.target.value }))}
                    />

                    <div className="admin-inline-row">
                      <button
                        className={addingStop ? "btn btn-primary" : "btn btn-secondary"}
                        onClick={() => {
                          setAddingStop(v => {
                            const next = !v;
                            if (next) {
                              setRouteDrawMode(false);
                              setAddingIncident(false);
                            } else {
                              cancelPinnedStop();
                            }
                            return next;
                          });
                        }}
                      >
                        {addingStop ? "Stop Pinning: ON" : "Pin Stop On Map"}
                      </button>
                    </div>
                    {existingStopsForBuilder.length > 0 && (
                      <div className="admin-inline-row">
                        <select
                          className="input themed-select mb-none"
                          value={existingStopCandidate}
                          onChange={e => setExistingStopCandidate(e.target.value)}
                        >
                          {existingStopsForBuilder.map(stop => (
                            <option key={stop.id} value={stop.id}>
                              {stop.label}
                            </option>
                          ))}
                        </select>
                        <button
                          className="btn btn-secondary"
                          onClick={addExistingStopToBuilder}
                        >
                          Add Existing Stop
                        </button>
                      </div>
                    )}
                    {routeBuilder.stops.length > 0 && (
                      <div className="scroll-box route-stop-scroll">
                        {routeBuilder.stops.map((sid, idx) => (
                          <div
                            key={`${sid}-${idx}`}
                            className={
                              "route-stop-item" +
                              (dragStopIndex === idx ? " dragging" : "") +
                              (dragOverStopIndex === idx ? " drag-over" : "")
                            }
                            draggable
                            onDragStart={() => onBuilderStopDragStart(idx)}
                            onDragOver={e => {
                              e.preventDefault();
                              onBuilderStopDragOver(idx);
                            }}
                            onDrop={() => onBuilderStopDrop(idx)}
                            onDragEnd={onBuilderStopDragEnd}
                          >
                            <span className="route-stop-text">{idx + 1}. {stopNameMap.get(sid) || sid}</span>
                            <button className="btn btn-secondary" onClick={() => moveBuilderStop(idx, "up")}>Up</button>
                            <button className="btn btn-secondary" onClick={() => moveBuilderStop(idx, "down")}>Down</button>
                            <button className="btn btn-danger" onClick={() => removeStopFromBuilder(sid)}>x</button>
                          </div>
                        ))}
                      </div>
                    )}

                    <div className="admin-inline-row">
                      <select
                        className="input themed-select mb-none"
                        value={routeBusCandidate}
                        onChange={e => setRouteBusCandidate(e.target.value)}
                      >
                        {buses.map(b => (
                          <option key={b.id} value={b.id}>{b.id}</option>
                        ))}
                      </select>
                      <button className="btn btn-secondary" onClick={addBusToBuilder}>Assign Bus</button>
                    </div>

                    <div className="admin-inline-row wrap-row">
                      {routeBuilder.assignedBuses.map(bid => (
                        <button key={bid} className="btn btn-secondary btn-inline" onClick={() => removeBusFromBuilder(bid)}>
                          {bid} x
                        </button>
                      ))}
                    </div>

                    <div className="meta-text">
                      Polyline points: {routeBuilder.polyline.length}
                    </div>
                    <div className="admin-inline-row">
                      <button
                        className="btn btn-secondary"
                        onClick={() => {
                          setRouteDrawMode(v => {
                            const next = !v;
                            if (next) {
                              setAddingIncident(false);
                              setAddingStop(false);
                            }
                            return next;
                          });
                        }}
                      >
                        {routeDrawMode ? "Stop Draw" : "Draw On Map"}
                      </button>
                      <button className="btn btn-secondary" onClick={useDraftPolyline}>Use Draft Route</button>
                      <button className="btn btn-danger" onClick={clearRoutePolyline}>Clear Line</button>
                    </div>

                    <div className="admin-inline-row wrap-row">
                      <button className="btn btn-primary" onClick={createAdminRoute}>
                        {isEditingAdminRoute ? "Save and Publish Update" : "Save and Publish"}
                      </button>
                      <button className="btn btn-secondary" onClick={resetRouteBuilder}>Reset</button>
                    </div>

                    {selectedAdminRouteNumber && (
                      <div className="route-history-wrap">
                        <div className="route-history-title">
                          Route History
                        </div>
                        <div className="scroll-box revision-scroll">
                          {routeRevisions.length === 0 && (
                            <div className="meta-muted">No revisions yet</div>
                          )}
                          {routeRevisions.map(rev => (
                            <div key={rev.id} className="revision-item">
                              <div className="revision-main">
                                <div className="revision-action">
                                  {rev.action.toUpperCase()}
                                </div>
                                <div className="revision-date">
                                  {new Date(rev.createdAt).toLocaleString()}
                                </div>
                              </div>
                              <button
                                className="btn btn-secondary btn-inline"
                                onClick={() => rollbackAdminRoute(rev.id)}
                              >
                                Rollback
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="admin-empty-note">Login required to use route builder features.</div>
                )}
              </div>
            </details>

            <details className="admin-section admin-section-simulation" open>
              <summary>Simulation Planner</summary>
              <div className="admin-section-body">
                <input
                  className="input"
                  placeholder="Start"
                  value={startQuery}
                  onFocus={() => setActiveSearch("start")}
                  onChange={e => {
                    setStartQuery(e.target.value);
                    setStartPlace(null);
                    setRoutes([]);
                  }}
                />
                {activeSearch === "start" && (
                  <div className="autocomplete">
                    {startResults.map(place => (
                      <div
                        key={place.place_id}
                        className="suggestion"
                        onMouseDown={() => {
                          setStartQuery(place.display_name);
                          setStartPlace(place);
                          setStartResults([]);
                          setActiveSearch(null);
                        }}
                      >
                        {place.display_name}
                      </div>
                    ))}
                  </div>
                )}

                <input
                  className="input"
                  placeholder="End"
                  value={endQuery}
                  onFocus={() => setActiveSearch("end")}
                  onChange={e => {
                    setEndQuery(e.target.value);
                    setEndPlace(null);
                    setRoutes([]);
                  }}
                />
                {activeSearch === "end" && (
                  <div className="autocomplete">
                    {endResults.map(place => (
                      <div
                        key={place.place_id}
                        className="suggestion"
                        onMouseDown={() => {
                          setEndQuery(place.display_name);
                          setEndPlace(place);
                          setEndResults([]);
                          setActiveSearch(null);
                        }}
                      >
                        {place.display_name}
                      </div>
                    ))}
                  </div>
                )}

              </div>
            </details>

            <details className="admin-section admin-section-incidents" open>
              <summary>Incidents</summary>
              <div className="admin-section-body">
                <select className="input" value={incidentType} onChange={e => setIncidentType(e.target.value)}>
                  <option>Accident</option>
                  <option>Road Work</option>
                  <option>Traffic Jam</option>
                  <option>Flood</option>
                </select>

                <div className="admin-inline-row">
                  <button
                    className="btn btn-danger"
                    onClick={() => {
                      setRouteDrawMode(false);
                      setAddingStop(false);
                      setAddingIncident(true);
                    }}
                  >
                    Add Incident on Map
                  </button>
                </div>
              </div>
            </details>
          </div>
        )}
      </div>

      {passengerMode && (
        <div className="passenger-overlay">
          <button className="btn btn-secondary" onClick={() => setPassengerOverlayOpen(v => !v)}>
            {passengerOverlayOpen ? "Hide Dashboard" : "Show Dashboard"}
          </button>

          {passengerOverlayOpen && (
            <div className="list-box passenger-search-box">
              <div className="passenger-search-title">Report Incident</div>
              <select className="input" value={incidentType} onChange={e => setIncidentType(e.target.value)}>
                <option>Accident</option>
                <option>Road Work</option>
                <option>Traffic Jam</option>
                <option>Flood</option>
              </select>
              <button
                className={addingIncident ? "btn btn-danger" : "btn btn-secondary"}
                onClick={() => {
                  setAddingIncident(v => !v);
                }}
              >
                {addingIncident ? "Cancel Incident Pinning" : "Add Incident on Map"}
              </button>
            </div>
          )}

          {passengerOverlayOpen && (
            <div className="list-box passenger-search-box">
              <div className="passenger-search-title">Quick Search</div>
              <input
                className="input"
                placeholder="Search by bus number, stop, or point"
                value={passengerSearchQuery}
                onChange={e => setPassengerSearchQuery(e.target.value)}
              />
              {passengerSearchQuery.trim() && (
                <div className="passenger-search-results">
                  {passengerSearchResults.length === 0 && (
                    <div className="passenger-search-empty">No buses, stops, or points found</div>
                  )}
                  {passengerSearchResults.map(result => (
                    <button
                      key={`${result.type}-search-${result.id}`}
                      type="button"
                      className="passenger-search-item"
                      onClick={() => {
                        if (result.type === "bus") {
                          handlePassengerBusSelect(result.id, { fromSearch: true });
                          return;
                        }
                        if (result.type === "boundary-start" || result.type === "boundary-end") {
                          handlePassengerBoundarySearchSelect(
                            result.id,
                            result.type === "boundary-start" ? "start" : "end"
                          );
                          return;
                        }
                        handlePassengerStopSelect(result.id, { fromSearch: true });
                      }}
                    >
                      <span className="passenger-search-main">
                        {result.type === "bus" && `Bus ${result.label}`}
                        {result.type === "stop" && `Stop ${result.label}`}
                        {result.type === "boundary-start" && `Start ${result.label}`}
                        {result.type === "boundary-end" && `End ${result.label}`}
                      </span>
                      {result.type === "bus" && (
                        <span className={`status-chip ${getStatusClassName(result.status)}`}>
                          {result.status.replaceAll("_", " ")}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {passengerOverlayOpen && selectedPassengerRoute && (
            <div className="passenger-route-dashboard">
              <button className="btn btn-secondary" onClick={() => setSelectedPassengerRoute(null)}>Back to Routes</button>
              <RouteTimeline
                route={selectedPassengerRoute}
                liveBuses={selectedRouteBuses}
                onSelectBus={busId => {
                  handlePassengerBusSelect(busId);
                }}
              />
            </div>
          )}
        </div>
      )}

      {pendingExistingStop && (
        <div className="login-overlay">
          <div className="login-box">
            <h3>Nearby Stop Found</h3>
            <p>
              "{pendingExistingStop.stopName}" is about {pendingExistingStop.distanceMeters}m away.
              Use the same stop for this route?
            </p>
            <div className="modal-actions">
              <button className="btn btn-primary" onClick={useNearbyExistingStop}>Use Existing Stop</button>
              <button className="btn btn-secondary" onClick={createNewStopFromNearbyChoice}>Create New Stop</button>
            </div>
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={cancelPinnedStop}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {pendingStopPoint && !pendingExistingStop && (
        <div className="login-overlay">
          <div className="login-box">
            <h3>Name New Stop</h3>
            <input
              className="input"
              placeholder="Stop name"
              value={pendingStopName}
              onChange={e => setPendingStopName(e.target.value)}
            />
            <div className="modal-actions">
              <button className="btn btn-primary" onClick={savePinnedStop}>Save Stop</button>
              <button className="btn btn-secondary" onClick={cancelPinnedStop}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {incidentPrompt && (
        <div className="login-overlay">
          <div className="login-box">
            <h3>Incident Review</h3>
            <p>
              Incident "{incidentPrompt.incidentType}" has been active for{" "}
              {incidentPrompt.ageMinutes} minutes.
            </p>
            <p>Remove it now if cleared?</p>
            <div className="modal-actions">
              <button
                className="btn btn-danger"
                onClick={() => removeIncident(incidentPrompt.incidentId)}
              >
                Remove Incident
              </button>
              <button
                className="btn btn-secondary"
                onClick={() => setIncidentPromptQueue(prev => prev.slice(1))}
              >
                Later
              </button>
            </div>
          </div>
        </div>
      )}

      {showLogin && (
        <div className="login-overlay">
          <div className="login-box">
            <h3>Admin Login</h3>
            <input type="password" className="input" value={password} onChange={e => setPassword(e.target.value)} />
            <div className="modal-actions">
              <button className="btn btn-primary" onClick={loginAdmin}>Login</button>
              <button className="btn btn-secondary" onClick={() => setShowLogin(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {confirm && (
        <div className="login-overlay">
          <div className="login-box">
            <h3>{confirm.title}</h3>
            <p>{confirm.message}</p>
            <button className="btn btn-secondary" onClick={() => setConfirm(null)}>Close</button>
          </div>
        </div>
      )}

      <FloatingHud
        stats={dashboardStats}
        isAuthenticated={!!token}
        showEtaModel={!passengerMode}
        passengerMode={passengerMode}
      />

      <MapLegend />

      <MapContainer center={[13.08, 77.58]} zoom={12} zoomControl={false} preferCanvas className="map-root">
        <TileLayer
          url={
            darkMode
              ? "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
              : "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          }
        />
        <ZoomControl position="topright" />
        <IncidentClicker enabled={addingIncident} onAdd={addIncident} />
        <IncidentClicker enabled={addingStop} onAdd={addStop} />
        <IncidentClicker enabled={routeDrawMode} onAdd={addRoutePoint} />
        <FollowBus buses={buses} followBus={followBus} onUserMove={() => setFollowBus(null)} />
        <FocusPolyline positions={focusPolylinePositions} />

        {!passengerMode && adminRoutePolylines.map(({ route, positions }) => (
          <Polyline
            key={`admin-route-${String(route._id || route.routeNumber)}`}
            positions={positions}
            interactive={!routeDrawMode && !addingIncident && !addingStop}
            pathOptions={{
              color: route.routeNumber === selectedAdminRouteNumber ? "#22c55e" : "#10b981",
              weight: route.routeNumber === selectedAdminRouteNumber ? 8 : 5,
              opacity: route.routeNumber === selectedAdminRouteNumber ? 0.95 : 0.45
            }}
            eventHandlers={
              routeDrawMode || addingIncident || addingStop
                ? {}
                : {
                    click: e => {
                      setSelectedAdminRouteNumber(route.routeNumber);
                      loadRouteForEdit(route);
                      setRoutePopup({
                        type: "admin",
                        latlng: e.latlng,
                        routeNumber: route.routeNumber
                      });
                    }
                  }
            }
          />
        ))}

        {!passengerMode && routes.map((route, index) => (
          <Polyline
            key={`draft-${index}`}
            positions={route}
            interactive={!routeDrawMode && !addingIncident && !addingStop}
            pathOptions={{
              color: index === activeRouteIndex ? "#2563eb" : "#3b82f6",
              weight: index === activeRouteIndex ? 8 : 6,
              opacity: index === activeRouteIndex ? 1 : 0.35
            }}
            eventHandlers={
              routeDrawMode || addingIncident || addingStop
                ? {}
                : {
                    click: e => {
                      setSelectedRouteIndex(index);
                      setActiveRouteIndex(index);
                      setRoutePopup({ type: "draft", latlng: e.latlng, index });
                    }
                  }
            }
          />
        ))}

        {selectedRoutePolyline.length > 0 && (
          <Polyline positions={selectedRoutePolyline} pathOptions={{ color: "#22c55e", weight: 7, opacity: 0.9 }} />
        )}
        {!passengerMode && routeBuilder.polyline.length > 1 && (
          <Polyline positions={routeBuilder.polyline.map(p => [p.lat, p.lng])} pathOptions={{ color: "#f97316", weight: 5, opacity: 0.9 }} />
        )}

        {boundaryRoutePoints && (
          <>
            <Marker
              ref={startBoundaryMarkerRef}
              position={boundaryRoutePoints.startPosition}
              icon={startPointIcon}
              eventHandlers={{
                click: () => handleBoundaryPointSelect("start", { fromSearch: false }),
                popupclose: () => {
                  if (selectedBoundaryPoint === "start") setSelectedBoundaryPoint(null);
                }
              }}
            >
              <Popup>
                <div className="popup-card">
                  <div className="popup-title">{boundaryRoutePoints.startName}</div>
                  {passengerMode && selectedBoundaryPoint === "start" && (
                    <div className="popup-text">
                      {(() => {
                        const summary = boundaryRoutePoints.startStopId
                          ? stopPopupArrivalById[boundaryRoutePoints.startStopId]
                          : null;
                        if (!summary?.up && !summary?.down) return "No buses approaching";
                        const upText = summary?.up ? `${summary.up.busId} ${summary.up.eta ?? "-"} min` : "-";
                        const downText = summary?.down ? `${summary.down.busId} ${summary.down.eta ?? "-"} min` : "-";
                        return `UP: ${upText} | DOWN: ${downText}`;
                      })()}
                    </div>
                  )}
                </div>
              </Popup>
            </Marker>

            <Marker
              ref={endBoundaryMarkerRef}
              position={boundaryRoutePoints.endPosition}
              icon={endPointIcon}
              eventHandlers={{
                click: () => handleBoundaryPointSelect("end", { fromSearch: false }),
                popupclose: () => {
                  if (selectedBoundaryPoint === "end") setSelectedBoundaryPoint(null);
                }
              }}
            >
              <Popup>
                <div className="popup-card">
                  <div className="popup-title">{boundaryRoutePoints.endName}</div>
                  {passengerMode && selectedBoundaryPoint === "end" && (
                    <div className="popup-text">
                      {(() => {
                        const summary = boundaryRoutePoints.endStopId
                          ? stopPopupArrivalById[boundaryRoutePoints.endStopId]
                          : null;
                        if (!summary?.up && !summary?.down) return "No buses approaching";
                        const upText = summary?.up ? `${summary.up.busId} ${summary.up.eta ?? "-"} min` : "-";
                        const downText = summary?.down ? `${summary.down.busId} ${summary.down.eta ?? "-"} min` : "-";
                        return `UP: ${upText} | DOWN: ${downText}`;
                      })()}
                    </div>
                  )}
                </div>
              </Popup>
            </Marker>
          </>
        )}

        {stops.map(stop => {
          const stopId = String(stop.id || stop._id);
          const stopArrival = stopPopupArrivalById[stopId] || null;
          const isSharedStop = Number(stopRouteCountById.get(stopId) || 0) > 1;
          const showMultiRouteEta = passengerMode && isSharedStop;
          const showSingleRouteEta = passengerMode && selectedRouteStopIds.has(stopId) && !showMultiRouteEta;
          return (
            <Marker
              key={stopId}
              ref={ref => {
                if (ref) stopMarkerRefs.current.set(stopId, ref);
                else stopMarkerRefs.current.delete(stopId);
              }}
              position={[stop.location.lat, stop.location.lng]}
              icon={stopIcon}
              eventHandlers={{
                click: () => {
                  if (!passengerMode) return;
                  setSelectedStop(stopId);
                  setSelectedBoundaryPoint(null);
                  const routeContext = selectedPassengerRoute || findRouteForStop(stopId) || null;
                  fetchNearestArrivalForStop(stopId, routeContext).catch(() => undefined);
                },
                popupclose: () => {
                  if (String(selectedStop || "") === stopId) {
                    setSelectedStop(null);
                  }
                }
              }}
            >
              <Popup>
                <div className="popup-card">
                  <div className="popup-title">{sanitizeStopName(stop.name) || `Stop ${stopId.slice(-4)}`}</div>
                  {showSingleRouteEta && (
                    <div className="popup-text">
                      {stopArrival?.up || stopArrival?.down
                        ? `UP: ${stopArrival?.up ? `${stopArrival.up.busId} ${stopArrival.up.eta ?? "-"} min` : "-"} | DOWN: ${stopArrival?.down ? `${stopArrival.down.busId} ${stopArrival.down.eta ?? "-"} min` : "-"}`
                        : "No buses approaching"}
                    </div>
                  )}
                  {showMultiRouteEta && (
                    <div className="popup-text">
                      {stopArrival?.routeGroups?.length ? (
                        <>
                          <div className="popup-route-title">Shared stop arrivals</div>
                          {stopArrival.routeGroups.map(group => (
                            <div key={`${stopId}-${group.routeLabel}`} className="popup-route-group">
                              <span className="popup-route-label">{group.routeLabel}:</span>{" "}
                              {group.arrivals
                                .map(item => `${item.busId} ${item.eta ?? "-"}m (${item.direction})`)
                                .join(", ")}
                            </div>
                          ))}
                        </>
                      ) : (
                        "No buses approaching"
                      )}
                    </div>
                  )}
                  {!passengerMode && token && (
                    <button className="popup-remove-btn" onClick={() => removeExistingStop(stopId)}>
                      Remove Stop
                    </button>
                  )}
                </div>
              </Popup>
            </Marker>
          );
        })}

        {incidents.map(incident => (
          <Marker
            key={incident.id}
            position={[incident.location.lat, incident.location.lng]}
            icon={incidentIcons[incident.type] || incidentIcons.Accident}
            zIndexOffset={1000}
          >
            <Popup>
              <div className="popup-card">
                <div className="popup-title">Incident</div>
                <div className="popup-text">{incident.type}</div>
                <button className="popup-remove-btn" onClick={() => removeIncident(incident.id)}>
                  Remove
                </button>
              </div>
            </Popup>
          </Marker>
        ))}

        {buses
          .filter(b => b.locationArr)
          .map(bus => (
            <BusMarker
              key={bus.id}
              bus={bus}
              nextStopName={stopNameMap.get(String(bus.nextStop || "")) || null}
              onClick={() => {
                handlePassengerBusSelect(bus.id);
              }}
            />
          ))}

        {selectedBusNextStopMarker && (
          <CircleMarker
            center={[selectedBusNextStopMarker.lat, selectedBusNextStopMarker.lng]}
            radius={10}
            pathOptions={{ color: "#f59e0b", weight: 3 }}
          />
        )}

        {routePopup && !passengerMode && (
          <Popup position={routePopup.latlng} onClose={() => setRoutePopup(null)}>
            {routePopup.type === "admin" ? (
              <div className="popup-card">
                <div className="popup-title">Route {routePopup.routeNumber}</div>
                <button
                  className="popup-remove-btn"
                  onClick={() => deleteAdminRoute(routePopup.routeNumber)}
                >
                  Delete Route
                </button>
              </div>
            ) : (
              <div className="popup-card">
                <div className="popup-title">Draft Route {routePopup.index + 1}</div>
                <div className="popup-text">Selected for route builder</div>
              </div>
            )}
          </Popup>
        )}
      </MapContainer>
    </div>
  );
}

