import { useEffect, useRef } from "react";
import { Marker, Popup } from "react-leaflet";
import { busIcon } from "./icons";

export default function BusMarker({ bus, onClick, nextStopName = null }) {
  const markerRef = useRef(null);
  const prevPos = useRef(bus.locationArr || null);
  const prevBearing = useRef(bus.bearing || 0);
  const animRef = useRef(null);

  useEffect(() => {
    if (!prevPos.current && bus.locationArr) prevPos.current = bus.locationArr;
  }, [bus.locationArr]);

  useEffect(() => {
    const marker = markerRef.current;
    if (!marker || !bus.locationArr) return;

    const from = prevPos.current || bus.locationArr;
    const to = bus.locationArr;
    const fromBearing = prevBearing.current || 0;
    const toBearing = bus.bearing || 0;
    if (from[0] === to[0] && from[1] === to[1] && fromBearing === toBearing) return;

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

      if (marker.setRotationAngle) {
        const delta = ((toBearing - fromBearing + 540) % 360) - 180;
        marker.setRotationAngle(fromBearing + delta * k);
      }

      if (t < 1) {
        animRef.current = requestAnimationFrame(step);
      } else {
        prevPos.current = to;
        prevBearing.current = toBearing;
      }
    };

    animRef.current = requestAnimationFrame(step);
    return () => animRef.current && cancelAnimationFrame(animRef.current);
  }, [bus.locationArr, bus.bearing]);

  return (
    <Marker
      ref={markerRef}
      position={prevPos.current || bus.locationArr}
      icon={busIcon}
      rotationAngle={bus.bearing || 0}
      rotationOrigin="center"
      eventHandlers={{ click: onClick }}
      zIndexOffset={500}
    >
      <Popup>
        <div className="popup-card">
          <div className="popup-title">Bus {bus.id}</div>
          <div className="popup-text">Status: {bus.status}</div>
          <div className="popup-text">ETA: {bus.eta == null ? "Stopped" : `${bus.eta} min`}</div>
          <div className="popup-text">Next Stop: {nextStopName || bus.nextStop || "-"}</div>
        </div>
      </Popup>
    </Marker>
  );
}
