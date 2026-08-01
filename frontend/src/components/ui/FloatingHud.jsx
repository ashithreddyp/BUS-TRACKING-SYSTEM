export default function FloatingHud({
  stats,
  isAuthenticated,
  showEtaModel = true,
  passengerMode = false
}) {
  return (
    <div className={`floating-hud${passengerMode ? " passenger" : ""}`}>
      <div className="hud-grid">
        {passengerMode ? (
          <>
            <div className="hud-item">
              <div className="hud-label">Buses</div>
              <div className="hud-value">{stats.totalBuses}</div>
              <div className="hud-sub">{stats.running} running</div>
            </div>
            <div className="hud-item">
              <div className="hud-label">Selected Route</div>
              <div className="hud-value">{stats.routeLabel}</div>
              <div className="hud-sub">Live focus</div>
            </div>
          </>
        ) : (
          <>
            <div className="hud-item">
              <div className="hud-label">Mode</div>
              <div className="hud-value">{stats.modeLabel}</div>
              <div className="hud-sub">{isAuthenticated ? "Authenticated" : "Guest"}</div>
            </div>
            <div className="hud-item">
              <div className="hud-label">Buses</div>
              <div className="hud-value">{stats.totalBuses}</div>
              <div className="hud-sub">{stats.running} running</div>
            </div>
            <div className="hud-item">
              <div className="hud-label">Status</div>
              <div className="hud-pill-row">
                <span className="hud-pill on">{stats.onTime} on</span>
                <span className="hud-pill delay">{stats.delayed} delay</span>
                <span className="hud-pill stop">{stats.stopped} stop</span>
              </div>
            </div>
            <div className="hud-item">
              <div className="hud-label">Stops / Incidents</div>
              <div className="hud-value">
                {stats.totalStops} / {stats.totalIncidents}
              </div>
              <div className="hud-sub">Transit network health</div>
            </div>
            <div className="hud-item">
              <div className="hud-label">Selected Route</div>
              <div className="hud-value">{stats.routeLabel}</div>
              <div className="hud-sub">Live focus</div>
            </div>
            {showEtaModel && (
              <div className="hud-item">
                <div className="hud-label">Transit ML</div>
                <div className="hud-value">{stats.mlEnabled ? "Enabled" : "Disabled"}</div>
                <div className="hud-sub">
                  {stats.mlEnabled ? `${stats.mlSamples || 0} samples` : "Prediction pipeline"}
                </div>
              </div>
            )}
          </>
        )}
      </div>
      {!passengerMode && (
        <div className="hud-tools">
          {stats.activeTools.length ? (
            stats.activeTools.map(tool => (
              <span key={tool} className="hud-tool-chip">
                {tool}
              </span>
            ))
          ) : (
            <span className="hud-tool-chip muted">No active tools</span>
          )}
        </div>
      )}
    </div>
  );
}
