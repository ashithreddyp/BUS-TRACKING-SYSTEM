function toObjectIdString(v) {
  return v == null ? null : String(v);
}

async function getRouteNumberByIdMap(RouteModel) {
  const routeDocs = await RouteModel.find({}, { _id: 1, routeNumber: 1 }).lean();
  return new Map(routeDocs.map(r => [String(r._id), r.routeNumber]));
}

function normalizeBusLive(bus, routeNumberById) {
  const routeIdStr = toObjectIdString(bus.routeId);
  return {
    ...bus,
    id: String(bus.id || bus._id),
    routeId: routeIdStr,
    routeNumber: routeIdStr ? routeNumberById.get(routeIdStr) || null : null,
    nextStop: toObjectIdString(bus.nextStop || null)
  };
}

function buildStopTimeline(stopsList, busesList) {
  const STOP_HOP_MIN = 2;
  const TERMINAL_DWELL_MIN = Math.max(
    0,
    Math.round((Number(process.env.TERMINAL_DWELL_SEC || 5 * 60) || 0) / 60)
  );
  const stopIdToIndex = new Map(stopsList.map((s, idx) => [String(s._id), idx]));
  const timeline = stopsList.map((stop, idx) => ({
    stopId: String(stop._id),
    stopName: stop.name || null,
    sequence: idx + 1,
    arrivals: []
  }));

  const addArrival = (stopIdx, arrival) => {
    if (stopIdx < 0 || stopIdx >= timeline.length) return;
    timeline[stopIdx].arrivals.push({
      busId: arrival.busId,
      routeNumber: arrival.routeNumber,
      status: arrival.status,
      direction: arrival.direction,
      eta: Math.max(0, Math.round(arrival.eta || 0))
    });
  };

  for (const bus of busesList) {
    if (bus.eta == null || !bus.nextStop) continue;
    const nextIdx = stopIdToIndex.get(String(bus.nextStop));
    if (nextIdx == null) continue;
    const baseEta = Math.max(0, Number(bus.eta) || 0);

    const direction = Number(bus.travelDirection) === -1 ? "DOWN" : "UP";
    if (direction === "UP") {
      for (let i = nextIdx; i < timeline.length; i++) {
        const hop = i - nextIdx;
        addArrival(i, {
          busId: bus.id,
          routeNumber: bus.routeNumber,
          status: bus.status,
          direction,
          eta: baseEta + hop * STOP_HOP_MIN
        });
      }

      // Also project the return trip so earlier stops show a valid next arrival ETA.
      if (timeline.length > 1 && nextIdx > 0) {
        const lastIdx = timeline.length - 1;
        const etaToTerminal = baseEta + (lastIdx - nextIdx) * STOP_HOP_MIN;
        for (let i = nextIdx - 1; i >= 0; i--) {
          const hopFromTerminal = lastIdx - i;
          addArrival(i, {
            busId: bus.id,
            routeNumber: bus.routeNumber,
            status: bus.status,
            direction: "DOWN",
            eta: etaToTerminal + TERMINAL_DWELL_MIN + hopFromTerminal * STOP_HOP_MIN
          });
        }
      }
    } else {
      for (let i = nextIdx; i >= 0; i--) {
        const hop = nextIdx - i;
        addArrival(i, {
          busId: bus.id,
          routeNumber: bus.routeNumber,
          status: bus.status,
          direction,
          eta: baseEta + hop * STOP_HOP_MIN
        });
      }

      // Also project the return trip so later stops show a valid next arrival ETA.
      if (timeline.length > 1 && nextIdx < timeline.length - 1) {
        const etaToTerminal = baseEta + nextIdx * STOP_HOP_MIN;
        for (let i = nextIdx + 1; i < timeline.length; i++) {
          addArrival(i, {
            busId: bus.id,
            routeNumber: bus.routeNumber,
            status: bus.status,
            direction: "UP",
            eta: etaToTerminal + TERMINAL_DWELL_MIN + i * STOP_HOP_MIN
          });
        }
      }
    }
  }

  timeline.forEach(t => t.arrivals.sort((a, b) => (a.eta ?? Infinity) - (b.eta ?? Infinity)));
  return timeline;
}

module.exports = {
  toObjectIdString,
  getRouteNumberByIdMap,
  normalizeBusLive,
  buildStopTimeline
};
