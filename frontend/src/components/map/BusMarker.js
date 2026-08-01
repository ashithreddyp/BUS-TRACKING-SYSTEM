import { useEffect, useRef } from "react";
import { Marker, Popup } from "react-leaflet";
import { busIcon, selectedBusIcon } from "./icons";
import { formatStatusLabel, getStatusClassName } from "../../utils/appHelpers";

export default function BusMarker({
  bus,
  onClick,
  nextStopName = null,
  etaMeta = null,
  isSelected = false,
  focusToken = 0
}) {
  const markerRef = useRef(null);
  const prevPos = useRef(bus.locationArr || null);
  const animRef = useRef(null);
  const wasSelectedRef = useRef(false);
  const lastFocusTokenRef = useRef(Number(focusToken) || 0);

  useEffect(() => {
    if (!prevPos.current && bus.locationArr) prevPos.current = bus.locationArr;
  }, [bus.locationArr]);

  useEffect(() => {
    const marker = markerRef.current;
    if (!marker || !bus.locationArr) return;

    const from = prevPos.current || bus.locationArr;
    const to = bus.locationArr;
    if (from[0] === to[0] && from[1] === to[1]) return;

    const start = performance.now();
    const duration = 700;
    const easeInOut = t => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t);
    if (animRef.current) cancelAnimationFrame(animRef.current);

    const step = now => {
      const t = Math.min(1, (now - start) / duration);
      const k = easeInOut(t);
      const lat = from[0] + (to[0] - from[0]) * k;
      const lng = from[1] + (to[1] - from[1]) * k;
      marker.setLatLng([lat, lng]);

      if (t < 1) {
        animRef.current = requestAnimationFrame(step);
      } else {
        prevPos.current = to;
      }
    };

    animRef.current = requestAnimationFrame(step);
    return () => animRef.current && cancelAnimationFrame(animRef.current);
  }, [bus.locationArr]);

  useEffect(() => {
    const marker = markerRef.current;
    if (!marker) return;
    const token = Number(focusToken) || 0;
    const tokenChanged = token !== lastFocusTokenRef.current;
    if (isSelected && (!wasSelectedRef.current || tokenChanged)) {
      marker.openPopup();
    }
    wasSelectedRef.current = isSelected;
    lastFocusTokenRef.current = token;
  }, [focusToken, isSelected]);

  const statusLabel = formatStatusLabel(bus.status);
  const statusClass = getStatusClassName(bus.status);
  const predictedDelayMinutes = Number.isFinite(Number(bus.predictedDelayMinutes))
    ? Math.max(0, Math.round(Number(bus.predictedDelayMinutes)))
    : null;
  const trafficLabel = String(bus.mappedLabel || "").trim();
  const clusterId = Number.isFinite(Number(bus.clusterId)) ? Number(bus.clusterId) : null;
  const isStoppedAtStop = String(bus.status || "") === "STOPPED_AT_STOP";
  const baseEtaLabel = etaMeta?.label || "ETA";
  const rawEtaValue = Number.isFinite(Number(etaMeta?.value))
    ? Math.max(0, Math.round(Number(etaMeta.value)))
    : null;
  const rawEtaLower = Number.isFinite(Number(etaMeta?.etaLower))
    ? Math.max(0, Math.round(Number(etaMeta.etaLower)))
    : null;
  const rawEtaUpper = Number.isFinite(Number(etaMeta?.etaUpper))
    ? Math.max(0, Math.round(Number(etaMeta.etaUpper)))
    : null;
  const rawFinalEtaValue = Number.isFinite(Number(etaMeta?.finalValue))
    ? Math.max(0, Math.round(Number(etaMeta.finalValue)))
    : null;
  const rawFinalEtaLower = Number.isFinite(Number(etaMeta?.finalEtaLower))
    ? Math.max(0, Math.round(Number(etaMeta.finalEtaLower)))
    : null;
  const rawFinalEtaUpper = Number.isFinite(Number(etaMeta?.finalEtaUpper))
    ? Math.max(0, Math.round(Number(etaMeta.finalEtaUpper)))
    : null;
  const hasOperationalImpact =
    Number(bus?.incidentsNearby || 0) > 0 || Number(bus?.trafficFactor || 1) >= 1.2;
  const maxRangeSpread = hasOperationalImpact ? 12 : 6;
  const normalizedEtaValue = isStoppedAtStop && !String(baseEtaLabel).startsWith("ETA to")
    ? (Number.isFinite(Number(bus?.eta)) ? Math.max(0, Math.round(Number(bus.eta))) : 0)
    : rawEtaValue;
  const etaContext = isStoppedAtStop && !String(baseEtaLabel).startsWith("ETA to")
    ? "Reference: Departure from current stop"
    : baseEtaLabel === "Final ETA"
      ? "Reference: Final stop"
      : String(baseEtaLabel).startsWith("ETA to")
        ? `Reference: ${baseEtaLabel.replace(/^ETA to\s*/i, "")}`
        : null;
  let etaLower = rawEtaLower;
  let etaUpper = rawEtaUpper;
  if (normalizedEtaValue != null && etaLower != null && etaUpper != null) {
    etaLower = Math.max(0, Math.min(etaLower, normalizedEtaValue));
    etaUpper = Math.max(etaLower, etaUpper);
    if (etaUpper - etaLower > maxRangeSpread) {
      const plusMinus = Math.max(1, Math.round(maxRangeSpread / 2));
      etaLower = Math.max(0, normalizedEtaValue - plusMinus);
      etaUpper = Math.max(etaLower, normalizedEtaValue + plusMinus);
    }
  }
  if (isStoppedAtStop && !String(baseEtaLabel).startsWith("ETA to")) {
    etaLower = null;
    etaUpper = null;
  }
  let finalEtaLower = rawFinalEtaLower;
  let finalEtaUpper = rawFinalEtaUpper;
  if (rawFinalEtaValue != null && finalEtaLower != null && finalEtaUpper != null) {
    finalEtaLower = Math.max(0, Math.min(finalEtaLower, rawFinalEtaValue));
    finalEtaUpper = Math.max(finalEtaLower, finalEtaUpper);
    if (finalEtaUpper - finalEtaLower > maxRangeSpread) {
      const plusMinus = Math.max(1, Math.round(maxRangeSpread / 2));
      finalEtaLower = Math.max(0, rawFinalEtaValue - plusMinus);
      finalEtaUpper = Math.max(finalEtaLower, rawFinalEtaValue + plusMinus);
    }
  }

  return (
    <Marker
      ref={markerRef}
      position={prevPos.current || bus.locationArr}
      icon={isSelected ? selectedBusIcon : busIcon}
      eventHandlers={{ click: onClick }}
      zIndexOffset={isSelected ? 900 : 500}
    >
      <Popup offset={isSelected ? [34, 10] : [0, -16]}>
        <div className="popup-card bus-popup-card">
          <div className="popup-title">Bus {bus.id}</div>
          <div className="popup-text">
            <span className="popup-key">Status:</span>{" "}
            <span className={`status-chip ${statusClass}`}>{statusLabel}</span>
          </div>
          {etaContext && <div className="popup-subtext">{etaContext}</div>}
          <div className="popup-text"><span className="popup-key">ETA:</span> {normalizedEtaValue == null ? "Stopped" : `${normalizedEtaValue} min`}</div>
          {normalizedEtaValue != null && etaLower != null && etaUpper != null && (
            <div className="popup-text">
              <span className="popup-key">ETA Range:</span> {etaLower}-{etaUpper} min
            </div>
          )}
          {rawFinalEtaValue != null && (
            <div className="popup-text">
              <span className="popup-key">Final ETA:</span> {rawFinalEtaValue} min
            </div>
          )}
          {rawFinalEtaValue != null && finalEtaLower != null && finalEtaUpper != null && (
            <div className="popup-text">
              <span className="popup-key">Final ETA Range:</span> {finalEtaLower}-{finalEtaUpper} min
            </div>
          )}
          {predictedDelayMinutes != null && (
            <div className="popup-text">
              <span className="popup-key">Predicted Delay:</span> {predictedDelayMinutes} min
            </div>
          )}
          {(trafficLabel || clusterId != null) && (
            <div className="popup-text">
              <span className="popup-key">Traffic Pattern:</span>{" "}
              {[trafficLabel || null, clusterId != null ? `Cluster ${clusterId}` : null]
                .filter(Boolean)
                .join(" | ")}
            </div>
          )}
          <div className="popup-text"><span className="popup-key">Next Stop:</span> {nextStopName || bus.nextStop || "-"}</div>
        </div>
      </Popup>
    </Marker>
  );
}
