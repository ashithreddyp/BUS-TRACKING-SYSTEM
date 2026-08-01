import IncidentTypeSelect from "./IncidentTypeSelect";

export default function AdminPanel({
  passengerMode,
  token,
  darkMode,
  togglePassengerAdminMode,
  toggleThemeMode,
  logoutAdmin,
  dashboardStats,
  buses,
  selectedBus,
  setSelectedBus,
  newBusId,
  setNewBusId,
  addBusNow,
  removeBus,
  mlStatus,
  refreshExternalWeather,
  trainMlEtaModel,
  selectedAdminRouteNumber,
  setSelectedAdminRouteNumber,
  adminRoutes,
  loadRouteForEdit,
  selectedAdminRoute,
  selectedAdminRouteStopRows,
  routeBuilder,
  setRouteBuilder,
  addingStop,
  setAddingStop,
  setRouteDrawMode,
  setAddingIncident,
  cancelPinnedStop,
  existingStopsForBuilder,
  existingStopCandidate,
  setExistingStopCandidate,
  addExistingStopToBuilder,
  dragStopIndex,
  dragOverStopIndex,
  onBuilderStopDragStart,
  onBuilderStopDragOver,
  onBuilderStopDrop,
  onBuilderStopDragEnd,
  stopNameMap,
  moveBuilderStop,
  removeStopFromBuilder,
  routeBusCandidate,
  setRouteBusCandidate,
  addBusToBuilder,
  removeBusFromBuilder,
  routeDrawMode,
  useDraftPolyline,
  clearRoutePolyline,
  createAdminRoute,
  isEditingAdminRoute,
  resetRouteBuilder,
  routeRevisions,
  rollbackAdminRoute,
  startQuery,
  setStartQuery,
  setStartPlace,
  setRoutes,
  activeSearch,
  setActiveSearch,
  startResults,
  endQuery,
  setEndQuery,
  setEndPlace,
  endResults,
  incidentType,
  setIncidentType
}) {
  const trainedSamples = Number(mlStatus?.samples || 0);
  const logs30d = Number(mlStatus?.trainingData?.logs30d || 0);
  const totalLogs = Number(mlStatus?.trainingData?.totalLogs || 0);
  const sampleUsagePct = logs30d > 0 ? ((trainedSamples / logs30d) * 100).toFixed(1) : null;
  const trainedAtLabel = mlStatus?.trainedAt
    ? new Date(mlStatus.trainedAt).toLocaleString()
    : "N/A";
  const lastLogAtLabel = mlStatus?.trainingData?.lastLogAt
    ? new Date(mlStatus.trainingData.lastLogAt).toLocaleString()
    : "N/A";
  const assignedBusSet = new Set(routeBuilder.assignedBuses.map(String));
  const routeBusOptions = [...buses].sort((a, b) => {
    const aAssigned = assignedBusSet.has(String(a.id)) ? 1 : 0;
    const bAssigned = assignedBusSet.has(String(b.id)) ? 1 : 0;
    if (aAssigned !== bAssigned) return aAssigned - bAssigned;
    return String(a.id).localeCompare(String(b.id));
  });
  const availableBusCount = buses.filter(bus => !assignedBusSet.has(String(bus.id))).length;

  return (
    <div className="panel">
      <button className="btn btn-primary" onClick={togglePassengerAdminMode}>
        {passengerMode ? "Admin Mode" : "Passenger Mode"}
      </button>

      <button className="btn btn-secondary" onClick={toggleThemeMode}>
        {darkMode ? "Light" : "Dark"}
      </button>

      {token && <button className="btn btn-danger" onClick={logoutAdmin}>Logout</button>}

      {!passengerMode && (
        <div className="admin-layout">
          <div className="admin-head-card">
            <div className="admin-head-title">Admin Console</div>
            <div className="admin-head-sub">
              Fleet {dashboardStats.totalBuses} | Stops {dashboardStats.totalStops} | Incidents {dashboardStats.totalIncidents}
            </div>
          </div>

          <details className="admin-section admin-section-fleet" open>
            <summary>Fleet Control</summary>
            <div className="admin-section-body">
              <div className="list-box">
                <label className="field-label">Select Bus</label>
                <select className="input themed-select" value={selectedBus} onChange={e => setSelectedBus(e.target.value)}>
                  {buses.map(b => (
                    <option key={b.id} value={b.id}>
                      {b.id}
                    </option>
                  ))}
                </select>
              </div>

              {token && (
                <div className="admin-inline-row">
                  <input
                    className="input mb-none"
                    placeholder="New bus ID"
                    value={newBusId}
                    onChange={e => setNewBusId(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addBusNow();
                      }
                    }}
                  />
                  <button className="btn btn-secondary" onClick={addBusNow}>Add Bus</button>
                  <button className="btn btn-danger" onClick={removeBus}>Remove Bus</button>
                </div>
              )}
            </div>
          </details>

          <details className="admin-section admin-section-eta" open>
            <summary>Transit ML Model</summary>
            <div className="admin-section-body">
              <div className="list-box">
                <div className="meta-title">Separate Transit ML Pipeline</div>
                <div className="meta-text">
                  {mlStatus.enabled
                    ? `Last training samples used: ${trainedSamples}`
                    : "Model status: Not trained yet"}
                </div>
                <div className="meta-text">
                  Raw simulation logs (30d): {logs30d}
                </div>
                <div className="meta-text">Raw simulation logs (all time): {totalLogs}</div>
                <div className="meta-text">Last trained at: {trainedAtLabel}</div>
                <div className="meta-text">Latest log at: {lastLogAtLabel}</div>
                {sampleUsagePct != null && (
                  <div className="meta-text">Sample usage ratio (30d): {sampleUsagePct}%</div>
                )}
                <div className="meta-text">
                  ETA model inputs: {Number(mlStatus?.etaModel?.featureNames?.length || 0)}
                </div>
                <div className="meta-text">
                  Delay model inputs: {Number(mlStatus?.delayModel?.featureNames?.length || 0)}
                </div>
                <div className="meta-text">
                  Peak model inputs: {Number(mlStatus?.peakModel?.featureNames?.length || 0)}
                </div>
                <div className="meta-text">
                  Outputs: {(Array.isArray(mlStatus?.outputNames) ? mlStatus.outputNames : []).join(", ") || "N/A"}
                </div>
                <div className="meta-text">
                  Peak labels: {Object.values(mlStatus?.peakModel?.labels || {}).join(", ") || "N/A"}
                </div>
                {mlStatus.externalWeather && (
                  <div className="meta-text">
                    Weather: {Math.round(mlStatus.externalWeather.temperatureC || 0)} C, rain {mlStatus.externalWeather.precipitationMm || 0} mm
                  </div>
                )}
                {token && (
                  <>
                    <button className="btn btn-secondary" onClick={refreshExternalWeather}>
                      Refresh Weather
                    </button>
                    <button className="btn btn-secondary" onClick={trainMlEtaModel}>
                      Train ETA Model
                    </button>
                  </>
                )}
              </div>
            </div>
          </details>

          <details className="admin-section admin-section-route" open>
            <summary>Route Builder</summary>
            <div className="admin-section-body">
              {token ? (
                <div className="list-box">
                  <select
                    className="input themed-select"
                    value={selectedAdminRouteNumber}
                    onChange={e => {
                      const number = e.target.value;
                      setSelectedAdminRouteNumber(number);
                      const selected = adminRoutes.find(r => r.routeNumber === number);
                      if (selected) loadRouteForEdit(selected);
                      else resetRouteBuilder();
                    }}
                  >
                    <option value="">Select existing route (optional)</option>
                    {adminRoutes.map(r => (
                      <option key={String(r._id || r.id || r.routeNumber)} value={r.routeNumber}>
                        {r.routeNumber} {r.routeName ? `- ${r.routeName}` : ""}
                      </option>
                    ))}
                  </select>

                  <div className="list-box admin-route-edit-card">
                    <div className="meta-title">
                      {selectedAdminRoute
                        ? `Editing Route ${selectedAdminRoute.routeNumber}`
                        : "New Route Draft"}
                    </div>
                    <div className="meta-text">
                      {selectedAdminRoute
                        ? `Update this route, then publish. Use "Start New Route" to leave edit mode.`
                        : `Set route details, add stops, assign buses, and publish. The panel resets after publish.`}
                    </div>
                    <div className="admin-route-edit-stats">
                      <span className="admin-mini-chip">
                        Stops {routeBuilder.stops.length}
                      </span>
                      <span className="admin-mini-chip">
                        Buses {routeBuilder.assignedBuses.length}
                      </span>
                      <span className="admin-mini-chip">
                        Line {routeBuilder.polyline.length} pts
                      </span>
                    </div>
                    <div className="admin-edit-actions">
                      {selectedAdminRoute && (
                        <button
                          className="btn btn-secondary btn-inline"
                          onClick={() => loadRouteForEdit(selectedAdminRoute)}
                        >
                          Reload Saved Route
                        </button>
                      )}
                      <button
                        className="btn btn-secondary btn-inline"
                        onClick={() =>
                          setRouteBuilder(prev => ({
                            ...prev,
                            assignedBuses: []
                          }))
                        }
                      >
                        Clear Buses
                      </button>
                      <button
                        className="btn btn-secondary btn-inline"
                        onClick={() =>
                          setRouteBuilder(prev => ({
                            ...prev,
                            stops: []
                          }))
                        }
                      >
                        Clear Stops
                      </button>
                      <button className="btn btn-secondary btn-inline" onClick={resetRouteBuilder}>
                        Start New Route
                      </button>
                    </div>
                  </div>

                  <div className="admin-workflow-steps">
                    <div className="admin-workflow-step">
                      <span className="admin-workflow-index">1</span>
                      <div>
                        <div className="admin-workflow-title">Select or Start Route</div>
                        <div className="admin-workflow-text">Choose an existing route to edit, or start a new route draft.</div>
                      </div>
                    </div>
                    <div className="admin-workflow-step">
                      <span className="admin-workflow-index">2</span>
                      <div>
                        <div className="admin-workflow-title">Set Route Identity and Endpoints</div>
                        <div className="admin-workflow-text">Enter route number, route name, and required start/end point names.</div>
                      </div>
                    </div>
                    <div className="admin-workflow-step">
                      <span className="admin-workflow-index">3</span>
                      <div>
                        <div className="admin-workflow-title">Set Route Line</div>
                        <div className="admin-workflow-text">Pick start/end locations and use the map route or draw one manually.</div>
                      </div>
                    </div>
                    <div className="admin-workflow-step">
                      <span className="admin-workflow-index">4</span>
                      <div>
                        <div className="admin-workflow-title">Add Stops</div>
                        <div className="admin-workflow-text">Add new or existing stops, then order them correctly.</div>
                      </div>
                    </div>
                    <div className="admin-workflow-step">
                      <span className="admin-workflow-index">5</span>
                      <div>
                        <div className="admin-workflow-title">Assign Buses</div>
                        <div className="admin-workflow-text">Assign one or more buses before publishing the route.</div>
                      </div>
                    </div>
                    <div className="admin-workflow-step">
                      <span className="admin-workflow-index">6</span>
                      <div>
                        <div className="admin-workflow-title">Publish</div>
                        <div className="admin-workflow-text">Save and publish only after line, stops, and buses are ready.</div>
                      </div>
                    </div>
                  </div>

                  {selectedAdminRoute && (
                    <div className="list-box selected-route-stops-panel">
                      <div className="meta-title">
                        Selected Route Stops ({selectedAdminRouteStopRows.length})
                      </div>
                      <div className="scroll-box selected-route-stops-scroll">
                        {selectedAdminRouteStopRows.length === 0 && (
                          <div className="meta-muted">No stops configured in this route yet.</div>
                        )}
                        {selectedAdminRouteStopRows.map(row => (
                          <div key={row.key} className="selected-route-stop-row">
                            <span className="selected-route-stop-index">{row.sequence}.</span>
                            <span className="selected-route-stop-name">{row.name}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <input
                    className="input"
                    placeholder="Route Number"
                    value={routeBuilder.routeNumber}
                    onChange={e => setRouteBuilder(prev => ({ ...prev, routeNumber: e.target.value }))}
                  />
                  <input
                    className="input"
                    placeholder="Route Name"
                    value={routeBuilder.routeName}
                    onChange={e => setRouteBuilder(prev => ({ ...prev, routeName: e.target.value }))}
                  />
                  <input
                    className="input"
                    placeholder="Start Point Name"
                    value={routeBuilder.startPointName}
                    onChange={e => setRouteBuilder(prev => ({ ...prev, startPointName: e.target.value }))}
                  />
                  <input
                    className="input"
                    placeholder="End Point Name"
                    value={routeBuilder.endPointName}
                    onChange={e => setRouteBuilder(prev => ({ ...prev, endPointName: e.target.value }))}
                  />

                  <div className="list-box admin-route-line-panel">
                    <div className="meta-title">Step 3: Route Line</div>
                    <div className="meta-text">
                      Build the route line before adding stops and buses.
                    </div>
                    <div className="meta-text">
                      Polyline points: {routeBuilder.polyline.length}
                    </div>
                    <div className="admin-inline-row">
                      <button
                        className="btn btn-secondary"
                        onClick={() => {
                          setRouteDrawMode(v => {
                            const next = !v;
                            if (next) {
                              setAddingIncident(false);
                              setAddingStop(false);
                            }
                            return next;
                          });
                        }}
                      >
                        {routeDrawMode ? "Stop Draw" : "Draw On Map"}
                      </button>
                      <button className="btn btn-secondary" onClick={useDraftPolyline}>Use Draft Route</button>
                      <button className="btn btn-danger" onClick={clearRoutePolyline}>Clear Draft</button>
                    </div>
                  </div>

                  <div className="list-box admin-route-stops-panel">
                    <div className="meta-title">Step 4: Stops</div>
                    <div className="meta-text">
                      Add at least 2 stops and arrange them in route order.
                    </div>
                  <div className="admin-inline-row">
                    <button
                      className={addingStop ? "btn btn-primary" : "btn btn-secondary"}
                      onClick={() => {
                        setAddingStop(v => {
                          const next = !v;
                          if (next) {
                            setRouteDrawMode(false);
                            setAddingIncident(false);
                          } else {
                            cancelPinnedStop();
                          }
                          return next;
                        });
                      }}
                    >
                      {addingStop ? "Stop Pinning: ON" : "Pin Stop On Map"}
                    </button>
                  </div>
                  {existingStopsForBuilder.length > 0 && (
                    <div className="admin-inline-row">
                      <select
                        className="input themed-select mb-none"
                        value={existingStopCandidate}
                        onChange={e => setExistingStopCandidate(e.target.value)}
                      >
                        {existingStopsForBuilder.map(stop => (
                          <option key={stop.id} value={stop.id}>
                            {stop.label}
                          </option>
                        ))}
                      </select>
                      <button
                        className="btn btn-secondary"
                        onClick={addExistingStopToBuilder}
                      >
                        Add Existing Stop
                      </button>
                    </div>
                  )}
                  {routeBuilder.stops.length > 0 && (
                    <div className="scroll-box route-stop-scroll">
                      {routeBuilder.stops.map((sid, idx) => (
                        <div
                          key={`${sid}-${idx}`}
                          className={
                            "route-stop-item" +
                            (dragStopIndex === idx ? " dragging" : "") +
                            (dragOverStopIndex === idx ? " drag-over" : "")
                          }
                          draggable
                          onDragStart={() => onBuilderStopDragStart(idx)}
                          onDragOver={e => {
                            e.preventDefault();
                            onBuilderStopDragOver(idx);
                          }}
                          onDrop={() => onBuilderStopDrop(idx)}
                          onDragEnd={onBuilderStopDragEnd}
                        >
                          <span className="route-stop-text">{idx + 1}. {stopNameMap.get(sid) || sid}</span>
                          <button className="btn btn-secondary" onClick={() => moveBuilderStop(idx, "up")}>Up</button>
                          <button className="btn btn-secondary" onClick={() => moveBuilderStop(idx, "down")}>Down</button>
                          <button className="btn btn-danger" onClick={() => removeStopFromBuilder(sid)}>x</button>
                        </div>
                      ))}
                    </div>
                  )}
                  </div>

                  <div className="list-box admin-route-bus-panel">
                    <div className="meta-title">Step 5: Assign Buses</div>
                    <div className="meta-text">
                      {selectedAdminRoute
                        ? "Pick a bus from fleet control or the dropdown below, add it here, then save the route update."
                        : "Assign one or more buses before publishing this route."}
                    </div>
                    <div className="admin-bus-summary">
                      <span className="admin-mini-chip">Assigned {routeBuilder.assignedBuses.length}</span>
                      <span className="admin-mini-chip">Available {availableBusCount}</span>
                    </div>
                    <div className="admin-inline-row admin-bus-select-row">
                      <select
                        className="input themed-select mb-none"
                        value={routeBusCandidate}
                        onChange={e => setRouteBusCandidate(e.target.value)}
                      >
                        {routeBusOptions.map(b => (
                          <option
                            key={b.id}
                            value={b.id}
                            disabled={assignedBusSet.has(String(b.id))}
                          >
                            {b.id}
                            {assignedBusSet.has(String(b.id)) ? " (Already Added)" : ""}
                          </option>
                        ))}
                      </select>
                      <button className="btn btn-secondary" onClick={addBusToBuilder}>
                        {selectedAdminRoute ? "Add Bus to Route" : "Assign Bus"}
                      </button>
                    </div>

                    <div className="admin-assigned-bus-list">
                      {routeBuilder.assignedBuses.length === 0 ? (
                        <div className="meta-muted">No buses assigned yet.</div>
                      ) : (
                        routeBuilder.assignedBuses.map(bid => (
                          <div
                            key={bid}
                            className="admin-assigned-bus-row"
                          >
                            <div className="admin-assigned-bus-meta">
                              <span className="admin-assigned-bus-id">{bid}</span>
                              <span className="meta-muted">Assigned to this route</span>
                            </div>
                            <button
                              className="btn btn-danger btn-inline admin-assigned-bus-remove"
                              onClick={() => removeBusFromBuilder(bid)}
                            >
                              Remove
                            </button>
                          </div>
                        ))
                      )}
                    </div>
                  </div>

                  <div className="list-box admin-route-publish-panel">
                    <div className="meta-title">Step 6: Publish</div>
                    <div className="meta-text">
                      Validation will block publish if route number, endpoints, line, stops, or buses are missing.
                    </div>
                  <div className="admin-inline-row wrap-row">
                    <button className="btn btn-primary" onClick={createAdminRoute}>
                      {isEditingAdminRoute ? "Save and Publish Update" : "Save and Publish"}
                    </button>
                    <button className="btn btn-secondary" onClick={resetRouteBuilder}>Reset</button>
                  </div>
                  </div>

                  {selectedAdminRouteNumber && (
                    <div className="route-history-wrap">
                      <div className="route-history-title">
                        Route History
                      </div>
                      <div className="scroll-box revision-scroll">
                        {routeRevisions.length === 0 && (
                          <div className="meta-muted">No revisions yet</div>
                        )}
                        {routeRevisions.map(rev => (
                          <div key={rev.id} className="revision-item">
                            <div className="revision-main">
                              <div className="revision-action">
                                {rev.action.toUpperCase()}
                              </div>
                              <div className="revision-date">
                                {new Date(rev.createdAt).toLocaleString()}
                              </div>
                            </div>
                            <button
                              className="btn btn-secondary btn-inline"
                              onClick={() => rollbackAdminRoute(rev.id)}
                            >
                              Rollback
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="admin-empty-note">Login required to use route builder features.</div>
              )}
            </div>
          </details>

          <details className="admin-section admin-section-simulation" open>
            <summary>Simulation Planner</summary>
            <div className="admin-section-body">
              <input
                className="input"
                placeholder="Start"
                value={startQuery}
                onFocus={() => setActiveSearch("start")}
                onChange={e => {
                  setStartQuery(e.target.value);
                  setStartPlace(null);
                  setRoutes([]);
                }}
              />
              {activeSearch === "start" && (
                <div className="autocomplete">
                  {startResults.map(place => (
                    <div
                      key={place.place_id}
                      className="suggestion"
                      onMouseDown={() => {
                        setStartQuery(place.display_name);
                        setStartPlace(place);
                        setActiveSearch(null);
                      }}
                    >
                      {place.display_name}
                    </div>
                  ))}
                </div>
              )}

              <input
                className="input"
                placeholder="End"
                value={endQuery}
                onFocus={() => setActiveSearch("end")}
                onChange={e => {
                  setEndQuery(e.target.value);
                  setEndPlace(null);
                  setRoutes([]);
                }}
              />
              {activeSearch === "end" && (
                <div className="autocomplete">
                  {endResults.map(place => (
                    <div
                      key={place.place_id}
                      className="suggestion"
                      onMouseDown={() => {
                        setEndQuery(place.display_name);
                        setEndPlace(place);
                        setActiveSearch(null);
                      }}
                    >
                      {place.display_name}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </details>

          <details className="admin-section admin-section-incidents" open>
            <summary>Incidents</summary>
            <div className="admin-section-body">
              <IncidentTypeSelect
                value={incidentType}
                onChange={e => setIncidentType(e.target.value)}
              />

              <div className="admin-inline-row">
                <button
                  className="btn btn-danger"
                  onClick={() => {
                    setRouteDrawMode(false);
                    setAddingStop(false);
                    setAddingIncident(true);
                  }}
                >
                  Add Incident on Map
                </button>
              </div>
            </div>
          </details>
        </div>
      )}
    </div>
  );
}
