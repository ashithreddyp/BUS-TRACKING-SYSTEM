import { useMemo } from "react";

function getStatusClassName(status) {
  const value = String(status || "").toUpperCase();
  if (value.includes("DELAY")) return "delay";
  if (value.includes("STOP")) return "stop";
  return "on";
}

function getStatusLabel(status) {
  return String(status || "ON_TIME").replaceAll("_", " ");
}

function computeStopTimeline(route, liveBuses) {
  const stops = route?.stops || [];
  const stopIdToIndex = new Map(stops.map((s, idx) => [String(s._id || s.id), idx]));
  const timeline = stops.map((stop, idx) => ({
    stop,
    sequence: idx + 1,
    arrivals: []
  }));

  liveBuses.forEach(bus => {
    if (bus.eta == null || !bus.nextStop) return;
    const nextStopIndex = stopIdToIndex.get(String(bus.nextStop));
    if (nextStopIndex == null) return;

    for (let i = nextStopIndex; i < timeline.length; i++) {
      const hop = i - nextStopIndex;
      timeline[i].arrivals.push({
        busId: bus.id,
        routeNumber: bus.routeNumber || route.routeNumber,
        eta: Math.max(0, Math.round((bus.eta || 0) + hop * 2)),
        status: bus.status
      });
    }
  });

  timeline.forEach(entry => {
    entry.arrivals.sort((a, b) => (a.eta ?? Infinity) - (b.eta ?? Infinity));
  });

  return timeline;
}

export default function RouteTimeline({ route, liveBuses = [], onSelectBus }) {
  const timeline = useMemo(() => computeStopTimeline(route, liveBuses), [route, liveBuses]);
  const statusSummary = useMemo(() => {
    const delayed = liveBuses.filter(bus => getStatusClassName(bus.status) === "delay").length;
    const stopped = liveBuses.filter(bus => getStatusClassName(bus.status) === "stop").length;
    const onTime = Math.max(0, liveBuses.length - delayed - stopped);
    return { onTime, delayed, stopped };
  }, [liveBuses]);

  if (!route) return null;

  return (
    <div className="list-box route-timeline-card">
      <h3 className="route-timeline-title">
        Route {route.routeNumber} {route.routeName ? `- ${route.routeName}` : ""}
      </h3>

      <div className="route-timeline-summary">
        <b>Live buses:</b>{" "}
        {liveBuses.length === 0 ? "No active buses" : `${liveBuses.length} running`}
      </div>
      {liveBuses.length > 0 && (
        <div className="route-timeline-pill-row">
          <span className="status-chip on">{statusSummary.onTime} On Time</span>
          <span className="status-chip delay">{statusSummary.delayed} Delayed</span>
          <span className="status-chip stop">{statusSummary.stopped} Stopped</span>
        </div>
      )}

      {liveBuses.map(bus => (
        <div key={bus.id} className="route-timeline-bus-row">
          <button className="btn btn-secondary btn-inline" onClick={() => onSelectBus && onSelectBus(bus.id)}>
            Follow {bus.id}
          </button>
          <span className={`status-chip ${getStatusClassName(bus.status)}`}>
            {getStatusLabel(bus.status)}
          </span>
          <span className="route-timeline-eta">{bus.eta == null ? "ETA -" : `ETA ${bus.eta} min`}</span>
        </div>
      ))}

      <h4 className="route-timeline-subtitle">Stop Timeline</h4>
      <div className="route-timeline-list">
        {timeline.map(item => (
          <div key={item.stop._id || item.stop.id} className="route-timeline-item">
            <b className="route-timeline-stop">
              {item.sequence}. {item.stop.name || item.stop._id || item.stop.id}
            </b>
            {item.arrivals.length === 0 ? (
              <div className="route-timeline-muted">No upcoming buses</div>
            ) : (
              item.arrivals.map(arrival => (
                <div key={`${item.stop._id || item.stop.id}-${arrival.busId}`} className="route-timeline-arrival">
                  <span className="route-timeline-arrival-main">
                    {arrival.routeNumber || route.routeNumber} / {arrival.busId} - {arrival.eta} min
                  </span>
                  <span className={`status-chip ${getStatusClassName(arrival.status)}`}>
                    {getStatusLabel(arrival.status)}
                  </span>
                </div>
              ))
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
