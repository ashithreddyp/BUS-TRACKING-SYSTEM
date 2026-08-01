import RouteTimeline from "../../pages/RouteTimeline";
import IncidentTypeSelect from "./IncidentTypeSelect";
import { getStatusClassName } from "../../utils/appHelpers";

export default function PassengerOverlay({
  passengerMode,
  passengerOverlayOpen,
  setPassengerOverlayOpen,
  passengerLegendOpen,
  setPassengerLegendOpen,
  incidentType,
  setIncidentType,
  addingIncident,
  setAddingIncident,
  passengerSearchQuery,
  setPassengerSearchQuery,
  passengerSearchResults,
  handlePassengerBusSelect,
  handlePassengerBoundarySearchSelect,
  handlePassengerStopSelect,
  selectedPassengerRoute,
  setSelectedPassengerRoute,
  clearPassengerRouteSelection,
  selectedRouteBuses,
  stopPopupArrivalById
}) {
  if (!passengerMode) return null;

  const activateSearchResult = result => {
    if (!result) return;
    if (result.type === "bus") {
      handlePassengerBusSelect(result.id, { fromSearch: true });
      return;
    }
    if (result.type === "boundary-start" || result.type === "boundary-end") {
      handlePassengerBoundarySearchSelect(
        result.id,
        result.type === "boundary-start" ? "start" : "end"
      );
      return;
    }
    handlePassengerStopSelect(result.id, { fromSearch: true });
  };

  if (!passengerOverlayOpen) {
    return (
      <div className="passenger-overlay-toggle">
        <button className="btn btn-secondary" onClick={() => setPassengerOverlayOpen(true)}>
          Open Search
        </button>
        <button className="btn btn-secondary" onClick={() => setPassengerLegendOpen(v => !v)}>
          {passengerLegendOpen ? "Hide Legend" : "Show Legend"}
        </button>
      </div>
    );
  }

  return (
    <div className="passenger-overlay">
      <div className="passenger-overlay-toolbar">
        <button className="btn btn-secondary" onClick={() => setPassengerOverlayOpen(v => !v)}>
          {passengerOverlayOpen ? "Hide Dashboard" : "Show Dashboard"}
        </button>
        <button className="btn btn-secondary" onClick={() => setPassengerLegendOpen(v => !v)}>
          {passengerLegendOpen ? "Hide Legend" : "Show Legend"}
        </button>
      </div>

      {passengerOverlayOpen && (
        <div className="list-box passenger-search-box">
          <div className="passenger-search-title">Report Incident</div>
          <IncidentTypeSelect
            value={incidentType}
            onChange={e => setIncidentType(e.target.value)}
          />
          <button
            className={addingIncident ? "btn btn-danger" : "btn btn-secondary"}
            onClick={() => {
              setAddingIncident(v => !v);
            }}
          >
            {addingIncident ? "Cancel Incident Pinning" : "Add Incident on Map"}
          </button>
        </div>
      )}

      {passengerOverlayOpen && (
        <div className="list-box passenger-search-box">
          <div className="passenger-search-title">Quick Search</div>
          <input
            className="input"
            placeholder="Search by bus number, stop, or point"
            value={passengerSearchQuery}
            onChange={e => setPassengerSearchQuery(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter" && passengerSearchResults.length) {
                e.preventDefault();
                activateSearchResult(passengerSearchResults[0]);
              }
            }}
          />
          {passengerSearchQuery.trim() && (
            <div className="passenger-search-results">
              {passengerSearchResults.length === 0 && (
                <div className="passenger-search-empty">No buses, stops, or points found</div>
              )}
              {passengerSearchResults.map(result => (
                <button
                  key={`${result.type}-search-${result.id}`}
                  type="button"
                  className="passenger-search-item"
                  onClick={() => activateSearchResult(result)}
                >
                  <span className="passenger-search-main">
                    {result.type === "bus" && `Bus ${result.label}`}
                    {result.type === "stop" && `Stop ${result.label}`}
                    {result.type === "boundary-start" && `Start ${result.label}`}
                    {result.type === "boundary-end" && `End ${result.label}`}
                  </span>
                  {result.type === "bus" && (
                    <span className={`status-chip ${getStatusClassName(result.status)}`}>
                      {result.status.replaceAll("_", " ")}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {passengerOverlayOpen && selectedPassengerRoute && (
        <div className="passenger-route-dashboard">
          <button
            className="btn btn-secondary"
            onClick={() => {
              if (typeof clearPassengerRouteSelection === "function") {
                clearPassengerRouteSelection();
              } else {
                setSelectedPassengerRoute(null);
              }
            }}
          >
            Back to Routes
          </button>
          <RouteTimeline
            route={selectedPassengerRoute}
            liveBuses={selectedRouteBuses}
            stopArrivalById={stopPopupArrivalById}
            onSelectBus={busId => {
              handlePassengerBusSelect(busId);
            }}
          />
        </div>
      )}
    </div>
  );
}
