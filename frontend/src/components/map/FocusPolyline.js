import { useEffect } from "react";
import { useMapEvents } from "react-leaflet";

export default function FocusPolyline({ positions, disabled = false }) {
  const map = useMapEvents({});

  useEffect(() => {
    if (disabled) return;
    if (!positions?.length) return;
    map.fitBounds(positions, { padding: [40, 40] });
  }, [disabled, positions, map]);

  return null;
}
