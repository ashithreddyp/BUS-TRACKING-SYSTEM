import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";
import {
  Circle,
  MapContainer,
  Marker,
  Polyline,
  Popup,
  TileLayer,
  ZoomControl
} from "react-leaflet";
import "leaflet/dist/leaflet.css";

import "./App.css";
import IncidentClicker from "./components/map/IncidentClicker";
import FollowBus from "./components/map/FollowBus";
import FocusPolyline from "./components/map/FocusPolyline";
import BusMarker from "./components/map/BusMarker";
import PassengerSelectionFocus from "./components/map/PassengerSelectionFocus";
import FloatingHud from "./components/ui/FloatingHud";
import MapLegend from "./components/ui/MapLegend";
import AdminPanel from "./components/ui/AdminPanel";
import PassengerOverlay from "./components/ui/PassengerOverlay";
import AppModals from "./components/ui/AppModals";
import {
  incidentIcons,
  stopIcon,
  selectedStopIcon,
  startPointIcon,
  endPointIcon
} from "./components/map/icons";
import usePlaceSearch from "./hooks/usePlaceSearch";
import {
  API_BASE_URL,
  DEFAULT_ML_STATUS,
  INCIDENT_TYPES,
  MAP_CENTER,
  MODE_STORAGE_KEY,
  SOCKET_URL,
  STOP_REUSE_RADIUS_METERS,
  THEME_STORAGE_KEY
} from "./constants/appConstants";
import {
  createEmptyRouteBuilder,
  findNearbyExistingStop,
  getStatusClassName,
  formatStatusLabel,
  parseOsrmRoutes,
  placeLabel,
  resolveBoundaryStopId,
  sanitizeStopName
} from "./utils/appHelpers";
import normalizeBus from "./utils/normalizeBus";
import {
  buildPassengerSearchResults,
  buildVisibleBoundaryMarkers,
  findSelectedBoundaryMarker
} from "./utils/passengerViewUtils";

const socket = io(SOCKET_URL);

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

function estimateFinalEtaFromStops(routeStops, nextStopId, finalStopId, baseEtaMinutes) {
  const stopsList = Array.isArray(routeStops) ? routeStops : [];
  const nextId = String(nextStopId || "");
  const finalId = String(finalStopId || "");
  const baseEta = Number(baseEtaMinutes);
  if (!nextId || !finalId || !Number.isFinite(baseEta) || baseEta < 0) return null;

  const stopIds = stopsList.map(stop => String(stop?._id || stop?.id || stop || ""));
  const nextIdx = stopIds.indexOf(nextId);
  const finalIdx = stopIds.indexOf(finalId);
  if (nextIdx === -1 || finalIdx === -1) return null;
  if (nextIdx === finalIdx) return Math.max(0, Math.round(baseEta));

  const AVG_SPEED_KMPH = 30;
  const STOP_DWELL_MIN = 1;
  const step = nextIdx < finalIdx ? 1 : -1;
  let eta = Math.max(0, Number(baseEta) || 0);
  let idx = nextIdx;

  while (idx !== finalIdx) {
    const currentStop = stopsList[idx];
    const nextStop = stopsList[idx + step];
    const km = distanceKm(currentStop?.location, nextStop?.location);
    const travelMin = Number.isFinite(km)
      ? Math.max(1, Math.min(18, Math.round((km / AVG_SPEED_KMPH) * 60)))
      : 2;
    eta += STOP_DWELL_MIN;
    eta += travelMin;
    idx += step;
  }

  return Math.max(0, Math.round(eta));
}

export default function App() {
  const [startQuery, setStartQuery] = useState("");
  const [endQuery, setEndQuery] = useState("");
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
  const [incidentType, setIncidentType] = useState(INCIDENT_TYPES[0]);
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
  const [mlStatus, setMlStatus] = useState(DEFAULT_ML_STATUS);
  const [incidentPromptQueue, setIncidentPromptQueue] = useState([]);

  const [passengerMode, setPassengerMode] = useState(() => {
    const savedMode = localStorage.getItem(MODE_STORAGE_KEY);
    const hasToken = !!localStorage.getItem("token");
    if (savedMode === "admin") return hasToken ? false : true;
    if (savedMode === "passenger") return true;
    return true;
  });
  const [selectedPassengerRoute, setSelectedPassengerRoute] = useState(null);
  const [passengerOverlayOpen, setPassengerOverlayOpen] = useState(false);
  const [passengerLegendOpen, setPassengerLegendOpen] = useState(true);
  const [passengerFocusedRouteIds, setPassengerFocusedRouteIds] = useState([]);
  const [selectedStop, setSelectedStop] = useState(null);
  const [selectedBoundaryPoint, setSelectedBoundaryPoint] = useState(null);
  const [selectedBoundaryRouteId, setSelectedBoundaryRouteId] = useState("");
  const [passengerSearchSelectionNonce, setPassengerSearchSelectionNonce] = useState(0);
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
  const boundaryMarkerRefs = useRef(new Map());
  const placeSearchCacheRef = useRef(new Map());
  const routeCacheRef = useRef(new Map());
  const routeAbortRef = useRef(null);
  const routeRequestSeqRef = useRef(0);
  const incidentPrompt = incidentPromptQueue[0] || null;
  const startResults = usePlaceSearch(startQuery, placeSearchCacheRef);
  const endResults = usePlaceSearch(endQuery, placeSearchCacheRef);

  const selectedRoutePolyline = useMemo(() => {
    if (!selectedPassengerRoute?.polyline?.length) return [];
    return selectedPassengerRoute.polyline.map(p => [p.lat, p.lng]);
  }, [selectedPassengerRoute]);

  const focusedPassengerRoutes = useMemo(() => {
    const ids = (passengerFocusedRouteIds || []).map(String).filter(Boolean);
    return ids
      .map(id => passengerRoutesCatalog.find(route => String(route?._id || "") === id))
      .filter(Boolean)
      .map(route => ({
        id: String(route._id),
        routeNumber: route.routeNumber || "",
        stopIds: (route.stops || [])
          .map(stopRef => String(stopRef?._id || stopRef?.id || stopRef || ""))
          .filter(Boolean),
        positions: (route.polyline || [])
          .map(point => [Number(point?.lat), Number(point?.lng)])
          .filter(point => Number.isFinite(point[0]) && Number.isFinite(point[1]))
      }))
      .filter(entry => entry.positions.length > 1);
  }, [passengerFocusedRouteIds, passengerRoutesCatalog]);

  const focusPolylinePositions = useMemo(() => {
    if (passengerMode) {
      if (selectedRoutePolyline.length) return selectedRoutePolyline;
      return focusedPassengerRoutes[0]?.positions || [];
    }
    return selectedRoutePolyline.length ? selectedRoutePolyline : routes[activeRouteIndex] || [];
  }, [activeRouteIndex, focusedPassengerRoutes, passengerMode, routes, selectedRoutePolyline]);

  const selectedRouteBuses = useMemo(() => {
    if (!selectedPassengerRoute?._id) return [];
    return buses.filter(b => String(b.routeId || "") === String(selectedPassengerRoute._id));
  }, [buses, selectedPassengerRoute]);

  const passengerFocusedRouteIdSet = useMemo(
    () =>
      new Set(
        focusedPassengerRoutes
          .map(route => String(route.id || ""))
          .filter(Boolean)
      ),
    [focusedPassengerRoutes]
  );

  const passengerVisibleStopIdSet = useMemo(
    () =>
      new Set(
        focusedPassengerRoutes
          .flatMap(route => route.stopIds || [])
          .map(String)
          .filter(Boolean)
      ),
    [focusedPassengerRoutes]
  );

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


  const selectedStopPosition = useMemo(() => {
    if (!selectedStop) return null;
    const stop = stops.find(s => String(s.id || s._id) === String(selectedStop));
    if (!stop?.location) return null;
    const lat = Number(stop.location.lat);
    const lng = Number(stop.location.lng);
    return Number.isFinite(lat) && Number.isFinite(lng) ? [lat, lng] : null;
  }, [selectedStop, stops]);

  const selectedBusPosition = useMemo(() => {
    if (!selectedBus) return null;
    const bus = buses.find(b => String(b.id) === String(selectedBus));
    if (!Array.isArray(bus?.locationArr) || bus.locationArr.length < 2) return null;
    const lat = Number(bus.locationArr[0]);
    const lng = Number(bus.locationArr[1]);
    return Number.isFinite(lat) && Number.isFinite(lng) ? [lat, lng] : null;
  }, [buses, selectedBus]);

  const selectedAdminRoute = useMemo(() => {
    if (!selectedAdminRouteNumber) return null;
    return adminRoutes.find(route => route.routeNumber === selectedAdminRouteNumber) || null;
  }, [adminRoutes, selectedAdminRouteNumber]);

  const adminBoundaryRouteContext = useMemo(() => {
    if (passengerMode) return null;
    const draftPolyline = (routeBuilder.polyline || [])
      .map(point => ({ lat: Number(point?.lat), lng: Number(point?.lng) }))
      .filter(point => Number.isFinite(point.lat) && Number.isFinite(point.lng));
    if (draftPolyline.length > 1) {
      return {
        polyline: draftPolyline,
        stops: routeBuilder.stops || [],
        startPointName: routeBuilder.startPointName || selectedAdminRoute?.startPointName || "Start Point",
        endPointName: routeBuilder.endPointName || selectedAdminRoute?.endPointName || "End Point"
      };
    }
    return selectedAdminRoute;
  }, [
    passengerMode,
    routeBuilder.endPointName,
    routeBuilder.polyline,
    routeBuilder.startPointName,
    routeBuilder.stops,
    selectedAdminRoute
  ]);

  const activeRouteForStopMarkers = useMemo(() => {
    if (passengerMode) return selectedPassengerRoute || null;
    return adminBoundaryRouteContext;
  }, [adminBoundaryRouteContext, passengerMode, selectedPassengerRoute]);

  const visibleBoundaryMarkers = useMemo(() => {
    return buildVisibleBoundaryMarkers({
      passengerMode,
      passengerFocusedRouteIds,
      passengerRoutesCatalog,
      adminBoundaryRouteContext
    });
  }, [adminBoundaryRouteContext, passengerFocusedRouteIds, passengerMode, passengerRoutesCatalog]);

  const selectedBoundaryMeta = useMemo(() => {
    return findSelectedBoundaryMarker({
      selectedBoundaryPoint,
      selectedBoundaryRouteId,
      visibleBoundaryMarkers
    });
  }, [selectedBoundaryPoint, selectedBoundaryRouteId, visibleBoundaryMarkers]);

  const selectedBoundaryPosition = useMemo(() => {
    const position = selectedBoundaryMeta?.position || null;
    if (!Array.isArray(position) || position.length < 2) return null;
    const lat = Number(position[0]);
    const lng = Number(position[1]);
    return Number.isFinite(lat) && Number.isFinite(lng) ? [lat, lng] : null;
  }, [selectedBoundaryMeta]);

  const passengerSearchResults = useMemo(() => {
    return buildPassengerSearchResults({
      query: passengerSearchQuery,
      buses,
      stops,
      passengerRoutesCatalog
    });
  }, [buses, passengerRoutesCatalog, passengerSearchQuery, stops]);

  const findRouteForBus = useCallback(busId => {
    const bus = buses.find(b => String(b.id) === String(busId));
    if (!bus?.routeId) return null;
    return (
      passengerRoutesCatalog.find(route => String(route._id) === String(bus.routeId)) || null
    );
  }, [buses, passengerRoutesCatalog]);

  const findAnyRouteForBus = useCallback(bus => {
    const routeId = String(bus?.routeId || "");
    if (!routeId) return null;
    return (
      passengerRoutesCatalog.find(route => String(route?._id || "") === routeId) ||
      adminRoutes.find(route => String(route?._id || route?.id || "") === routeId) ||
      null
    );
  }, [adminRoutes, passengerRoutesCatalog]);

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

  const findRoutesForStop = useCallback(
    stopId =>
      passengerRoutesCatalog.filter(route =>
        (route.stops || []).some(stop => String(stop?._id || stop?.id || stop) === String(stopId))
      ),
    [passengerRoutesCatalog]
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

  const renderArrivalItem = useCallback((row, routeLabelOverride = null, key = "") => {
    if (!row) return null;
    const displayStatus =
      row?.status === "STOPPED_AT_STOP" && Number(row?.eta) > 1
        ? "ON_TIME"
        : row?.status || "ON_TIME";
    const statusLabel = formatStatusLabel(displayStatus);
    const statusClass = getStatusClassName(displayStatus);
    const etaValue = Number.isFinite(Number(row?.eta)) ? Math.max(0, Math.round(Number(row.eta))) : null;
    const routeLabel = String(routeLabelOverride || row?.routeNumber || row?.routeId || "").trim();
    const busId = String(row?.busId || "").trim();
    const directionRaw = String(row?.direction || "").trim().toUpperCase();
    const directionText = directionRaw === "DOWN" || directionRaw === "UP" ? ` (${directionRaw})` : "";
    const baseLabel =
      routeLabel && busId
        ? routeLabel.toLowerCase() === busId.toLowerCase()
          ? routeLabel
          : `${routeLabel} / ${busId}`
        : busId || routeLabel || "Bus";
    let etaLower = Number.isFinite(Number(row?.etaLower)) ? Math.max(0, Math.round(Number(row.etaLower))) : null;
    let etaUpper = Number.isFinite(Number(row?.etaUpper)) ? Math.max(0, Math.round(Number(row.etaUpper))) : null;
    const hasOperationalImpact =
      Number(row?.incidentsNearby || 0) > 0 ||
      String(displayStatus).toUpperCase().includes("DELAY");
    const maxRangeSpread = hasOperationalImpact ? 12 : 6;
    if (etaValue != null && (etaLower == null || etaUpper == null)) {
      const fallbackPlusMinus = hasOperationalImpact
        ? Math.max(2, Math.min(6, Math.round(Math.max(etaValue, 1) * 0.12)))
        : Math.max(1, Math.min(3, Math.round(Math.max(etaValue, 1) * 0.08)));
      etaLower = Math.max(0, etaValue - fallbackPlusMinus);
      etaUpper = etaValue + fallbackPlusMinus;
    }
    if (etaValue != null && etaLower != null && etaUpper != null) {
      etaLower = Math.max(0, Math.min(etaLower, etaValue));
      etaUpper = Math.max(etaLower, etaUpper);
      if (etaUpper - etaLower > maxRangeSpread) {
        const plusMinus = Math.max(1, Math.round(maxRangeSpread / 2));
        etaLower = Math.max(0, etaValue - plusMinus);
        etaUpper = Math.max(etaLower, etaValue + plusMinus);
      }
    }
    const showRange = etaValue != null && etaLower != null && etaUpper != null && (etaUpper > etaLower);
    return (
      <span
        key={key || `${row.routeNumber || routeLabelOverride || "route"}-${row.busId || "bus"}-${row.direction || "dir"}-${row.eta || 0}`}
        className="popup-route-item"
      >
        <span className="popup-route-item-body">
          <span className="popup-route-item-main">
            {baseLabel} - ETA: {etaValue == null ? "-" : `${etaValue} min`}{directionText}
          </span>
          {showRange && (
            <span className="popup-route-item-subtle">
              ETA Range: {etaLower}-{etaUpper} min
            </span>
          )}
        </span>
        <span className={`status-chip ${statusClass}`}>{statusLabel}</span>
      </span>
    );
  }, []);

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

  const renderDirectionalEta = useCallback(summary => {
    const allArrivals = (Array.isArray(summary?.arrivals) ? summary.arrivals : [])
      .filter(row => row && Number.isFinite(row.eta))
      .sort((a, b) => (a.eta ?? Infinity) - (b.eta ?? Infinity));
    const fastestArrival = summary?.fastestArrival || null;
    const fastestKey = fastestArrival
      ? [
          String(fastestArrival.routeNumber || fastestArrival.routeId || ""),
          String(fastestArrival.busId || ""),
          String(fastestArrival.direction || fastestArrival.travelDirection || "")
        ].join("|")
      : "";
    const isDown = row =>
      String(row?.direction || "").toUpperCase() === "DOWN" ||
      Number(row?.travelDirection) === -1;
    const isUp = row =>
      String(row?.direction || "").toUpperCase() === "UP" ||
      Number(row?.travelDirection) === 1 ||
      (!String(row?.direction || "").trim() && Number(row?.travelDirection) !== -1);

    const isNotFastest = row =>
      [
        String(row?.routeNumber || row?.routeId || ""),
        String(row?.busId || ""),
        String(row?.direction || row?.travelDirection || "")
      ].join("|") !== fastestKey;

    const upRows = allArrivals.filter(row => isUp(row) && isNotFastest(row));
    const downRows = allArrivals.filter(row => isDown(row) && isNotFastest(row));

    if (!upRows.length && !downRows.length && !summary?.up && !summary?.down) {
      return <span>No buses approaching</span>;
    }

    const formatRows = (rows, fallbackRow) => {
      const directionalRows = rows.length ? rows : fallbackRow ? [fallbackRow] : [];
      if (!directionalRows.length) return <span>-</span>;
      return (
        <div className="popup-direction-list">
          {directionalRows.map((row, index) =>
            renderArrivalItem(
              row,
              summary?.hasMultipleRoutes ? row.routeNumber || null : null,
              `direction-${row.routeNumber || "route"}-${row.busId || "bus"}-${row.direction || "dir"}-${index}`
            )
          )}
        </div>
      );
    };

    return (
      <div className="popup-lines">
        <div className="popup-line">
          <span className="popup-line-label">UP:</span> {formatRows(upRows, summary?.up)}
        </div>
        <div className="popup-line">
          <span className="popup-line-label">DOWN:</span> {formatRows(downRows, summary?.down)}
        </div>
      </div>
    );
  }, [renderArrivalItem]);

  const renderFastestArrival = useCallback(summary => {
    const fastestArrival = summary?.fastestArrival || null;
    if (!fastestArrival) return null;
    return (
      <div className="popup-arrival-section popup-fastest-section">
        <div className="popup-route-title">Fastest Bus</div>
        <div className="popup-line popup-fastest-line">
          <div className="popup-direction-list">
            {renderArrivalItem(
              fastestArrival,
              summary?.hasMultipleRoutes ? fastestArrival.routeNumber || null : null,
              "fastest-arrival"
            )}
          </div>
        </div>
      </div>
    );
  }, [renderArrivalItem]);

  const fetchNearestArrivalForStop = useCallback(async (stopId, route = null) => {

    const response = await fetch(`${API_BASE_URL}/api/passenger/stop/${encodeURIComponent(stopId)}/arrivals`);
    const data = await response.json().catch(() => ({ arrivals: [], fastestArrival: null }));
    const arrivalsAll = (Array.isArray(data?.arrivals) ? data.arrivals : [])
      .filter(row => row && Number.isFinite(row.eta))
      .sort((a, b) => (a.eta ?? Infinity) - (b.eta ?? Infinity));
    const routeKeys = new Set(
      arrivalsAll
        .map(arrival => String(arrival?.routeNumber || arrival?.routeId || "").trim())
        .filter(Boolean)
    );
    const hasMultipleRoutes = routeKeys.size > 1;
    const routeId = route?._id ? String(route._id) : null;
    const routeNumber = route?.routeNumber ? String(route.routeNumber) : null;
    const routeFiltered = route
      ? arrivalsAll.filter(arrival => {
          if (routeId && String(arrival.routeId || "") === routeId) return true;
          if (routeNumber && String(arrival.routeNumber || "") === routeNumber) return true;
          return false;
        })
      : arrivalsAll;
    let activeRows = routeFiltered.length ? routeFiltered : arrivalsAll;
    let directionalSummary = pickDirectionalArrivals(activeRows);
    if (hasMultipleRoutes) {
      directionalSummary = pickDirectionalArrivals(arrivalsAll);
    }

    setStopPopupArrivalById(prev => ({
      ...prev,
      [String(stopId)]: {
        ...directionalSummary,
        fastestArrival: data?.fastestArrival || arrivalsAll[0] || null,
        hasMultipleRoutes,
        arrivals: arrivalsAll
      }
    }));
  }, [pickDirectionalArrivals]);

  useEffect(() => {
    if (!passengerMode || !selectedPassengerRoute?.routeNumber) return;
    let cancelled = false;
    const routeNumber = selectedPassengerRoute.routeNumber;
    const stopIds = (selectedPassengerRoute.stops || []).map(stop =>
      String(stop?._id || stop?.id || stop || "")
    );
    const preloadBase = {};
    stopIds.forEach(id => {
      const isSharedStop = Number(stopRouteCountById.get(id) || 0) > 1;
      if (id && !isSharedStop) {
        preloadBase[id] = {
          up: null,
          down: null,
          hasMultipleRoutes: false,
          arrivals: []
        };
      }
    });

    const refreshRouteTimeline = async () => {
      const preload = { ...preloadBase };

      const timelineResponse = await fetch(
        `${API_BASE_URL}/api/passenger/route/${encodeURIComponent(routeNumber)}/timeline`
      );
      const timelineData = await timelineResponse.json().catch(() => ({ stopTimeline: [] }));
      const stopTimeline = Array.isArray(timelineData?.stopTimeline) ? timelineData.stopTimeline : [];
      stopTimeline.forEach(entry => {
        const stopId = String(entry?.stopId || "");
        if (!stopId) return;
        if (Number(stopRouteCountById.get(stopId) || 0) > 1) return;
        const rows = (Array.isArray(entry?.arrivals) ? entry.arrivals : [])
          .filter(row => row && Number.isFinite(row.eta))
          .sort((a, b) => (a.eta ?? Infinity) - (b.eta ?? Infinity));
        const directional = pickDirectionalArrivals(rows);
        preload[stopId] = {
          ...directional,
          fastestArrival: rows[0] || null,
          hasMultipleRoutes: false,
          arrivals: rows
        };
      });

      if (cancelled) return;
      setStopPopupArrivalById(prev => ({ ...prev, ...preload }));
    };

    refreshRouteTimeline().catch(() => undefined);
    const intervalId = setInterval(() => {
      refreshRouteTimeline().catch(() => undefined);
    }, 8000);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [
    passengerMode,
    pickDirectionalArrivals,
    selectedPassengerRoute,
    stopRouteCountById
  ]);

  useEffect(() => {
    if (!passengerMode) return;
    const selectedStopId = selectedStop ? String(selectedStop) : null;
    const boundaryStopId = selectedBoundaryMeta?.stopId || null;
    const targetStopId = selectedStopId || (boundaryStopId ? String(boundaryStopId) : null);
    if (!targetStopId) return;

    const routeContext =
      (selectedBoundaryMeta?.routeId
        ? passengerRoutesCatalog.find(
            item => String(item?._id || "") === String(selectedBoundaryMeta.routeId)
          )
        : null) ||
      selectedPassengerRoute ||
      activeRouteForStopMarkers ||
      null;
    const refreshSelectedStop = async () => {
      await fetchNearestArrivalForStop(targetStopId, routeContext);
    };

    refreshSelectedStop().catch(() => undefined);
    const intervalId = setInterval(() => {
      refreshSelectedStop().catch(() => undefined);
    }, 8000);
    return () => clearInterval(intervalId);
  }, [
    activeRouteForStopMarkers,
    fetchNearestArrivalForStop,
    passengerMode,
    passengerRoutesCatalog,
    selectedBoundaryMeta,
    selectedBoundaryPoint,
    selectedPassengerRoute,
    selectedStop
  ]);

  useEffect(() => {
    if (!selectedBus) return;
    const bus = buses.find(item => String(item.id) === String(selectedBus));
    if (!bus) return;

    const route = findAnyRouteForBus(bus);
    if (!route) return;

    const selectedStopId = selectedStop ? String(selectedStop) : "";
    const selectedBoundaryStopId = String(selectedBoundaryMeta?.stopId || "");
    const finalStopRef =
      Number(bus.travelDirection) === -1
        ? route.stops?.[0]
        : route.stops?.[route.stops.length - 1];
    const finalStopId = String(finalStopRef?._id || finalStopRef?.id || finalStopRef || "");
    const targetStopId = selectedStopId || selectedBoundaryStopId || finalStopId;
    const stopIdsToRefresh = [targetStopId, finalStopId].map(String).filter(Boolean);
    const uniqueStopIds = [...new Set(stopIdsToRefresh)];
    if (!uniqueStopIds.length) return;

    const refreshBusPopupEta = async () => {
      await Promise.all(
        uniqueStopIds.map(stopId => fetchNearestArrivalForStop(stopId, route))
      );
    };

    refreshBusPopupEta().catch(() => undefined);
    const intervalId = setInterval(() => {
      refreshBusPopupEta().catch(() => undefined);
    }, 8000);
    return () => clearInterval(intervalId);
  }, [
    buses,
    fetchNearestArrivalForStop,
    findAnyRouteForBus,
    selectedBoundaryMeta,
    selectedBoundaryPoint,
    selectedBus,
    selectedStop
  ]);

  const handlePassengerBusSelect = useCallback((busId, options = {}) => {
    const fromSearch = !!options.fromSearch;
    setSelectedBus(busId);
    setFollowBus(busId);
    setSelectedStop(null);
    setSelectedBoundaryPoint(null);
    setSelectedBoundaryRouteId("");
    if (!passengerMode) return;
    if (fromSearch) {
      setPassengerSearchSelectionNonce(prev => prev + 1);
      const route = findRouteForBus(busId);
      setSelectedPassengerRoute(route || null);
      setPassengerFocusedRouteIds(route?._id ? [String(route._id)] : []);
    }
  }, [findRouteForBus, passengerMode]);

  const handlePassengerStopSelect = useCallback(async (stopId, options = {}) => {
    const fromSearch = !!options.fromSearch;
    const targetStopId = String(stopId);
    setSelectedStop(targetStopId);
    setSelectedBoundaryPoint(null);
    setSelectedBoundaryRouteId("");
    const matchedRoutes = findRoutesForStop(targetStopId);
    const route = matchedRoutes[0] || findRouteForStop(targetStopId);
    if (passengerMode && fromSearch) {
      setPassengerSearchSelectionNonce(prev => prev + 1);
      setSelectedPassengerRoute(route || null);
      setPassengerFocusedRouteIds(
        matchedRoutes.map(item => String(item?._id || "")).filter(Boolean)
      );
    }
    await fetchNearestArrivalForStop(
      targetStopId,
      passengerMode ? (fromSearch ? route : (selectedPassengerRoute || route)) : null
    );
  }, [fetchNearestArrivalForStop, findRouteForStop, findRoutesForStop, passengerMode, selectedPassengerRoute]);

  const handleBoundaryPointSelect = useCallback(async (boundaryType, routeContext = null, options = {}) => {
    const routeId = String(routeContext?._id || routeContext?.id || "");
    const linkedStopId = resolveBoundaryStopId(routeContext || activeRouteForStopMarkers, boundaryType);
    setSelectedBoundaryPoint(boundaryType);
    setSelectedBoundaryRouteId(routeId);
    setSelectedStop(null);
    if (passengerMode && routeId) {
      setSelectedPassengerRoute(routeContext || null);
      setPassengerFocusedRouteIds([routeId]);
    }
    if (passengerMode && linkedStopId) {
      await fetchNearestArrivalForStop(linkedStopId, routeContext || activeRouteForStopMarkers || null);
    }
  }, [activeRouteForStopMarkers, fetchNearestArrivalForStop, passengerMode]);

  const handlePassengerBoundarySearchSelect = useCallback(async (routeId, boundaryType) => {
    if (!passengerMode) return;
    setPassengerSearchSelectionNonce(prev => prev + 1);
    const route =
      passengerRoutesCatalog.find(item => String(item?._id || "") === String(routeId)) || null;
    setSelectedPassengerRoute(route);
    setPassengerFocusedRouteIds(route?._id ? [String(route._id)] : []);
    setSelectedBus("");
    setFollowBus(null);
    setSelectedStop(null);
    setSelectedBoundaryPoint(boundaryType);
    setSelectedBoundaryRouteId(String(routeId || ""));
    const linkedStopId = resolveBoundaryStopId(route, boundaryType);
    if (linkedStopId) {
      await fetchNearestArrivalForStop(linkedStopId, route);
    }
  }, [fetchNearestArrivalForStop, passengerMode, passengerRoutesCatalog]);

  const clearPassengerRouteSelection = useCallback(() => {
    setSelectedPassengerRoute(null);
    setPassengerFocusedRouteIds([]);
    setSelectedStop(null);
    setSelectedBoundaryPoint(null);
    setSelectedBoundaryRouteId("");
  }, []);

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

  const findBusArrivalAtStop = useCallback((stopId, bus) => {
    const targetStopId = String(stopId || "");
    const busId = String(bus?.id || "");
    if (!targetStopId || !busId) return null;
    const stopArrival = stopPopupArrivalById[targetStopId];
    const arrivals = Array.isArray(stopArrival?.arrivals) ? stopArrival.arrivals : [];
    const routeId = String(bus?.routeId || "");
    const routeNumber = String(bus?.routeNumber || "");
    return (
      arrivals.find(arrival => {
        if (String(arrival?.busId || "") !== busId) return false;
        if (routeId && String(arrival?.routeId || "") === routeId) return true;
        if (routeNumber && String(arrival?.routeNumber || "") === routeNumber) return true;
        return !routeId && !routeNumber;
      }) || null
    );
  }, [stopPopupArrivalById]);

  const resolveBusNextStopName = useCallback(
    bus => {
      const rawNextStop = bus?.nextStop;
      const nextStopId = rawNextStop && typeof rawNextStop === "object"
        ? String(rawNextStop?._id || rawNextStop?.id || "")
        : String(rawNextStop || "");
      if (!nextStopId) return null;

      const direct = stopNameMap.get(nextStopId);
      if (direct) return direct;

      const route = passengerRoutesCatalog.find(
        r => String(r?._id || "") === String(bus?.routeId || "")
      );
      if (!route) return null;

      const nextStopRef = (route.stops || []).find(
        stopRef => String(stopRef?._id || stopRef?.id || stopRef || "") === nextStopId
      );
      return sanitizeStopName(nextStopRef?.name) || stopNameMap.get(nextStopId) || null;
    },
    [passengerRoutesCatalog, stopNameMap]
  );

  const buildBusPopupEtaMeta = useCallback((bus, nextStopName = null) => {
    if (!bus) {
      return {
        label: "ETA",
        value: null,
        etaLower: null,
        etaUpper: null,
        finalValue: null,
        finalEtaLower: null,
        finalEtaUpper: null
      };
    }

    const route = findAnyRouteForBus(bus);
    const routeStops = Array.isArray(route?.stops) ? route.stops : [];
    const nextStopId = String(bus?.nextStop || "");
    const finalStopRef =
      Number(bus?.travelDirection) === -1
        ? routeStops[0]
        : routeStops[routeStops.length - 1];
    const finalStopId = String(finalStopRef?._id || finalStopRef?.id || finalStopRef || "");
    const finalArrival = finalStopId ? findBusArrivalAtStop(finalStopId, bus) : null;
    const estimatedFinalEta = estimateFinalEtaFromStops(
      routeStops,
      nextStopId,
      finalStopId,
      bus?.eta
    );
    const resolvedFinalEta =
      nextStopId &&
      finalStopId &&
      nextStopId !== finalStopId &&
      Number.isFinite(estimatedFinalEta) &&
      (!Number.isFinite(Number(finalArrival?.eta)) ||
        Math.round(Number(finalArrival?.eta)) <= Math.round(Number(bus?.eta || 0)))
        ? estimatedFinalEta
        : Number.isFinite(Number(finalArrival?.eta))
          ? Math.max(0, Math.round(Number(finalArrival.eta)))
          : estimatedFinalEta;
    const finalEtaMeta = {
      finalValue: Number.isFinite(resolvedFinalEta) ? Math.max(0, Math.round(resolvedFinalEta)) : null,
      finalEtaLower: Number.isFinite(Number(finalArrival?.etaLower))
        ? Math.max(0, Math.round(Number(finalArrival.etaLower)))
        : null,
      finalEtaUpper: Number.isFinite(Number(finalArrival?.etaUpper))
        ? Math.max(0, Math.round(Number(finalArrival.etaUpper)))
        : null
    };

    const selectedStopId = selectedStop ? String(selectedStop) : "";
    const selectedBoundaryStopId = String(selectedBoundaryMeta?.stopId || "");
    const activeStopId = selectedStopId || selectedBoundaryStopId;

    if (activeStopId) {
      const arrival = findBusArrivalAtStop(activeStopId, bus);
      const stopName = stopNameMap.get(activeStopId) || nextStopName || "selected stop";
      return {
        label: `ETA to ${stopName}`,
        value: Number.isFinite(Number(arrival?.eta)) ? Math.max(0, Math.round(Number(arrival.eta))) : null,
        etaLower: Number.isFinite(Number(arrival?.etaLower)) ? Math.max(0, Math.round(Number(arrival.etaLower))) : null,
        etaUpper: Number.isFinite(Number(arrival?.etaUpper)) ? Math.max(0, Math.round(Number(arrival.etaUpper))) : null,
        ...finalEtaMeta
      };
    }

    if (String(bus?.status || "") === "STOPPED_AT_STOP") {
      return {
        label: "Departure In",
        value: Number.isFinite(Number(bus?.eta)) ? Math.max(0, Math.round(Number(bus.eta))) : 0,
        etaLower: null,
        etaUpper: null,
        ...finalEtaMeta
      };
    }

    return {
      label: "ETA",
      value: Number.isFinite(Number(bus?.eta)) ? Math.max(0, Math.round(Number(bus.eta))) : null,
      etaLower: Number.isFinite(Number(bus?.etaLower)) ? Math.max(0, Math.round(Number(bus.etaLower))) : null,
      etaUpper: Number.isFinite(Number(bus?.etaUpper)) ? Math.max(0, Math.round(Number(bus.etaUpper))) : null,
      ...finalEtaMeta
    };
  }, [
    findAnyRouteForBus,
    findBusArrivalAtStop,
    selectedBoundaryMeta,
    selectedStop,
    stopNameMap
  ]);

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

  const passengerHasRouteFocus = useMemo(
    () => passengerMode && (passengerFocusedRouteIds.length > 0 || !!selectedPassengerRoute),
    [passengerFocusedRouteIds.length, passengerMode, selectedPassengerRoute]
  );

  const visibleStops = useMemo(() => {
    if (!passengerMode) return stops;
    if (!passengerHasRouteFocus) return [];
    if (!passengerVisibleStopIdSet.size) return [];
    return stops.filter(stop => passengerVisibleStopIdSet.has(String(stop.id || stop._id || "")));
  }, [passengerHasRouteFocus, passengerMode, passengerVisibleStopIdSet, stops]);

  const visibleBuses = useMemo(() => {
    const withLocation = buses.filter(bus => bus.locationArr);
    if (!passengerMode) return withLocation;
    if (!passengerHasRouteFocus) return [];
    return withLocation.filter(bus => passengerFocusedRouteIdSet.has(String(bus.routeId || "")));
  }, [buses, passengerFocusedRouteIdSet, passengerHasRouteFocus, passengerMode]);

  const trafficZones = useMemo(() => {
    return visibleBuses
      .map(bus => {
        if (!Array.isArray(bus.locationArr) || bus.locationArr.length < 2) return null;
        const lat = Number(bus.locationArr[0]);
        const lng = Number(bus.locationArr[1]);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

        const trafficFactor = Number(bus.trafficFactor || 1);
        const predictedDelay = Number(bus.predictedDelayMinutes || 0);
        const incidentsNearby = Number(bus.incidentsNearby || 0);
        const trafficJamNearby = Number(bus.trafficJamNearby || 0);
        const mappedLabel = String(bus.mappedLabel || "").toLowerCase();

        let level = "normal";
        if (
          incidentsNearby > 0 ||
          trafficJamNearby > 0 ||
          trafficFactor >= 1.25 ||
          predictedDelay >= 10
        ) {
          level = "high";
        } else if (
          mappedLabel === "peak" ||
          trafficFactor >= 1.1 ||
          predictedDelay >= 4
        ) {
          level = "moderate";
        }

        const stylesByLevel = {
          normal: {
            radius: 130,
            color: "#22c55e",
            fillColor: "#22c55e",
            fillOpacity: 0.11,
            opacity: 0.48
          },
          moderate: {
            radius: 165,
            color: "#f59e0b",
            fillColor: "#fbbf24",
            fillOpacity: 0.16,
            opacity: 0.66
          },
          high: {
            radius: 200,
            color: "#ef4444",
            fillColor: "#fb7185",
            fillOpacity: 0.21,
            opacity: 0.8
          }
        };

        return {
          id: `traffic-zone-${bus.id}`,
          center: [lat, lng],
          style: stylesByLevel[level]
        };
      })
      .filter(Boolean);
  }, [visibleBuses]);

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

  const refreshMlStatus = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/passenger/ml/status`);
      const data = await response.json();
      setMlStatus(prev => ({
        ...DEFAULT_ML_STATUS,
        ...prev,
        ...data,
        externalWeather: data?.externalWeather ?? prev?.externalWeather ?? null,
        trainingData: {
          ...(prev?.trainingData || {}),
          ...(data?.trainingData || {})
        }
      }));
    } catch {
      setMlStatus(prev => prev || DEFAULT_ML_STATUS);
    }
  }, []);

  useEffect(() => {
    fetch(`${API_BASE_URL}/stops`).then(r => r.json()).then(setStops).catch(() => setStops([]));
    fetch(`${API_BASE_URL}/incidents`).then(r => r.json()).then(setIncidents).catch(() => setIncidents([]));
    fetch(`${API_BASE_URL}/buses`)
      .then(r => r.json())
      .then(data => setBuses(data.map(normalizeBus)))
      .catch(() => setBuses([]));
  }, []);

  useEffect(() => {
    refreshMlStatus();
    const intervalId = setInterval(refreshMlStatus, 15000);
    return () => clearInterval(intervalId);
  }, [refreshMlStatus]);

  useEffect(() => {
    fetch(`${API_BASE_URL}/api/passenger/routes`)
      .then(r => r.json())
      .then(data => setPassengerRoutesCatalog(Array.isArray(data) ? data : []))
      .catch(() => setPassengerRoutesCatalog([]));
  }, []);

  const handleAdminAuthFailure = useCallback(
    (message = "Admin session expired. Please log in again.") => {
      setToken("");
      localStorage.removeItem("token");
      setPassengerMode(true);
      setShowLogin(true);
      setConfirm({
        title: "Admin Session Expired",
        message,
        onConfirm: null
      });
    },
    []
  );

  const fetchAdminRoutes = useCallback(async authToken => {
    if (!authToken) {
      setAdminRoutes([]);
      return [];
    }
    const response = await fetch(`${API_BASE_URL}/api/admin/routes`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    if (!response.ok) {
      if (response.status === 401) {
        handleAdminAuthFailure();
      }
      return [];
    }
    const data = await response.json();
    const routes = Array.isArray(data) ? data : [];
    setAdminRoutes(routes);
    return routes;
  }, [handleAdminAuthFailure]);

  const fetchRouteRevisions = useCallback(async (routeNumber, authToken) => {
    if (!authToken || !routeNumber) {
      setRouteRevisions([]);
      return;
    }
    const response = await fetch(
      `${API_BASE_URL}/api/admin/routes/${encodeURIComponent(routeNumber)}/revisions`,
      { headers: { Authorization: `Bearer ${authToken}` } }
    );
    if (!response.ok) {
      if (response.status === 401) {
        handleAdminAuthFailure();
      }
      return;
    }
    const data = await response.json();
    setRouteRevisions(Array.isArray(data) ? data : []);
  }, [handleAdminAuthFailure]);

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
    const busIds = buses.map(b => String(b.id));
    if (!busIds.length) {
      if (selectedBus) setSelectedBus("");
      if (routeBusCandidate) setRouteBusCandidate("");
      setRouteBuilder(prev =>
        prev.assignedBuses.length ? { ...prev, assignedBuses: [] } : prev
      );
      return;
    }

    if (!selectedBus) {
      setSelectedBus(busIds[0]);
    } else if (!busIds.includes(String(selectedBus))) {
      setSelectedBus("");
    }

    if (!routeBusCandidate) {
      setRouteBusCandidate(busIds[0]);
    } else if (!busIds.includes(String(routeBusCandidate))) {
      setRouteBusCandidate("");
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
  }, [passengerSearchSelectionNonce, selectedStop, stopPopupArrivalById, stops]);

  useEffect(() => {
    if (!selectedBoundaryMeta) return;
    const marker = boundaryMarkerRefs.current.get(selectedBoundaryMeta.key);
    if (marker?.openPopup) marker.openPopup();
  }, [selectedBoundaryMeta, stopPopupArrivalById]);

  useEffect(() => {
    setSelectedBoundaryPoint(null);
    setSelectedBoundaryRouteId("");
  }, [selectedAdminRouteNumber, passengerMode]);

  useEffect(() => {
    if (passengerMode) setRoutePopup(null);
  }, [passengerMode]);

  const loginAdmin = async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/auth/login`, {
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
    await fetch(`${API_BASE_URL}/addBus`, {
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
    await fetch(`${API_BASE_URL}/incident`, {
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

    const response = await fetch(`${API_BASE_URL}/stops`, {
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
    await fetch(`${API_BASE_URL}/bus/${selectedBus}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` }
    });
  };

  const removeIncident = async incidentId => {
    await fetch(`${API_BASE_URL}/incident/${incidentId}`, { method: "DELETE" });
    setIncidentPromptQueue(prev =>
      prev.filter(prompt => String(prompt.incidentId) !== String(incidentId))
    );
  };

  const removeExistingStop = async stopId => {
    if (!token) return;
    const targetStopId = String(stopId || "");
    if (!targetStopId) return;

    const response = await fetch(`${API_BASE_URL}/stops/${encodeURIComponent(targetStopId)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) {
        handleAdminAuthFailure(data.error || "Admin session expired. Please log in again.");
        return;
      }
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
    if (String(selectedBoundaryMeta?.stopId || "") === targetStopId) {
      setSelectedBoundaryPoint(null);
      setSelectedBoundaryRouteId("");
    }

    await fetchAdminRoutes(token).catch(() => undefined);
    if (selectedAdminRouteNumber) {
      await fetchRouteRevisions(selectedAdminRouteNumber, token).catch(() => undefined);
    }
  };

  const resetRouteBuilder = useCallback(() => {
    setSelectedAdminRouteNumber("");
    setRouteBuilder(createEmptyRouteBuilder());
    setRouteDrawMode(false);
    setRouteRevisions([]);
    setRoutePopup(null);
    setRoutes([]);
    setSelectedRouteIndex(0);
    setActiveRouteIndex(0);
    setStartQuery("");
    setEndQuery("");
    setStartPlace(null);
    setEndPlace(null);
    setActiveSearch(null);
    setAddingStop(false);
    setPendingExistingStop(null);
    setPendingStopPoint(null);
    setPendingStopName("");
    setExistingStopCandidate("");
    setRouteBusCandidate("");
    setDragStopIndex(null);
    setDragOverStopIndex(null);
  }, []);

  const buildRouteBuilderFromRoute = useCallback(route => ({
    routeNumber: route?.routeNumber || "",
    routeName: route?.routeName || "",
    startPointName: route?.startPointName || "",
    endPointName: route?.endPointName || "",
    stops: (route?.stops || []).map(s => String(s?._id || s?.id || s)),
    polyline: (route?.polyline || []).map(p => ({ lat: Number(p?.lat), lng: Number(p?.lng) })),
    assignedBuses: (route?.assignedBuses || []).map(String)
  }), []);

  const loadRouteForEdit = useCallback(route => {
    if (!route) return;
    setSelectedAdminRouteNumber(route.routeNumber);
    setRouteBuilder(buildRouteBuilderFromRoute(route));
    setRouteBusCandidate("");
    setRouteDrawMode(false);
    setPendingExistingStop(null);
    setPendingStopPoint(null);
    setPendingStopName("");
    setExistingStopCandidate("");
    setDragStopIndex(null);
    setDragOverStopIndex(null);
    fetchRouteRevisions(route.routeNumber, token).catch(() => undefined);
  }, [buildRouteBuilderFromRoute, fetchRouteRevisions, token]);

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
    const busId = String(routeBusCandidate || selectedBus || "").trim();
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
    resetRouteBuilder();
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
    const cleanStartPointName = routeBuilder.startPointName.trim();
    const cleanEndPointName = routeBuilder.endPointName.trim();
    if (!cleanRouteNumber) {
      setConfirm({ title: "Route Number Required", message: "Please enter a route number.", onConfirm: null });
      return;
    }
    if (!cleanStartPointName) {
      setConfirm({ title: "Start Point Required", message: "Please enter a start point name.", onConfirm: null });
      return;
    }
    if (!cleanEndPointName) {
      setConfirm({ title: "End Point Required", message: "Please enter an end point name.", onConfirm: null });
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
    if (!selectedRouteNumber && sameNumberRoute) {
      setConfirm({
        title: "Duplicate Route Number",
        message: `Route ${cleanRouteNumber} already exists. Select it from the route list to update it.`,
        onConfirm: null
      });
      return;
    }
    if (
      selectedRouteNumber &&
      sameNumberRoute &&
      String(sameNumberRoute?.routeNumber || "").trim() !== selectedRouteNumber
    ) {
      setConfirm({
        title: "Duplicate Route Number",
        message: `Route ${cleanRouteNumber} already exists. Choose a different route number.`,
        onConfirm: null
      });
      return;
    }

    const isUpdate = !!selectedRouteNumber;
    const targetRouteNumber = selectedRouteNumber;

    const payload = isUpdate
      ? {
          ...(cleanRouteNumber !== targetRouteNumber
            ? { newRouteNumber: cleanRouteNumber }
            : {}),
          routeName: routeBuilder.routeName.trim() || null,
          startPointName: cleanStartPointName,
          endPointName: cleanEndPointName,
          stops: routeBuilder.stops,
          polyline: routeBuilder.polyline,
          assignedBuses
        }
      : {
          routeNumber: cleanRouteNumber,
          routeName: routeBuilder.routeName.trim() || null,
          startPointName: cleanStartPointName,
          endPointName: cleanEndPointName,
          stops: routeBuilder.stops,
          polyline: routeBuilder.polyline,
          assignedBuses
        };
    const response = await fetch(
      isUpdate
        ? `${API_BASE_URL}/api/admin/routes/${encodeURIComponent(targetRouteNumber)}`
        : `${API_BASE_URL}/api/admin/routes`,
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
    resetRouteBuilder();
  };

  const deleteAdminRoute = async routeNumberOverride => {
    const targetRouteNumber = String(routeNumberOverride || selectedAdminRouteNumber || "").trim();
    if (!token || !targetRouteNumber) return;
    const response = await fetch(
      `${API_BASE_URL}/api/admin/routes/${encodeURIComponent(targetRouteNumber)}`,
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
      `${API_BASE_URL}/api/admin/routes/${encodeURIComponent(selectedAdminRouteNumber)}/rollback/${encodeURIComponent(revisionId)}`,
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
    const response = await fetch(`${API_BASE_URL}/api/admin/ml/train-eta`, {
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
        useExternalCalendar: true,
        holidayCountry: "IN",
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
    const trainedSamples = Number(
      data?.model?.samples ?? data?.metrics?.eta?.samples ?? data?.metrics?.samples ?? 0
    );
    setMlStatus(prev => ({
      ...prev,
      enabled: true,
      trainedAt: data.model?.trainedAt || null,
      samples: Number.isFinite(trainedSamples) ? trainedSamples : 0
    }));
    await refreshMlStatus();
    const etaMetrics = data?.metrics?.eta || data?.metrics || {};
    const rmseValue = Number(etaMetrics?.rmse);
    const delayRmse = Number(data?.metrics?.delay?.rmse);
    const peakSamples = Number(data?.metrics?.peak?.samples || 0);
    setConfirm({
      title: "ML Model Trained",
      message: [
        `Samples: ${data.model?.samples || 0}`,
        `RMSE: ${(Number.isFinite(rmseValue) ? rmseValue : 0).toFixed(2)}`,
        Number.isFinite(delayRmse) ? `Delay RMSE: ${delayRmse.toFixed(2)}` : null,
        peakSamples ? `Peak samples: ${peakSamples}` : null,
        Array.isArray(data?.model?.outputNames) ? `Outputs: ${data.model.outputNames.join(", ")}` : null
      ]
        .filter(Boolean)
        .join(" | "),
      onConfirm: null
    });
  };

  const refreshExternalWeather = async () => {
    if (!token) return;
    const response = await fetch(`${API_BASE_URL}/api/admin/ml/weather/refresh`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await response.json();
    if (response.ok) {
      setMlStatus(prev => ({ ...prev, externalWeather: data.weather || prev.externalWeather }));
      await refreshMlStatus();
    }
  };

  return (
    <div className={`${darkMode ? "dark-mode" : "light-mode"} app-shell`}>
      <AdminPanel
        passengerMode={passengerMode}
        token={token}
        darkMode={darkMode}
        togglePassengerAdminMode={togglePassengerAdminMode}
        toggleThemeMode={toggleThemeMode}
        logoutAdmin={logoutAdmin}
        dashboardStats={dashboardStats}
        buses={buses}
        selectedBus={selectedBus}
        setSelectedBus={setSelectedBus}
        newBusId={newBusId}
        setNewBusId={setNewBusId}
        addBusNow={addBusNow}
        removeBus={removeBus}
        mlStatus={mlStatus}
        refreshExternalWeather={refreshExternalWeather}
        trainMlEtaModel={trainMlEtaModel}
        selectedAdminRouteNumber={selectedAdminRouteNumber}
        setSelectedAdminRouteNumber={setSelectedAdminRouteNumber}
        adminRoutes={adminRoutes}
        loadRouteForEdit={loadRouteForEdit}
        selectedAdminRoute={selectedAdminRoute}
        selectedAdminRouteStopRows={selectedAdminRouteStopRows}
        routeBuilder={routeBuilder}
        setRouteBuilder={setRouteBuilder}
        addingStop={addingStop}
        setAddingStop={setAddingStop}
        setRouteDrawMode={setRouteDrawMode}
        setAddingIncident={setAddingIncident}
        cancelPinnedStop={cancelPinnedStop}
        existingStopsForBuilder={existingStopsForBuilder}
        existingStopCandidate={existingStopCandidate}
        setExistingStopCandidate={setExistingStopCandidate}
        addExistingStopToBuilder={addExistingStopToBuilder}
        dragStopIndex={dragStopIndex}
        dragOverStopIndex={dragOverStopIndex}
        onBuilderStopDragStart={onBuilderStopDragStart}
        onBuilderStopDragOver={onBuilderStopDragOver}
        onBuilderStopDrop={onBuilderStopDrop}
        onBuilderStopDragEnd={onBuilderStopDragEnd}
        stopNameMap={stopNameMap}
        moveBuilderStop={moveBuilderStop}
        removeStopFromBuilder={removeStopFromBuilder}
        routeBusCandidate={routeBusCandidate}
        setRouteBusCandidate={setRouteBusCandidate}
        addBusToBuilder={addBusToBuilder}
        removeBusFromBuilder={removeBusFromBuilder}
        routeDrawMode={routeDrawMode}
        useDraftPolyline={useDraftPolyline}
        clearRoutePolyline={clearRoutePolyline}
        createAdminRoute={createAdminRoute}
        isEditingAdminRoute={isEditingAdminRoute}
        resetRouteBuilder={resetRouteBuilder}
        routeRevisions={routeRevisions}
        rollbackAdminRoute={rollbackAdminRoute}
        startQuery={startQuery}
        setStartQuery={setStartQuery}
        setStartPlace={setStartPlace}
        setRoutes={setRoutes}
        activeSearch={activeSearch}
        setActiveSearch={setActiveSearch}
        startResults={startResults}
        endQuery={endQuery}
        setEndQuery={setEndQuery}
        setEndPlace={setEndPlace}
        endResults={endResults}
        incidentType={incidentType}
        setIncidentType={setIncidentType}
      />

      <PassengerOverlay
        passengerMode={passengerMode}
        passengerOverlayOpen={passengerOverlayOpen}
        setPassengerOverlayOpen={setPassengerOverlayOpen}
        passengerLegendOpen={passengerLegendOpen}
        setPassengerLegendOpen={setPassengerLegendOpen}
        incidentType={incidentType}
        setIncidentType={setIncidentType}
        addingIncident={addingIncident}
        setAddingIncident={setAddingIncident}
        passengerSearchQuery={passengerSearchQuery}
        setPassengerSearchQuery={setPassengerSearchQuery}
        passengerSearchResults={passengerSearchResults}
        handlePassengerBusSelect={handlePassengerBusSelect}
        handlePassengerBoundarySearchSelect={handlePassengerBoundarySearchSelect}
        handlePassengerStopSelect={handlePassengerStopSelect}
        selectedPassengerRoute={selectedPassengerRoute}
        setSelectedPassengerRoute={setSelectedPassengerRoute}
        clearPassengerRouteSelection={clearPassengerRouteSelection}
        selectedRouteBuses={selectedRouteBuses}
        stopPopupArrivalById={stopPopupArrivalById}
      />

      <AppModals
        pendingExistingStop={pendingExistingStop}
        useNearbyExistingStop={useNearbyExistingStop}
        createNewStopFromNearbyChoice={createNewStopFromNearbyChoice}
        cancelPinnedStop={cancelPinnedStop}
        pendingStopPoint={pendingStopPoint}
        pendingStopName={pendingStopName}
        setPendingStopName={setPendingStopName}
        savePinnedStop={savePinnedStop}
        incidentPrompt={incidentPrompt}
        removeIncident={removeIncident}
        setIncidentPromptQueue={setIncidentPromptQueue}
        showLogin={showLogin}
        password={password}
        setPassword={setPassword}
        loginAdmin={loginAdmin}
        setShowLogin={setShowLogin}
        confirm={confirm}
        setConfirm={setConfirm}
      />

      {(!passengerMode || passengerHasRouteFocus) && (
        <FloatingHud
          stats={dashboardStats}
          isAuthenticated={!!token}
          showEtaModel={!passengerMode}
          passengerMode={passengerMode}
        />
      )}

      {(!passengerMode || passengerLegendOpen) && <MapLegend />}

      <MapContainer center={MAP_CENTER} zoom={12} zoomControl={false} preferCanvas className="map-root">
        <TileLayer
          url={
            darkMode
              ? "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
              : "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          }
        />
        <ZoomControl position="bottomleft" />
        <IncidentClicker enabled={addingIncident} onAdd={addIncident} />
        <IncidentClicker enabled={addingStop} onAdd={addStop} />
        <IncidentClicker enabled={routeDrawMode} onAdd={addRoutePoint} />
        <FollowBus buses={buses} followBus={followBus} onUserMove={() => setFollowBus(null)} />
        <PassengerSelectionFocus
          enabled={passengerMode}
          focusKey={
            selectedStop
              ? `stop-${selectedStop}`
              : selectedBus
                ? `bus-${selectedBus}`
                : selectedBoundaryPoint
                  ? `boundary-${selectedBoundaryRouteId || "route"}-${selectedBoundaryPoint}`
                  : ""
          }
          targetPosition={selectedStopPosition || selectedBusPosition || selectedBoundaryPosition}
          focusToken={passengerSearchSelectionNonce}
        />
        <FocusPolyline
          positions={focusPolylinePositions}
          disabled={
            passengerMode &&
            !!(selectedStop || selectedBus || selectedBoundaryPoint)
          }
        />
        {trafficZones.map(zone => (
          <Circle
            key={zone.id}
            center={zone.center}
            radius={zone.style.radius}
            pathOptions={{
              color: zone.style.color,
              fillColor: zone.style.fillColor,
              fillOpacity: zone.style.fillOpacity,
              opacity: zone.style.opacity,
              weight: 2
            }}
          />
        ))}

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

        {passengerMode && focusedPassengerRoutes.map(route => (
          <Polyline
            key={`passenger-focus-${route.id}`}
            positions={route.positions}
            pathOptions={{
              color:
                selectedPassengerRoute && String(selectedPassengerRoute._id || "") === String(route.id)
                  ? "#22c55e"
                  : "#10b981",
              weight:
                selectedPassengerRoute && String(selectedPassengerRoute._id || "") === String(route.id)
                  ? 7
                  : 5,
              opacity:
                selectedPassengerRoute && String(selectedPassengerRoute._id || "") === String(route.id)
                  ? 0.95
                  : 0.58
            }}
          />
        ))}
        {!passengerMode && selectedRoutePolyline.length > 0 && (
          <Polyline positions={selectedRoutePolyline} pathOptions={{ color: "#22c55e", weight: 7, opacity: 0.9 }} />
        )}
        {!passengerMode && routeBuilder.polyline.length > 1 && (
          <Polyline positions={routeBuilder.polyline.map(p => [p.lat, p.lng])} pathOptions={{ color: "#f97316", weight: 5, opacity: 0.9 }} />
        )}

        {visibleBoundaryMarkers.map(marker => {
          const isSelected =
            selectedBoundaryPoint === marker.boundaryType &&
            String(selectedBoundaryRouteId || "") === String(marker.routeId || "");
          const popupSummary = marker.stopId ? stopPopupArrivalById[marker.stopId] : null;
          const routeContext =
            passengerRoutesCatalog.find(
              route => String(route?._id || "") === String(marker.routeId || "")
            ) ||
            (selectedAdminRoute &&
            String(selectedAdminRoute?._id || selectedAdminRoute?.id || "") === String(marker.routeId || "")
              ? selectedAdminRoute
              : adminBoundaryRouteContext);

          return (
            <Marker
              key={marker.key}
              ref={ref => {
                if (ref) boundaryMarkerRefs.current.set(marker.key, ref);
                else boundaryMarkerRefs.current.delete(marker.key);
              }}
              position={marker.position}
              icon={marker.boundaryType === "start" ? startPointIcon : endPointIcon}
              eventHandlers={{
                click: () => handleBoundaryPointSelect(marker.boundaryType, routeContext, { fromSearch: false }),
                popupclose: () => {
                  if (isSelected) {
                    setSelectedBoundaryPoint(null);
                    setSelectedBoundaryRouteId("");
                  }
                }
              }}
            >
              <Popup offset={passengerMode && isSelected ? [34, 10] : [0, -16]}>
                <div className="popup-card">
                  <div className="popup-title">{marker.name}</div>
                  {passengerMode && isSelected && (
                    <>
                      {renderFastestArrival(popupSummary)}
                      <div className="popup-text">{renderDirectionalEta(popupSummary)}</div>
                    </>
                  )}
                </div>
              </Popup>
            </Marker>
          );
        })}

        {visibleStops.map(stop => {
          const stopId = String(stop.id || stop._id);
          const stopArrival = stopPopupArrivalById[stopId] || null;
          return (
            <Marker
              key={stopId}
              ref={ref => {
                if (ref) stopMarkerRefs.current.set(stopId, ref);
                else stopMarkerRefs.current.delete(stopId);
              }}
              position={[stop.location.lat, stop.location.lng]}
              icon={passengerMode && String(selectedStop || "") === stopId ? selectedStopIcon : stopIcon}
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
              <Popup offset={passengerMode && String(selectedStop || "") === stopId ? [34, 10] : [0, -16]}>
                <div className="popup-card">
                  <div className="popup-title">{sanitizeStopName(stop.name) || `Stop ${stopId.slice(-4)}`}</div>
                  {passengerMode && renderFastestArrival(stopArrival)}
                  {passengerMode && (
                    <div className="popup-text">
                      {renderDirectionalEta(stopArrival)}
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

        {visibleBuses.map(bus => (
            <BusMarker
              key={bus.id}
              bus={bus}
              nextStopName={resolveBusNextStopName(bus)}
              etaMeta={buildBusPopupEtaMeta(bus, resolveBusNextStopName(bus))}
              isSelected={passengerMode && String(selectedBus || "") === String(bus.id)}
              focusToken={passengerSearchSelectionNonce}
              onClick={() => {
                handlePassengerBusSelect(bus.id);
              }}
            />
          ))}


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

