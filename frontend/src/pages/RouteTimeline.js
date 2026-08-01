import { useMemo } from "react";
import {
  formatRouteBusEtaLabel,
  formatStatusLabel,
  getStatusClassName,
  sanitizeStopName
} from "../utils/appHelpers";

export default function RouteTimeline({ route, liveBuses = [], stopArrivalById = {}, onSelectBus }) {
  const timeline = useMemo(() => {
    const stops = Array.isArray(route?.stops) ? route.stops : [];
    return stops.map((stop, idx) => {
      const stopId = String(stop?._id || stop?.id || "");
      const stopArrival = stopArrivalById?.[stopId] || null;
      const arrivals = (Array.isArray(stopArrival?.arrivals) ? stopArrival.arrivals : [])
        .filter(arrival => arrival && Number.isFinite(arrival.eta))
        .sort((a, b) => (a.eta ?? Infinity) - (b.eta ?? Infinity));
      return {
        stop,
        stopId,
        sequence: idx + 1,
        arrivals,
        fastestArrival: arrivals[0] || null
      };
    });
  }, [route, stopArrivalById]);

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
            {formatStatusLabel(bus.status)}
          </span>
          <span className="route-timeline-eta">{bus.eta == null ? "ETA -" : `ETA ${bus.eta} min`}</span>
        </div>
      ))}

      <h4 className="route-timeline-subtitle">Stop Timeline</h4>
      <div className="route-timeline-list">
        {timeline.map(item => (
          <div key={item.stopId || `${route?.routeNumber || "route"}-${item.sequence}`} className="route-timeline-item">
            <b className="route-timeline-stop">
              {item.sequence}. {sanitizeStopName(item.stop?.name) || item.stopId || "-"}
            </b>
            {item.arrivals.length === 0 ? (
              <div className="route-timeline-muted">No upcoming buses</div>
            ) : (
              <>
                {item.fastestArrival && (
                  <div className="route-timeline-arrival route-timeline-fastest">
                    <span className="route-timeline-arrival-main">
                      Fastest: {formatRouteBusEtaLabel(item.fastestArrival, item.fastestArrival.routeNumber || route.routeNumber)}
                    </span>
                    <span className={`status-chip ${getStatusClassName(item.fastestArrival.status || "ON_TIME")}`}>
                      {formatStatusLabel(item.fastestArrival.status || "ON_TIME")}
                    </span>
                  </div>
                )}
                {item.arrivals.map(arrival => (
                  <div
                    key={`${item.stopId}-${arrival.routeNumber || route?.routeNumber || "route"}-${arrival.busId || "bus"}-${arrival.direction || "dir"}`}
                    className="route-timeline-arrival"
                  >
                    <span className="route-timeline-arrival-main">
                      {formatRouteBusEtaLabel(arrival, arrival.routeNumber || route.routeNumber)}
                    </span>
                    <span className={`status-chip ${getStatusClassName(arrival.status || "ON_TIME")}`}>
                      {formatStatusLabel(arrival.status || "ON_TIME")}
                    </span>
                  </div>
                ))}
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
