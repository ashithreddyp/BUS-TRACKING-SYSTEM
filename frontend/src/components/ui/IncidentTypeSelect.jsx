import { INCIDENT_TYPES } from "../../constants/appConstants";

export default function IncidentTypeSelect({ value, onChange, className = "input" }) {
  return (
    <select className={className} value={value} onChange={onChange}>
      {INCIDENT_TYPES.map(type => (
        <option key={type} value={type}>
          {type}
        </option>
      ))}
    </select>
  );
}
