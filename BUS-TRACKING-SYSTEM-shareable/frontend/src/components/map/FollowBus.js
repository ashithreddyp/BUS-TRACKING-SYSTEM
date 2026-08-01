import { useEffect } from "react";
import { useMapEvents } from "react-leaflet";

export default function FollowBus({ buses, followBus, onUserMove }) {
  const map = useMapEvents({
    dragstart: onUserMove,
    zoomstart: onUserMove
  });

  useEffect(() => {
    if (!followBus) return;
    const bus = buses.find(b => b.id === followBus);
    if (bus?.locationArr) {
      map.flyTo(bus.locationArr, Math.max(map.getZoom(), 14), { duration: 0.5 });
    }
  }, [buses, followBus, map]);

  return null;
}
