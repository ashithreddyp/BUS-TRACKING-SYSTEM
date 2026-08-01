function createRouteManagementService({
  Bus,
  Stop,
  Route,
  RouteRevision,
  io,
  getLiveBuses,
  normalizePolylineInput
}) {
  function normalizeAssignedBuses(assignedBuses) {
    if (!Array.isArray(assignedBuses)) return [];
    return [...new Set(assignedBuses.map(v => String(v || "").trim()).filter(Boolean))];
  }

  async function getExistingBusIdSet(busIds) {
    const unique = normalizeAssignedBuses(busIds);
    if (!unique.length) return new Set();
    const docs = await Bus.find({ id: { $in: unique } }, { id: 1 }).lean();
    return new Set(docs.map(d => String(d.id)));
  }

  function diffBusIds(expectedIds, existingSet) {
    return normalizeAssignedBuses(expectedIds).filter(id => !existingSet.has(id));
  }

  async function normalizeAndValidateAssignedBuses(assignedBuses) {
    const normalized = normalizeAssignedBuses(assignedBuses);
    const existingSet = await getExistingBusIdSet(normalized);
    const missingBusIds = diffBusIds(normalized, existingSet);
    return { normalized, missingBusIds };
  }

  async function validateStopIds(stopIds) {
    if (!Array.isArray(stopIds) || !stopIds.length) return false;
    const unique = [...new Set(stopIds.map(String))];
    const count = await Stop.countDocuments({ _id: { $in: unique } });
    return count === unique.length;
  }

  async function syncRouteBusAssignments(routeDoc, nextBusIds) {
    const liveBuses = getLiveBuses();
    const prev = new Set((routeDoc.assignedBuses || []).map(String));
    const next = new Set((nextBusIds || []).map(String));

    const toAdd = [...next].filter(id => !prev.has(id));
    const toRemove = [...prev].filter(id => !next.has(id));

    if (toAdd.length) {
      const existingAssignments = await Bus.find(
        { id: { $in: toAdd }, routeId: { $nin: [null, routeDoc._id] } },
        { id: 1, routeId: 1 }
      ).lean();
      const oldRouteIds = [
        ...new Set(
          existingAssignments
            .map(bus => String(bus.routeId || ""))
            .filter(Boolean)
        )
      ];
      if (oldRouteIds.length) {
        await Route.updateMany(
          { _id: { $in: oldRouteIds } },
          { $pull: { assignedBuses: { $in: toAdd } } }
        );
      }

      await Bus.updateMany({ id: { $in: toAdd } }, { $set: { routeId: routeDoc._id } });
      liveBuses.forEach(bus => {
        if (toAdd.includes(String(bus.id))) bus.routeId = routeDoc._id;
      });
    }

    if (toRemove.length) {
      await Bus.updateMany(
        { id: { $in: toRemove }, routeId: routeDoc._id },
        {
          $set: {
            routeId: null,
            route: [],
            index: 0,
            running: false,
            status: "STOPPED",
            eta: null,
            etaLower: null,
            etaUpper: null,
            etaConfidencePlusMinus: null,
            location: null,
            bearing: 0,
            dwellRemainingSec: 0,
            nextStop: null,
            travelDirection: 1,
            predictedDelayMinutes: null,
            clusterId: null,
            mappedLabel: null
          }
        }
      );
      liveBuses.forEach(bus => {
        if (toRemove.includes(String(bus.id)) && String(bus.routeId || "") === String(routeDoc._id)) {
          Object.assign(bus, {
            routeId: null,
            route: [],
            index: 0,
            running: false,
            status: "STOPPED",
            eta: null,
            etaLower: null,
            etaUpper: null,
            etaConfidencePlusMinus: null,
            location: null,
            bearing: 0,
            dwellRemainingSec: 0,
            dwellUntilTs: null,
            nextStop: null,
            travelDirection: 1,
            predictedDelayMinutes: null,
            clusterId: null,
            mappedLabel: null
          });
          io.emit("busUpdate", bus);
        }
      });
    }

    routeDoc.assignedBuses = [...next];
    await routeDoc.save();
    return {
      addedBusIds: toAdd,
      removedBusIds: toRemove,
      retainedBusIds: [...next].filter(id => prev.has(id))
    };
  }

  async function activateRouteForBuses(routeDoc, busIds, options = {}) {
    const liveBuses = getLiveBuses();
    const targetBusIds = normalizeAssignedBuses(busIds);
    const routePolyline = normalizePolylineInput(routeDoc?.polyline || []);
    if (!targetBusIds.length || routePolyline.length < 2) {
      return { startedBusIds: [] };
    }

    const preserveExisting = !!options.preserveExisting;
    const routeLength = routePolyline.length;
    const maxSpread = Math.max(0, Math.min(routeLength - 1, (routeDoc.stops?.length || 1) * 2));
    const terminalDwellSec = Math.max(1, Math.round(Number(process.env.TERMINAL_DWELL_SEC || 5 * 60)));
    const firstStopId = routeDoc.stops?.[0] || null;

    for (let position = 0; position < targetBusIds.length; position++) {
      const busId = targetBusIds[position];
      const spreadIndex =
        targetBusIds.length <= 1 || maxSpread <= 0
          ? 0
          : Math.min(
              maxSpread,
              Math.round((position / Math.max(1, targetBusIds.length - 1)) * maxSpread)
            );
      const startPoint = routePolyline[spreadIndex] || routePolyline[0];
      const isInitialTerminalBus = position === 0;
      const liveBus = liveBuses.find(bus => String(bus.id) === String(busId));
      const shouldPreserveLiveState =
        preserveExisting &&
        liveBus &&
        String(liveBus.routeId || "") === String(routeDoc._id) &&
        Array.isArray(liveBus.route) &&
        liveBus.route.length > 1;

      const update = {
        routeId: routeDoc._id,
        route: routePolyline,
        index: shouldPreserveLiveState
          ? Math.max(0, Math.min(routeLength - 1, Number(liveBus.index) || 0))
          : spreadIndex,
        running: shouldPreserveLiveState ? !!liveBus.running : !isInitialTerminalBus,
        status: shouldPreserveLiveState
          ? liveBus.status || "ON_TIME"
          : isInitialTerminalBus
            ? "STOPPED_AT_STOP"
            : "ON_TIME",
        eta: shouldPreserveLiveState ? liveBus.eta ?? null : null,
        location: shouldPreserveLiveState ? liveBus.location || startPoint : startPoint,
        bearing: shouldPreserveLiveState ? Number(liveBus.bearing) || 0 : 0,
        dwellRemainingSec: shouldPreserveLiveState
          ? Math.max(0, Number(liveBus.dwellRemainingSec) || 0)
          : isInitialTerminalBus
            ? terminalDwellSec
            : 0,
        nextStop: shouldPreserveLiveState ? liveBus.nextStop || firstStopId : firstStopId,
        travelDirection: shouldPreserveLiveState ? Number(liveBus.travelDirection) || 1 : 1
      };

      await Bus.updateOne({ id: busId }, { $set: update });

      if (liveBus) {
        Object.assign(liveBus, {
          routeId: routeDoc._id,
          route: routePolyline,
          index: update.index,
          running: update.running,
          status: update.status,
          eta: update.eta,
          location: update.location,
          bearing: update.bearing,
          dwellRemainingSec: update.dwellRemainingSec,
          dwellUntilTs: shouldPreserveLiveState
            ? liveBus.dwellUntilTs || null
            : isInitialTerminalBus
              ? Date.now() + terminalDwellSec * 1000
              : null,
          nextStop: update.nextStop,
          travelDirection: update.travelDirection
        });
        io.emit("busUpdate", liveBus);
      }
    }

    return { startedBusIds: targetBusIds };
  }

  function createRouteSnapshot(routeDoc) {
    return {
      routeNumber: String(routeDoc.routeNumber || "").trim(),
      routeName: routeDoc.routeName || null,
      startPointName: routeDoc.startPointName || null,
      endPointName: routeDoc.endPointName || null,
      stops: (routeDoc.stops || []).map(stop => String(stop)),
      polyline: normalizePolylineInput(routeDoc.polyline || []),
      assignedBuses: normalizeAssignedBuses(routeDoc.assignedBuses || [])
    };
  }

  async function recordRouteRevision({ routeDoc, action, metadata = {} }) {
    if (!routeDoc?._id) return;
    try {
      await RouteRevision.create({
        routeId: routeDoc._id,
        routeNumber: String(routeDoc.routeNumber || ""),
        action,
        snapshot: createRouteSnapshot(routeDoc),
        metadata: {
          previousRouteNumber: metadata.previousRouteNumber || null,
          changedFields: Array.isArray(metadata.changedFields) ? metadata.changedFields : []
        }
      });
    } catch (error) {
      console.error("Failed to record route revision", error.message);
    }
  }

  return {
    normalizeAssignedBuses,
    normalizeAndValidateAssignedBuses,
    validateStopIds,
    syncRouteBusAssignments,
    activateRouteForBuses,
    recordRouteRevision
  };
}

module.exports = { createRouteManagementService };
