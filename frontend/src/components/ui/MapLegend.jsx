export default function MapLegend() {
  return (
    <div className="map-legend">
      <div className="legend-title">Map Legend</div>
      <div className="legend-section-title">Markers</div>
      <div className="legend-row">
        <span className="legend-badge badge-bus" aria-hidden="true">
          {"\u{1F68C}"}
        </span>
        <span>Bus</span>
      </div>
      <div className="legend-row">
        <span className="legend-badge badge-stop" aria-hidden="true">
          {"\u{1F68F}"}
        </span>
        <span>Stop</span>
      </div>
      <div className="legend-row">
        <span className="legend-badge badge-start-point" aria-hidden="true">
          {"\u{1F6A9}"}
        </span>
        <span>Start Point</span>
      </div>
      <div className="legend-row">
        <span className="legend-badge badge-end-point" aria-hidden="true">
          {"\u{1F3C1}"}
        </span>
        <span>End Point</span>
      </div>
      <div className="legend-row">
        <span className="legend-badge badge-incident-accident" aria-hidden="true">
          {"\u{1F4A5}"}
        </span>
        <span>Accident</span>
      </div>
      <div className="legend-row">
        <span className="legend-badge badge-incident-roadwork" aria-hidden="true">
          {"\u{1F6A7}"}
        </span>
        <span>Road Work</span>
      </div>
      <div className="legend-row">
        <span className="legend-badge badge-incident-traffic" aria-hidden="true">
          {"\u{1F6A6}"}
        </span>
        <span>Traffic Jam</span>
      </div>
      <div className="legend-row">
        <span className="legend-badge badge-incident-flood" aria-hidden="true">
          {"\u{1F30A}"}
        </span>
        <span>Flood</span>
      </div>
      <div className="legend-divider" />
      <div className="legend-section-title">Routes</div>
      <div className="legend-row">
        <span className="legend-line selected" />
        <span>Selected Route</span>
      </div>
      <div className="legend-row">
        <span className="legend-line draft" />
        <span>Draft Route</span>
      </div>
      <div className="legend-divider" />
      <div className="legend-section-title">Traffic Zones</div>
      <div className="legend-row">
        <span className="legend-zone zone-normal" aria-hidden="true" />
        <span>Normal Flow</span>
      </div>
      <div className="legend-row">
        <span className="legend-zone zone-moderate" aria-hidden="true" />
        <span>Moderate Traffic</span>
      </div>
      <div className="legend-row">
        <span className="legend-zone zone-high" aria-hidden="true" />
        <span>High Traffic</span>
      </div>
      <div className="legend-divider" />
      <div className="legend-section-title">Bus Status</div>
      <div className="legend-statuses">
        <span className="status-chip on">On Time</span>
        <span className="status-chip delay">Delayed</span>
        <span className="status-chip stop">Stopped</span>
      </div>
    </div>
  );
}
