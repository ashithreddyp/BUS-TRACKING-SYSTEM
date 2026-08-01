import { useEffect } from "react";
import { useMapEvents } from "react-leaflet";

export default function FocusPolyline({ positions }) {
  const map = useMapEvents({});

  useEffect(() => {
    if (!positions?.length) return;
    map.fitBounds(positions, { padding: [40, 40] });
  }, [positions, map]);

  return null;
}
