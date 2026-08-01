require('dotenv').config();
const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const startSimulation = require("./simulation/gpsSimulator");
const mongoose = require("mongoose");
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const Bus = require("./models/Bus");
const Stop = require("./models/Stop");
const Incident = require("./models/Incident");
const Route = require("./models/Route");
const RouteRevision = require("./models/RouteRevision");
const SimulationLog = require("./models/SimulationLog");
const {
  ETA_FEATURES,
  DELAY_FEATURES,
  PEAK_FEATURES,
  ALL_INPUTS,
  OUTPUT_NAMES,
  predictTransitOutputs,
  predictEtaRange,
  buildTrainingSamples,
  trainTransitModels,
  saveModel,
  loadModel
} = require("./ml/etaModel");
const {
  createLiveWeatherProvider,
  enrichLogsWithHistoricalWeather,
  enrichLogsWithCalendarSignals
} = require("./ml/externalData");
const {
  toObjectIdString,
  getRouteNumberByIdMap,
  normalizeBusLive,
  buildStopTimeline,
  buildStopArrivalsForStop
} = require("./services/passengerUtils");
const { createRouteManagementService } = require("./services/routeManagement");
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

const app = express();
app.use(cors());
app.use(express.json());

function areStringArraysEqual(left = [], right = []) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (String(left[index]) !== String(right[index])) return false;
  }
  return true;
}

function arePolylinePointsEqual(leftPoint = {}, rightPoint = {}) {
  const leftLat = Number(leftPoint.lat);
  const leftLng = Number(leftPoint.lng);
  const rightLat = Number(rightPoint.lat);
  const rightLng = Number(rightPoint.lng);
  return Number.isFinite(leftLat) && Number.isFinite(leftLng) && leftLat === rightLat && leftLng === rightLng && Number.isFinite(rightLat) && Number.isFinite(rightLng);
}

function arePolylinesEqual(left = [], right = []) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (!arePolylinePointsEqual(left[index], right[index])) return false;
  }
  return true;
}

const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';
const TOKEN_TTL = process.env.TOKEN_TTL || '8h';
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || '';

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload?.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    req.user = payload;
    return next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

app.post('/auth/login', async (req, res) => {
  const { password } = req.body || {};
  if (!ADMIN_PASSWORD_HASH) return res.status(500).json({ error: 'Admin not configured' });
  if (!password) return res.status(400).json({ error: 'Password required' });
  const ok = await bcrypt.compare(password, ADMIN_PASSWORD_HASH);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
  const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: TOKEN_TTL });
  res.json({ token });
});

app.get("/api/passenger/ml/status", async (req, res) => {
  const weather = liveWeatherProvider.getSnapshot();
  const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  let trainingData = {
    logs30d: 0,
    totalLogs: 0,
    lastLogAt: null
  };

  try {
    const [logs30d, totalLogs, latestLog] = await Promise.all([
      SimulationLog.countDocuments({ timestamp: { $gte: since30d } }),
      SimulationLog.estimatedDocumentCount(),
      SimulationLog.findOne({}, { timestamp: 1 }).sort({ timestamp: -1 }).lean()
    ]);

    trainingData = {
      logs30d: Number.isFinite(Number(logs30d)) ? Number(logs30d) : 0,
      totalLogs: Number.isFinite(Number(totalLogs)) ? Number(totalLogs) : 0,
      lastLogAt: latestLog?.timestamp || null
    };
  } catch (e) {
    console.error("Failed to compute ML status training data", e.message);
  }

  if (!etaModel) {
    return res.json({
      enabled: false,
      trainedAt: null,
      samples: 0,
      inputGroups: {
        eta: ETA_FEATURES,
        delay: DELAY_FEATURES,
        peak: PEAK_FEATURES,
        all: ALL_INPUTS
      },
      outputNames: OUTPUT_NAMES,
      etaModel: null,
      delayModel: null,
      peakModel: null,
      externalWeather: weather,
      trainingData
    });
  }
  return res.json({
    enabled: true,
    trainedAt: etaModel.trainedAt,
    samples: etaModel.samples || 0,
    inputGroups: etaModel.inputGroups || {
      eta: ETA_FEATURES,
      delay: DELAY_FEATURES,
      peak: PEAK_FEATURES,
      all: ALL_INPUTS
    },
    outputNames: etaModel.outputNames || OUTPUT_NAMES,
    etaModel: etaModel.etaModel
      ? {
          trainedAt: etaModel.trainedAt || null,
          sampleCount: etaModel.samples || 0,
          featureNames: etaModel.etaModel.featureNames || ETA_FEATURES,
          targetName: etaModel.etaModel.targetName || "predicted_eta_minutes"
        }
      : null,
    delayModel: etaModel.delayModel
      ? {
          trainedAt: etaModel.trainedAt || null,
          sampleCount: etaModel.samples || 0,
          featureNames: etaModel.delayModel.featureNames || DELAY_FEATURES,
          targetName: etaModel.delayModel.targetName || "predicted_delay_minutes"
        }
      : null,
    peakModel: etaModel.peakModel
      ? {
          trainedAt: etaModel.trainedAt || null,
          sampleCount: etaModel.samples || 0,
          featureNames: etaModel.peakModel.featureNames || PEAK_FEATURES,
          clusterSizes: etaModel.peakModel.clusterSizes || {},
          labels: etaModel.peakModel.clusterLabelMap || {}
        }
      : null,
    externalWeather: weather,
    trainingData
  });
});

app.post("/api/admin/ml/weather/refresh", requireAdmin, async (req, res) => {
  try {
    const snapshot = await liveWeatherProvider.refreshNow();
    return res.json({
      status: "ok",
      weather: snapshot || null
    });
  } catch (e) {
    return res.status(500).json({ error: "Weather refresh failed" });
  }
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

let buses = [];
let incidents = [];
let stops = [];
let routeStopIdsByRouteId = new Map();
let etaModel = loadModel();
const INCIDENT_REMINDER_MS = Number(process.env.INCIDENT_REMINDER_MS || 30 * 60 * 1000);
const INCIDENT_CHECK_INTERVAL_MS = Number(process.env.INCIDENT_CHECK_INTERVAL_MS || 60 * 1000);
const liveWeatherProvider = createLiveWeatherProvider({
  latitude: Number(process.env.EXTERNAL_WEATHER_LAT || 13.0827),
  longitude: Number(process.env.EXTERNAL_WEATHER_LNG || 77.5877),
  intervalMs: Number(process.env.EXTERNAL_WEATHER_INTERVAL_MS || 15 * 60 * 1000)
});
liveWeatherProvider.start();

function updateWeatherLocationFromStops() {
  if (!Array.isArray(stops) || !stops.length) return;
  const first = stops.find(s => s?.location?.lat != null && s?.location?.lng != null);
  if (!first) return;
  liveWeatherProvider.setLocation(first.location.lat, first.location.lng);
}

function mapIncidentResponse(incident) {
  return {
    ...incident,
    id: String(incident._id || incident.id)
  };
}

function mapStopResponse(stop) {
  return {
    ...stop,
    id: String(stop._id || stop.id)
  };
}

function mapStopListResponse(stopList = stops) {
  return stopList.map(mapStopResponse);
}

function emitStopsUpdate() {
  io.emit("stopsUpdate", mapStopListResponse());
}

function emitIncidentUpdate() {
  io.emit("incidentUpdate", incidents.map(mapIncidentResponse));
}

async function maybeEmitIncidentRemovalPrompt(incident) {
  const createdAtTs = new Date(incident.createdAt || Date.now()).getTime();
  if (!Number.isFinite(createdAtTs)) return;

  const now = Date.now();
  const ageMs = now - createdAtTs;
  if (ageMs < INCIDENT_REMINDER_MS) return;

  const lastPromptTs = incident.lastPromptAt ? new Date(incident.lastPromptAt).getTime() : 0;
  if (lastPromptTs && now - lastPromptTs < INCIDENT_REMINDER_MS) return;

  const nextPromptAt = new Date(now + INCIDENT_REMINDER_MS).toISOString();
  io.emit("incidentRemovalPrompt", {
    incidentId: String(incident._id || incident.id),
    incidentType: incident.type,
    createdByRole: incident.createdByRole || "user",
    ageMinutes: Math.floor(ageMs / 60000),
    nextPromptAt
  });

  incident.lastPromptAt = new Date(now);
  try {
    await Incident.updateOne(
      { _id: incident._id },
      { $set: { lastPromptAt: incident.lastPromptAt } }
    );
  } catch (e) {
    console.error("Failed to persist incident prompt timestamp", e.message);
  }
}

function normalizePolylineInput(polyline) {
  if (!Array.isArray(polyline)) return [];
  return polyline
    .map(p => ({
      lat: Number(p?.lat),
      lng: Number(p?.lng)
    }))
    .filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lng));
}

function normalizeRouteStopIds(stopIds) {
  if (!Array.isArray(stopIds)) return [];
  return stopIds.map(s => String(s)).filter(Boolean);
}

function setRouteStopMapForRoute(routeDoc) {
  if (!routeDoc?._id) return;
  const routeId = String(routeDoc._id);
  routeStopIdsByRouteId.set(routeId, normalizeRouteStopIds(routeDoc.stops || []));
}

async function refreshRouteStopMap() {
  const routes = await Route.find({}, { _id: 1, stops: 1 }).lean();
  routeStopIdsByRouteId = new Map(
    routes.map(route => [String(route._id), normalizeRouteStopIds(route.stops || [])])
  );
}
const {
  normalizeAssignedBuses,
  normalizeAndValidateAssignedBuses,
  validateStopIds,
  syncRouteBusAssignments,
  activateRouteForBuses,
  recordRouteRevision
} = createRouteManagementService({
  Bus,
  Stop,
  Route,
  RouteRevision,
  io,
  getLiveBuses: () => buses,
  normalizePolylineInput
});

const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/bus_tracking";
mongoose.connect(MONGO_URI).then(() => console.log("MongoDB connected")).catch(err => console.error("MongoDB error", err));

async function loadFromDB() {
  const [dbBuses, dbIncidents, dbStops] = await Promise.all([
    Bus.find().lean(),
    Incident.find().lean(),
    Stop.find().lean()
  ]);
  await refreshRouteStopMap();

  buses.splice(0, buses.length, ...dbBuses.map(b => ({
    ...b,
    route: Array.isArray(b.route) ? b.route : [],
    index: Number.isFinite(b.index) ? b.index : 0,
    eta: b.eta ?? null,
    etaLower: Number.isFinite(Number(b.etaLower)) ? Number(b.etaLower) : null,
    etaUpper: Number.isFinite(Number(b.etaUpper)) ? Number(b.etaUpper) : null,
    etaConfidencePlusMinus: Number.isFinite(Number(b.etaConfidencePlusMinus))
      ? Number(b.etaConfidencePlusMinus)
      : null,
    status: b.status || "ON_TIME",
    delayRiskLabel: b.delayRiskLabel || null,
    delayRiskConfidence: Number.isFinite(Number(b.delayRiskConfidence))
      ? Number(b.delayRiskConfidence)
      : null,
    predictedDelayMinutes: Number.isFinite(Number(b.predictedDelayMinutes))
      ? Number(b.predictedDelayMinutes)
      : null,
    clusterId: Number.isFinite(Number(b.clusterId)) ? Number(b.clusterId) : null,
    mappedLabel: b.mappedLabel || null,
    running: !!b.running,
    location: b.location || null,
    bearing: Number.isFinite(b.bearing) ? b.bearing : 0,
    dwellRemainingSec: Number.isFinite(b.dwellRemainingSec) ? b.dwellRemainingSec : 0,
    nextStop: b.nextStop || null,
    travelDirection: b.travelDirection === -1 ? -1 : 1
  })));

  incidents.splice(0, incidents.length, ...dbIncidents);
  stops.splice(0, stops.length, ...dbStops);
  updateWeatherLocationFromStops();

  io.emit("busRemoved", { all: true });
  emitIncidentUpdate();
  emitStopsUpdate();
}

loadFromDB().catch(console.error);

app.get("/search", async (req, res) => {
  try {
    const q = req.query.q;
    if (!q) return res.json([]);

    const r = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}`,
      { headers: { "User-Agent": "Bus-System/1.0" } }
    );

    res.json((await r.json()).slice(0, 5));
  } catch {
    res.json([]);
  }
});
app.get("/buses", async (req, res) => {
  const dbBuses = await Bus.find().lean();
  res.json(dbBuses.map(b => ({
    ...b,
    id: String(b.id || b._id)
  })));
});

app.get("/stops", (req, res) => {
  res.json(mapStopListResponse());
});
app.get("/incidents", (req, res) => {
  res.json(incidents.map(mapIncidentResponse));
});

app.post("/stops", requireAdmin, async (req, res) => {
  const { lat, lng, name } = req.body || {};
  if (typeof lat !== "number" || typeof lng !== "number") {
    return res.status(400).json({ error: "lat and lng are required numbers" });
  }
  const created = await Stop.create({ name: name || null, location: { lat, lng } });
  const stop = created.toObject();
  stops.push(stop);
  updateWeatherLocationFromStops();
  emitStopsUpdate();
  res.json({ status: "stop added", stop });
});

app.patch("/stops/:id", requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const { name } = req.body || {};
    if (name === undefined) {
      return res.status(400).json({ error: "name is required" });
    }

    const cleanName = String(name || "").trim() || null;
    const updated = await Stop.findByIdAndUpdate(
      id,
      { $set: { name: cleanName } },
      { new: true }
    ).lean();
    if (!updated) return res.status(404).json({ error: "Stop not found" });

    const idx = stops.findIndex(s => String(s._id || s.id) === String(id));
    if (idx !== -1) {
      stops[idx] = updated;
    } else {
      stops.push(updated);
    }

    emitStopsUpdate();
    return res.json({ status: "stop updated", stop: { ...updated, id: String(updated._id) } });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Stop update failed" });
  }
});
app.post("/api/admin/routes", requireAdmin, async (req, res) => {
  try {
    const {
      routeNumber,
      routeName,
      startPointName,
      endPointName,
      stops,
      polyline,
      assignedBuses = []
    } = req.body;
    const cleanRouteNumber = String(routeNumber || "").trim();

    if (!cleanRouteNumber || !Array.isArray(stops) || !stops.length) {
      return res.status(400).json({ error: "Invalid route data" });
    }

    const validStops = await validateStopIds(stops);
    if (!validStops) {
      return res.status(400).json({ error: "One or more stop ids are invalid" });
    }

    const existing = await Route.findOne({ routeNumber: cleanRouteNumber });
    if (existing) {
      return res.status(400).json({ error: "Route already exists" });
    }

    const normalizedPolyline = normalizePolylineInput(polyline);
    const {
      normalized: normalizedAssignedBuses,
      missingBusIds
    } = await normalizeAndValidateAssignedBuses(assignedBuses);
    if (missingBusIds.length) {
      return res.status(400).json({
        error: "One or more bus ids are invalid",
        missingBusIds
      });
    }

    const route = await Route.create({
      routeNumber: cleanRouteNumber,
      routeName,
      startPointName: startPointName || null,
      endPointName: endPointName || null,
      stops,
      polyline: normalizedPolyline,
      assignedBuses: []
    });
    setRouteStopMapForRoute(route);

    let startedBusIds = [];
    if (normalizedAssignedBuses.length) {
      const assignmentChanges = await syncRouteBusAssignments(route, normalizedAssignedBuses);
      const activation = await activateRouteForBuses(
        route,
        assignmentChanges.addedBusIds.length ? assignmentChanges.addedBusIds : normalizedAssignedBuses
      );
      startedBusIds = activation.startedBusIds;
    }

    await recordRouteRevision({ routeDoc: route, action: "create" });
    res.json({ status: "route created", route, startedBusIds });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Route creation failed" });
  }
});

app.get("/api/admin/routes", requireAdmin, async (req, res) => {
  try {
    const routes = await Route.find().populate("stops").sort({ routeNumber: 1 }).lean();
    return res.json(
      routes.map(r => ({
        ...r,
        id: String(r._id)
      }))
    );
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Route fetch failed" });
  }
});

app.get("/api/admin/routes/:routeNumber/revisions", requireAdmin, async (req, res) => {
  try {
    const route = await Route.findOne({ routeNumber: req.params.routeNumber }, { _id: 1, routeNumber: 1 }).lean();
    if (!route) return res.status(404).json({ error: "Route not found" });

    const revisions = await RouteRevision.find({ routeId: route._id })
      .sort({ createdAt: -1 })
      .limit(30)
      .lean();

    return res.json(
      revisions.map(r => ({
        id: String(r._id),
        action: r.action,
        routeNumber: r.routeNumber,
        createdAt: r.createdAt,
        metadata: r.metadata || {},
        snapshot: r.snapshot || null
      }))
    );
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Route revision fetch failed" });
  }
});

app.patch("/api/admin/routes/:routeNumber", requireAdmin, async (req, res) => {
  try {
    const currentRouteNumber = req.params.routeNumber;
    const route = await Route.findOne({ routeNumber: currentRouteNumber });
    if (!route) return res.status(404).json({ error: "Route not found" });
    const changedFields = [];
    const previousRouteNumber = route.routeNumber;

    const {
      newRouteNumber,
      routeName,
      startPointName,
      endPointName,
      stops: updatedStops,
      polyline,
      assignedBuses
    } = req.body || {};

    if (newRouteNumber && String(newRouteNumber).trim() !== route.routeNumber) {
      const cleanNew = String(newRouteNumber).trim();
      const duplicate = await Route.findOne({ routeNumber: cleanNew });
      if (duplicate) return res.status(400).json({ error: "Route number already exists" });
      route.routeNumber = cleanNew;
      changedFields.push("routeNumber");
    }

    if (routeName !== undefined) {
      route.routeName = routeName || null;
      changedFields.push("routeName");
    }

    if (startPointName !== undefined) {
      route.startPointName = startPointName || null;
      changedFields.push("startPointName");
    }

    if (endPointName !== undefined) {
      route.endPointName = endPointName || null;
      changedFields.push("endPointName");
    }

    if (updatedStops !== undefined) {
      if (!Array.isArray(updatedStops) || !updatedStops.length) {
        return res.status(400).json({ error: "stops must be a non-empty array" });
      }
      const validStops = await validateStopIds(updatedStops);
      if (!validStops) {
        return res.status(400).json({ error: "One or more stop ids are invalid" });
      }
      if (!areStringArraysEqual(route.stops || [], updatedStops)) {
        route.stops = updatedStops;
        setRouteStopMapForRoute(route);
        changedFields.push("stops");
      }
    }

    if (polyline !== undefined) {
      const normalizedPolyline = normalizePolylineInput(polyline);
      if (!arePolylinesEqual(route.polyline || [], normalizedPolyline)) {
        route.polyline = normalizedPolyline;
        changedFields.push("polyline");
      }
    }

    let assignmentChanges = null;
    if (assignedBuses !== undefined) {
      const { normalized, missingBusIds } = await normalizeAndValidateAssignedBuses(assignedBuses);
      if (missingBusIds.length) {
        return res.status(400).json({
          error: "One or more bus ids are invalid",
          missingBusIds
        });
      }
      assignmentChanges = await syncRouteBusAssignments(route, normalized);
      changedFields.push("assignedBuses");
    } else {
      await route.save();
    }

    const activeAssignedBuses = normalizeAssignedBuses(route.assignedBuses || []);
    const hasRouteShapeChange =
      changedFields.includes("stops") || changedFields.includes("polyline");
    const busesToActivate = hasRouteShapeChange
      ? activeAssignedBuses
      : assignmentChanges?.addedBusIds || [];
    const activation = await activateRouteForBuses(route, busesToActivate, {
      preserveExisting: !hasRouteShapeChange
    });
    if (activation.startedBusIds.length) changedFields.push("simulationStart");

    await recordRouteRevision({
      routeDoc: route,
      action: "update",
      metadata: { previousRouteNumber, changedFields }
    });

    const refreshed = await Route.findById(route._id).populate("stops").lean();
    return res.json({
      status: "route updated",
      route: refreshed,
      startedBusIds: activation.startedBusIds || []
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Route update failed" });
  }
});

app.post("/api/admin/routes/:routeNumber/rollback/:revisionId", requireAdmin, async (req, res) => {
  try {
    const route = await Route.findOne({ routeNumber: req.params.routeNumber });
    if (!route) return res.status(404).json({ error: "Route not found" });

    const revision = await RouteRevision.findOne({
      _id: req.params.revisionId,
      routeId: route._id
    }).lean();
    if (!revision || !revision.snapshot) {
      return res.status(404).json({ error: "Revision not found" });
    }

    const snapshot = revision.snapshot;
    const targetRouteNumber = String(snapshot.routeNumber || "").trim();
    if (!targetRouteNumber) {
      return res.status(400).json({ error: "Revision snapshot is invalid" });
    }

    if (targetRouteNumber !== route.routeNumber) {
      const duplicate = await Route.findOne({
        routeNumber: targetRouteNumber,
        _id: { $ne: route._id }
      }).lean();
      if (duplicate) {
        return res.status(400).json({ error: "Cannot rollback: route number already exists" });
      }
    }

    const snapshotStops = Array.isArray(snapshot.stops) ? snapshot.stops.map(String) : [];
    if (!snapshotStops.length) {
      return res.status(400).json({ error: "Cannot rollback: revision has no stops" });
    }
    const validStops = await validateStopIds(snapshotStops);
    if (!validStops) {
      return res.status(400).json({ error: "Cannot rollback: revision contains missing stops" });
    }

    route.routeNumber = targetRouteNumber;
    route.routeName = snapshot.routeName || null;
    route.startPointName = snapshot.startPointName || null;
    route.endPointName = snapshot.endPointName || null;
    route.stops = snapshotStops;
    route.polyline = normalizePolylineInput(snapshot.polyline || []);
    setRouteStopMapForRoute(route);
    await route.save();

    const {
      normalized: rollbackBuses,
      missingBusIds
    } = await normalizeAndValidateAssignedBuses(snapshot.assignedBuses || []);
    if (missingBusIds.length) {
      return res.status(400).json({
        error: "Cannot rollback: revision contains missing buses",
        missingBusIds
      });
    }
    await syncRouteBusAssignments(route, rollbackBuses);
    await activateRouteForBuses(route, rollbackBuses);

    await recordRouteRevision({
      routeDoc: route,
      action: "rollback",
      metadata: {
        previousRouteNumber: req.params.routeNumber,
        changedFields: [
          "routeNumber",
          "routeName",
          "startPointName",
          "endPointName",
          "stops",
          "polyline",
          "assignedBuses"
        ]
      }
    });

    const refreshed = await Route.findById(route._id).populate("stops").lean();
    return res.json({
      status: "route rolled back",
      route: refreshed,
      revisionId: String(revision._id)
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Route rollback failed" });
  }
});

app.delete("/api/admin/routes/:routeNumber", requireAdmin, async (req, res) => {
  try {
    const routeNumber = req.params.routeNumber;
    const route = await Route.findOne({ routeNumber });
    if (!route) return res.status(404).json({ error: "Route not found" });
    const routeStopIds = normalizeRouteStopIds(route.stops || []);

    const prevAssigned = normalizeAssignedBuses(route.assignedBuses || []);
    if (prevAssigned.length) {
      await Bus.updateMany(
        { id: { $in: prevAssigned }, routeId: route._id },
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
            delayRiskLabel: null,
            delayRiskConfidence: null,
            nextStop: null
          }
        }
      );
      buses.forEach(b => {
        if (prevAssigned.includes(String(b.id)) && String(b.routeId || "") === String(route._id)) {
          b.routeId = null;
          b.route = [];
          b.index = 0;
          b.running = false;
          b.status = "STOPPED";
          b.eta = null;
          b.etaLower = null;
          b.etaUpper = null;
          b.etaConfidencePlusMinus = null;
          b.location = null;
          b.bearing = 0;
          b.dwellRemainingSec = 0;
          b.dwellUntilTs = null;
          b.delayRiskLabel = null;
          b.delayRiskConfidence = null;
          b.prevDistanceToNextStop = null;
          b.distanceToNextStop = null;
          b.nextStop = null;
          b.travelDirection = 1;
          io.emit("busUpdate", b);
        }
      });
    }

    if (routeStopIds.length) {
      const sharedStopIdSet = new Set();
      const otherRoutesUsingStops = await Route.find(
        { _id: { $ne: route._id }, stops: { $in: routeStopIds } },
        { stops: 1 }
      ).lean();
      otherRoutesUsingStops.forEach(otherRoute => {
        (otherRoute?.stops || []).forEach(stopId => {
          const sid = String(stopId || "");
          if (routeStopIds.includes(sid)) sharedStopIdSet.add(sid);
        });
      });

      const removableStopIds = routeStopIds.filter(stopId => !sharedStopIdSet.has(stopId));

      if (removableStopIds.length) {
        await Stop.deleteMany({ _id: { $in: removableStopIds } });
        for (let i = stops.length - 1; i >= 0; i--) {
          const stopId = String(stops[i]?._id || stops[i]?.id || "");
          if (removableStopIds.includes(stopId)) {
            stops.splice(i, 1);
          }
        }
        buses.forEach(bus => {
          if (removableStopIds.includes(String(bus.nextStop || ""))) {
            bus.nextStop = null;
            io.emit("busUpdate", bus);
          }
        });
        updateWeatherLocationFromStops();
        emitStopsUpdate();
      }
    }

    await recordRouteRevision({ routeDoc: route, action: "delete" });
    await Route.deleteOne({ _id: route._id });
    routeStopIdsByRouteId.delete(String(route._id));
    await refreshRouteStopMap();
    return res.json({ status: "route deleted", routeNumber });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Route delete failed" });
  }
});
app.delete("/stops/:id", requireAdmin, async (req, res) => {
  const id = req.params.id;
  await Stop.deleteOne({ _id: id });
  const idx = stops.findIndex(s => String(s._id) === String(id));
  if (idx !== -1) {
    stops.splice(idx, 1);
  }
  await Route.updateMany({}, { $pull: { stops: id } });
  await refreshRouteStopMap();
  buses.forEach(bus => {
    if (String(bus.nextStop || "") === String(id)) {
      bus.nextStop = null;
      io.emit("busUpdate", bus);
    }
  });
  updateWeatherLocationFromStops();
  emitStopsUpdate();
  res.json({ status: "stop removed" });
});
app.get("/api/passenger/stop/:stopId/arrivals", async (req, res) => {
  try {
    const stopId = String(req.params.stopId || "");
    const routeDocs = await Route.find({ stops: stopId }).populate("stops");
    const routeNumberById = new Map(
      routeDocs.map(routeDoc => [String(routeDoc._id), routeDoc.routeNumber || null])
    );
    const routeIdSet = new Set(routeDocs.map(routeDoc => String(routeDoc._id)));
    const liveBuses = buses
      .filter(bus => routeIdSet.has(String(bus.routeId || "")))
      .map(bus => normalizeBusLive(bus, routeNumberById));

    const arrivals = buildStopArrivalsForStop(stopId, routeDocs, liveBuses);
    res.json({
      stop: stopId,
      fastestArrival: arrivals[0] || null,
      arrivals
    });
  } catch (e) {
    console.error("Stop arrivals fetch failed", e);
    res.status(500).json({ error: "Stop arrivals fetch failed", stop: req.params.stopId, arrivals: [] });
  }
});
app.post("/api/admin/ml/train-eta", requireAdmin, async (req, res) => {
  try {
    const {
      days = 30,
      epochs = 400,
      learningRate = 0.003,
      l2 = 0.0001,
      useExternalData = true,
      historicalBackfill = true,
      maxExternalRequests = 120,
      useExternalCalendar = true,
      holidayCountry = process.env.EXTERNAL_HOLIDAY_COUNTRY || "IN"
    } = req.body || {};
    const lookbackDays = Math.max(1, Number(days) || 30);
    const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);

    const logs = await SimulationLog.find({
      timestamp: { $gte: since }
    })
      .sort({ timestamp: 1 })
      .lean();

    if (!logs.length) {
      return res.status(400).json({
        error: "No simulation log data found. Run buses for a few minutes, then train again.",
        stats: {
          logs: 0,
          samples: 0
        }
      });
    }

    let trainingLogs = logs;
    let enrichment = {
      weather: { requestedBuckets: 0, completedRequests: 0, updatedLogs: 0 },
      calendar: { requestedYears: 0, completedRequests: 0, holidaysLoaded: 0, updatedLogs: 0, holidayHits: 0, weekendHits: 0, countryCode: "IN" }
    };

    if (useExternalData && historicalBackfill) {
      const enriched = await enrichLogsWithHistoricalWeather(trainingLogs, {
        maxRequests: maxExternalRequests
      });
      trainingLogs = enriched.logs;
      enrichment.weather = enriched.stats;
    }
    if (useExternalData && useExternalCalendar) {
      const calendarEnriched = await enrichLogsWithCalendarSignals(trainingLogs, {
        countryCode: holidayCountry,
        maxYears: Number(process.env.EXTERNAL_HOLIDAY_MAX_YEARS || 4)
      });
      trainingLogs = calendarEnriched.logs;
      enrichment.calendar = calendarEnriched.stats;
    }

    if (useExternalData && (historicalBackfill || useExternalCalendar)) {
      const ops = trainingLogs
        .filter(
          row =>
            row &&
            row._id &&
            (
              row.externalTrafficImpact != null ||
              row.externalHolidayName != null ||
              row.externalHolidayImpact != null ||
              row.isWeekend != null
            )
        )
        .map(row => ({
          updateOne: {
            filter: { _id: row._id },
            update: {
              $set: {
                externalTempC: row.externalTempC ?? null,
                externalPrecipMm: row.externalPrecipMm ?? null,
                externalWindSpeedKph: row.externalWindSpeedKph ?? null,
                externalWeatherCode: row.externalWeatherCode ?? null,
                externalWeatherSeverity: row.externalWeatherSeverity ?? null,
                externalTrafficImpact: row.externalTrafficImpact ?? 1,
                isWeekend: Number(row.isWeekend) === 1 ? 1 : 0,
                externalHolidayName: row.externalHolidayName ?? null,
                externalHolidayImpact: row.externalHolidayImpact ?? 1
              }
            }
          }
        }));
      if (ops.length) await SimulationLog.bulkWrite(ops, { ordered: false });
    }

    const samples = buildTrainingSamples(trainingLogs);
    const { model: fullModel, metrics } = trainTransitModels(samples, {
      epochs,
      learningRate,
      l2
    });

    if (!fullModel) {
      const logsWithEta = trainingLogs.filter(row => Number.isFinite(Number(row?.eta))).length;
      const logsWithNextStop = trainingLogs.filter(row => row?.nextStopId).length;
      return res.status(400).json({
        error: "Not enough training samples",
        stats: {
          samples: 0,
          logs: trainingLogs.length,
          logsWithEta,
          logsWithNextStop
        }
      });
    }

    saveModel(fullModel);
    etaModel = fullModel;

    return res.json({
      status: "trained",
      model: {
        trainedAt: fullModel.trainedAt,
        samples: fullModel.samples,
        inputGroups: fullModel.inputGroups || {},
        outputNames: fullModel.outputNames || OUTPUT_NAMES,
        etaModel: fullModel.etaModel
          ? {
              featureNames: fullModel.etaModel.featureNames || ETA_FEATURES,
              targetName: fullModel.etaModel.targetName || "predicted_eta_minutes"
            }
          : null,
        delayModel: fullModel.delayModel
          ? {
              featureNames: fullModel.delayModel.featureNames || DELAY_FEATURES,
              targetName: fullModel.delayModel.targetName || "predicted_delay_minutes"
            }
          : null,
        peakModel: fullModel.peakModel
          ? {
              featureNames: fullModel.peakModel.featureNames || PEAK_FEATURES,
              clusterSizes: fullModel.peakModel.clusterSizes || {},
              labels: fullModel.peakModel.clusterLabelMap || {}
            }
          : null
      },
      metrics,
      externalData: {
        enabled: !!useExternalData,
        historicalBackfill: !!historicalBackfill,
        useExternalCalendar: !!useExternalCalendar,
        holidayCountry: holidayCountry,
        enrichment
      }
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "ML training failed" });
  }
});
app.post("/addBus", requireAdmin, async (req, res) => {
  const { id } = req.body;

  if (!buses.find(b => b.id === id)) {
    const created = await Bus.create({
      id,
      route: [],
      index: 0,
      eta: null,
      status: "ON_TIME",
      running: false,
      routeId: null,
      nextStop: null,
      travelDirection: 1
    });
    buses.push(created.toObject());
  }

  const bus = buses.find(b => b.id === id);
  if (bus) io.emit("busUpdate", bus);
  res.json({ status: "bus added", id });
});

app.delete("/bus/:id", requireAdmin, async (req, res) => {
  const id = req.params.id;
  await Bus.deleteOne({ id });
  await Route.updateMany({}, { $pull: { assignedBuses: id } });
  const idx = buses.findIndex(b => b.id === id);
  if (idx !== -1) buses.splice(idx, 1);
  io.emit("busRemoved", { id });
  return res.json({ status: "bus removed", id });
});

app.post("/incident", async (req, res) => {
  const { lat, lng, type, createdByRole } = req.body || {};
  const role = createdByRole === "admin" ? "admin" : "user";

  if (typeof lat !== "number" || typeof lng !== "number" || !type) {
    return res.status(400).json({ error: "type, lat, lng are required" });
  }

  const created = await Incident.create({
    type,
    createdByRole: role,
    lastPromptAt: null,
    location: { lat, lng }
  });
  incidents.push(created.toObject());

  emitIncidentUpdate();
  res.json({ status: "incident added", incident: mapIncidentResponse(created.toObject()) });
});

app.delete("/incident/:id", async (req, res) => {
  const id = req.params.id;
  await Incident.deleteOne({ _id: id });
  const idx = incidents.findIndex(i => String(i._id) === String(id));
  if (idx !== -1) incidents.splice(idx, 1);
  emitIncidentUpdate();
  res.json({ status: "incident removed" });
});

const incidentReminderTimer = setInterval(() => {
  const pending = incidents.slice();
  pending.forEach(incident => {
    maybeEmitIncidentRemovalPrompt(incident).catch(e =>
      console.error("Incident reminder failed", e.message)
    );
  });
}, INCIDENT_CHECK_INTERVAL_MS);
if (typeof incidentReminderTimer.unref === "function") incidentReminderTimer.unref();

async function onSimTickUpdate(bus) {
  try {
    await Bus.updateOne({ id: bus.id }, {
$set: {
  index: bus.index,
  eta: bus.eta,
  etaLower: bus.etaLower ?? null,
  etaUpper: bus.etaUpper ?? null,
  etaConfidencePlusMinus: bus.etaConfidencePlusMinus ?? null,
  status: bus.status,
  delayRiskLabel: bus.delayRiskLabel || null,
  delayRiskConfidence: bus.delayRiskConfidence ?? null,
  predictedDelayMinutes: bus.predictedDelayMinutes ?? null,
  clusterId: bus.clusterId ?? null,
  mappedLabel: bus.mappedLabel || null,
  running: bus.running,
  location: bus.location,
  bearing: bus.bearing,
  dwellRemainingSec: bus.dwellRemainingSec || 0,
  routeId: bus.routeId,
  nextStop: bus.nextStop || null,
  travelDirection: bus.travelDirection === -1 ? -1 : 1
}
    });
  } catch (e) {
    console.error('Persist bus failed', e.message);
  }
}

async function findRouteByNumber(routeNumber, { populateStops = false } = {}) {
  const query = Route.findOne({ routeNumber });
  return populateStops ? query.populate("stops") : query;
}

async function getNormalizedBusesForIds(busIds, routeNumberById) {
  const ids = (Array.isArray(busIds) ? busIds : []).map(id => String(id));
  if (!ids.length) return [];

  const liveById = new Map(
    buses
      .filter(bus => ids.includes(String(bus.id || bus._id || "")))
      .map(bus => [String(bus.id || bus._id), normalizeBusLive(bus, routeNumberById)])
  );

  const missingIds = ids.filter(id => !liveById.has(id));
  if (missingIds.length) {
    const routeBuses = await Bus.find({ id: { $in: missingIds } }).lean();
    routeBuses.forEach(bus => {
      liveById.set(String(bus.id || bus._id), normalizeBusLive(bus, routeNumberById));
    });
  }

  return ids.map(id => liveById.get(id)).filter(Boolean);
}
app.get("/api/passenger/routes", async (req, res) => {
  const routes = await Route.find().populate("stops");
  res.json(routes);
});
app.get("/api/passenger/route/:routeNumber/buses", async (req, res) => {
  const route = await findRouteByNumber(req.params.routeNumber);

  if (!route) {
    return res.status(404).json({ error: "Route not found" });
  }

  const routeNumberById = await getRouteNumberByIdMap(Route);
  const normalizedBuses = await getNormalizedBusesForIds(route.assignedBuses, routeNumberById);
  res.json(normalizedBuses);
});
startSimulation(io, buses, incidents, stops, onSimTickUpdate, {
  getExternalWeather: () => liveWeatherProvider.getSnapshot(),
  getRouteStopIds: bus => {
    const routeId = toObjectIdString(bus.routeId);
    if (!routeId) return [];
    return routeStopIdsByRouteId.get(routeId) || [];
  },
  predictEta: (bus, featureInput = null) => {
    if (!etaModel) return null;
    const routeBusCount = buses.filter(
      candidate => String(candidate?.routeId || "") === String(bus?.routeId || "")
    ).length;
    const outputs = predictTransitOutputs(etaModel, {
      ...(featureInput || {}),
      timestamp: new Date(),
      distanceToNextStop: bus.distanceToNextStop,
      eta: bus.eta,
      incidentsNearby: bus.incidentsNearby || 0,
      accidentNearby: bus.accidentNearby || 0,
      roadWorkNearby: bus.roadWorkNearby || 0,
      trafficJamNearby: bus.trafficJamNearby || 0,
      floodNearby: bus.floodNearby || 0,
      externalWeatherSeverity: bus.externalWeatherSeverity,
      externalPrecipMm: bus.externalPrecipMm,
      bus_density: routeBusCount * 10,
      incident_frequency: bus.incidentsNearby || 0
    });
    if (!outputs) return null;
    bus.predictedDelayMinutes = outputs.predicted_delay_minutes;
    bus.clusterId = outputs.cluster_id;
    bus.mappedLabel = outputs.mapped_label;
    bus.mlInputs = outputs.features;
    return outputs.predicted_eta_minutes;
  },
  predictEtaRange: (bus, featureInput = null, etaMinutes = null) => {
    if (!etaModel) return null;
    const etaValue = Number.isFinite(Number(etaMinutes)) ? Number(etaMinutes) : Number(bus.eta);
    return predictEtaRange(
      etaModel,
      {
        ...(featureInput || {}),
        ...(bus.mlInputs || {}),
        incidentsNearby: bus.incidentsNearby || 0,
        active_incidents_count: bus.incidentsNearby || 0,
        mapped_label: bus.mappedLabel || "non-peak",
        peak_hour_flag: bus.mappedLabel === "peak" ? 1 : 0,
        weather_flag: (Number(bus.externalWeatherSeverity || 0) > 0 || Number(bus.externalPrecipMm || 0) > 0.1) ? 1 : 0
      },
      etaValue,
      bus.predictedDelayMinutes
    );
  }
});
app.get("/api/passenger/route/:routeNumber/timeline", async (req, res) => {
  try {
    const route = await findRouteByNumber(req.params.routeNumber, { populateStops: true });

    if (!route)
      return res.status(404).json({ error: "Route not found" });

    const routeNumberById = await getRouteNumberByIdMap(Route);
    const normalizedBuses = await getNormalizedBusesForIds(route.assignedBuses, routeNumberById);

    res.json({
      route: {
        number: route.routeNumber,
        name: route.routeName,
        stops: route.stops
      },
      buses: normalizedBuses,
      stopTimeline: buildStopTimeline(route.stops, normalizedBuses)
    });

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Timeline fetch failed" });
  }
});

app.get("/api/passenger/route/:routeNumber/dashboard", async (req, res) => {
  try {
    const route = await findRouteByNumber(req.params.routeNumber, { populateStops: true });

    if (!route) {
      return res.status(404).json({ error: "Route not found" });
    }

    const routeNumberById = await getRouteNumberByIdMap(Route);
    const liveBuses = buses
      .filter(b => String(b.routeId || "") === String(route._id))
      .map(b => normalizeBusLive(b, routeNumberById));

    return res.json({
      route: {
        id: String(route._id),
        routeNumber: route.routeNumber,
        routeName: route.routeName || null,
        polyline: route.polyline || [],
        stops: route.stops.map(s => ({
          id: String(s._id),
          name: s.name || null,
          location: s.location
        }))
      },
      buses: liveBuses,
      stopTimeline: buildStopTimeline(route.stops, liveBuses),
      incidents: incidents.map(i => ({
        id: String(i._id || i.id),
        type: i.type,
        location: i.location
      }))
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Dashboard fetch failed" });
  }
});

server.listen(5000, () => {
  console.log("Backend running on port 5000");
});
