import { useEffect, useRef } from "react";
import { useMap } from "react-leaflet";

export default function PassengerSelectionFocus({
  enabled,
  focusKey,
  targetPosition,
  focusToken = 0
}) {
  const map = useMap();
  const lastFocusKeyRef = useRef("");
  const focusTimerRef = useRef(null);

  useEffect(() => {
    if (!enabled) return;
    if (!focusKey || !Array.isArray(targetPosition) || targetPosition.length < 2) return;
    const effectiveKey = `${focusKey}::${Number(focusToken) || 0}`;
    if (lastFocusKeyRef.current === effectiveKey) return;
    const [lat, lng] = targetPosition;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

    const minZoom = String(focusKey).startsWith("stop-") ? 15 : 14;
    if (focusTimerRef.current) clearTimeout(focusTimerRef.current);

    // Run after route auto-fit so explicit search selection focus wins.
    focusTimerRef.current = setTimeout(() => {
      const nextZoom = Math.max(map.getZoom(), minZoom);
      const targetPoint = map.project([lat, lng], nextZoom);
      const viewport = map.getSize();

      // Keep the focused marker away from the top HUD and the right passenger rail.
      const xOffset = Math.min(210, Math.max(112, Math.round(viewport.x * 0.18)));
      const yOffset = -Math.min(220, Math.max(132, Math.round(viewport.y * 0.24)));
      const shiftedCenter = map.unproject(targetPoint.add([xOffset, yOffset]), nextZoom);

      map.flyTo(shiftedCenter, nextZoom, { duration: 0.55 });
    }, 120);
    lastFocusKeyRef.current = effectiveKey;

    return () => {
      if (focusTimerRef.current) clearTimeout(focusTimerRef.current);
    };
  }, [enabled, focusKey, focusToken, map, targetPosition]);

  return null;
}
