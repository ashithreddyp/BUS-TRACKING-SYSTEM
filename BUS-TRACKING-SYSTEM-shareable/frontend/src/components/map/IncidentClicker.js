import { useMapEvents } from "react-leaflet";

export default function IncidentClicker({ enabled, onAdd }) {
  useMapEvents({
    click(e) {
      if (enabled) onAdd(e.latlng);
    }
  });
  return null;
}
