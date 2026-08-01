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
  extractFeatures,
  predictEtaMinutes,
  buildTrainingSamples,
  trainLinearRegression,
  saveModel,
  loadModel
} = require("./ml/etaModel");
const {
  createLiveWeatherProvider,
  enrichLogsWithHistoricalWeather
} = require("./ml/externalData");
const {
  toObjectIdString,
  getRouteNumberByIdMap,
  normalizeBusLive,
  buildStopTimeline
} = require("./services/passengerUtils");
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

const app = express();
app.use(cors());
app.use(express.json());

/* ---------- AUTH HELPERS ---------- */
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

app.get("/api/passenger/ml/status", (req, res) => {
  const weather = liveWeatherProvider.getSnapshot();
  if (!etaModel) {
    return res.json({
      enabled: false,
      trainedAt: null,
      samples: 0,
      externalWeather: weather
    });
  }
  return res.json({
    enabled: true,
    trainedAt: etaModel.trainedAt,
    samples: etaModel.samples || 0,
    featureNames: etaModel.featureNames || [],
    externalWeather: weather
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

/* ---------- IN-MEMORY STATE ---------- */
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
          .map(b => String(b.routeId || ""))
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
    buses.forEach(b => {
      if (toAdd.includes(String(b.id))) b.routeId = routeDoc._id;
    });
  }

  if (toRemove.length) {
    await Bus.updateMany(
      { id: { $in: toRemove }, routeId: routeDoc._id },
      { $set: { routeId: null } }
    );
    buses.forEach(b => {
      if (toRemove.includes(String(b.id)) && String(b.routeId || "") === String(routeDoc._id)) {
        b.routeId = null;
      }
    });
  }

  routeDoc.assignedBuses = [...next];
  await routeDoc.save();
}

async function activateRouteForBuses(routeDoc, busIds) {
  const targetBusIds = normalizeAssignedBuses(busIds);
  const routePolyline = normalizePolylineInput(routeDoc?.polyline || []);
  if (!targetBusIds.length || routePolyline.length < 2) {
    return { startedBusIds: [] };
  }

  const firstPoint = routePolyline[0];
  const update = {
    routeId: routeDoc._id,
    route: routePolyline,
    index: 0,
    running: true,
    status: "ON_TIME",
    eta: null,
    location: firstPoint,
    bearing: 0,
    dwellRemainingSec: 0,
    nextStop: routeDoc.stops?.[0] || null
  };

  await Bus.updateMany(
    { id: { $in: targetBusIds } },
    { $set: update }
  );

  const idSet = new Set(targetBusIds);
  buses.forEach(bus => {
    if (!idSet.has(String(bus.id))) return;
    Object.assign(bus, {
      routeId: routeDoc._id,
      route: routePolyline,
      index: 0,
      running: true,
      status: "ON_TIME",
      eta: null,
      location: firstPoint,
      bearing: 0,
      dwellRemainingSec: 0,
      dwellUntilTs: null,
      nextStop: routeDoc.stops?.[0] || null,
      travelDirection: 1
    });
    io.emit("busUpdate", bus);
  });

  return { startedBusIds: targetBusIds };
}

function createRouteSnapshot(routeDoc) {
  return {
    routeNumber: String(routeDoc.routeNumber || "").trim(),
    routeName: routeDoc.routeName || null,
    startPointName: routeDoc.startPointName || null,
    endPointName: routeDoc.endPointName || null,
    stops: (routeDoc.stops || []).map(s => String(s)),
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
  } catch (e) {
    console.error("Route revision record failed", e.message);
  }
}

/* ---------- DB CONNECTION ---------- */
const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/bus_tracking";
mongoose.connect(MONGO_URI).then(() => console.log("MongoDB connected")).catch(err => console.error("MongoDB error", err));

/* ---------- LOAD INITIAL STATE FROM DB ---------- */
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
    status: b.status || "ON_TIME",
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
  io.emit("stopsUpdate", stops.map(s => ({ ...s, id: String(s._id || s.id) })));
}

loadFromDB().catch(console.error);

/* ---------- AUTOCOMPLETE ---------- */
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
/* ---------- GET BUS LIST ---------- */
app.get("/buses", async (req, res) => {
  const dbBuses = await Bus.find().lean();
  res.json(dbBuses.map(b => ({
    ...b,
    id: String(b.id || b._id)
  })));
});

/* ---------- STOPS (BUS STOPS) ---------- */
app.get("/stops", (req, res) => {
  res.json(stops.map(s => ({ ...s, id: String(s._id || s.id) })));
});
/* ---------- GET INCIDENTS ---------- */
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
  io.emit("stopsUpdate", stops.map(s => ({ ...s, id: String(s._id || s.id) })));
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

    io.emit("stopsUpdate", stops.map(s => ({ ...s, id: String(s._id || s.id) })));
    return res.json({ status: "stop updated", stop: { ...updated, id: String(updated._id) } });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Stop update failed" });
  }
});
/* ---------- CREATE ROUTE (ADMIN) ---------- */
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
      await syncRouteBusAssignments(route, normalizedAssignedBuses);
      const activation = await activateRouteForBuses(route, normalizedAssignedBuses);
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
      route.stops = updatedStops;
      setRouteStopMapForRoute(route);
      changedFields.push("stops");
    }

    if (polyline !== undefined) {
      route.polyline = normalizePolylineInput(polyline);
      changedFields.push("polyline");
    }

    if (assignedBuses !== undefined) {
      const { normalized, missingBusIds } = await normalizeAndValidateAssignedBuses(assignedBuses);
      if (missingBusIds.length) {
        return res.status(400).json({
          error: "One or more bus ids are invalid",
          missingBusIds
        });
      }
      await syncRouteBusAssignments(route, normalized);
      changedFields.push("assignedBuses");
    } else {
      await route.save();
    }

    const activeAssignedBuses = normalizeAssignedBuses(route.assignedBuses || []);
    const activation = await activateRouteForBuses(route, activeAssignedBuses);
    if (activation.startedBusIds.length) changedFields.push("simulationStart");

    await recordRouteRevision({
      routeDoc: route,
      action: "update",
      metadata: { previousRouteNumber, changedFields }
    });

    const refreshed = await Route.findById(route._id).populate("stops").lean();
    return res.json({ status: "route updated", route: refreshed });
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
            location: null,
            bearing: 0,
            dwellRemainingSec: 0,
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
          b.location = null;
          b.bearing = 0;
          b.dwellRemainingSec = 0;
          b.dwellUntilTs = null;
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
        io.emit("stopsUpdate", stops.map(s => ({ ...s, id: String(s._id || s.id) })));
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
  io.emit("stopsUpdate", stops.map(s => ({ ...s, id: String(s._id || s.id) })));
  res.json({ status: "stop removed" });
});
/* ---------- STOP ARRIVAL BOARD (PASSENGER) ---------- */
app.get("/api/passenger/stop/:stopId/arrivals", (req, res) => {
  const stopId = req.params.stopId;

  const arrivals = buses
  .filter(b => b.eta != null && String(b.nextStop || "") === String(stopId))
  .map(b => ({
    busId: b.id,
    eta: b.eta,
    status: b.status,
    direction: Number(b.travelDirection) === -1 ? "DOWN" : "UP",
    travelDirection: Number(b.travelDirection) === -1 ? -1 : 1,
    routeId: toObjectIdString(b.routeId),
    routeNumber: null,
    nextStop: b.nextStop || null
  }))
  .sort((a, b) => a.eta - b.eta);

  return getRouteNumberByIdMap(Route)
    .then(routeNumberById => {
      arrivals.forEach(a => {
        if (a.routeId) a.routeNumber = routeNumberById.get(a.routeId) || null;
      });
      res.json({ stop: stopId, arrivals });
    })
    .catch(() => res.json({ stop: stopId, arrivals }));
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
      maxExternalRequests = 120
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
    let enrichment = { requestedBuckets: 0, completedRequests: 0, updatedLogs: 0 };

    if (useExternalData && historicalBackfill) {
      const enriched = await enrichLogsWithHistoricalWeather(trainingLogs, {
        maxRequests: maxExternalRequests
      });
      trainingLogs = enriched.logs;
      enrichment = enriched.stats;

      const ops = trainingLogs
        .filter(row => row && row._id && row.externalTrafficImpact != null)
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
                externalTrafficImpact: row.externalTrafficImpact ?? 1
              }
            }
          }
        }));

      if (ops.length) {
        await SimulationLog.bulkWrite(ops, { ordered: false });
      }
    }

    const samples = buildTrainingSamples(trainingLogs);
    const { model, stats } = trainLinearRegression(samples, {
      epochs,
      learningRate,
      l2
    });

    if (!model) {
      const logsWithEta = trainingLogs.filter(row => Number.isFinite(Number(row?.eta))).length;
      const logsWithNextStop = trainingLogs.filter(row => row?.nextStopId).length;
      return res.status(400).json({
        error: "Not enough training samples",
        stats: {
          ...stats,
          logs: trainingLogs.length,
          logsWithEta,
          logsWithNextStop
        }
      });
    }

    saveModel(model);
    etaModel = model;

    return res.json({
      status: "trained",
      model: {
        trainedAt: model.trainedAt,
        samples: model.samples,
        featureNames: model.featureNames
      },
      metrics: stats,
      externalData: {
        enabled: !!useExternalData,
        historicalBackfill: !!historicalBackfill,
        enrichment
      }
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "ML training failed" });
  }
});
/* ---------- ADD BUS ---------- */
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

/* ---------- REMOVE BUS ---------- */
app.delete("/bus/:id", requireAdmin, async (req, res) => {
  const id = req.params.id;
  await Bus.deleteOne({ id });
  await Route.updateMany({}, { $pull: { assignedBuses: id } });
  const idx = buses.findIndex(b => b.id === id);
  if (idx !== -1) buses.splice(idx, 1);
  io.emit("busRemoved", { id });
  return res.json({ status: "bus removed", id });
});

/* ---------- ADD INCIDENT ---------- */
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

/* ---------- REMOVE INCIDENT ---------- */
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

/* ---------- START SIMULATION ---------- */
// Persist dynamic bus fields on each tick
async function onSimTickUpdate(bus) {
  try {
    await Bus.updateOne({ id: bus.id }, {
$set: {
  index: bus.index,
  eta: bus.eta,
  status: bus.status,
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
/* ---------- GET ALL ROUTES (PASSENGER) ---------- */
app.get("/api/passenger/routes", async (req, res) => {
  const routes = await Route.find().populate("stops");
  res.json(routes);
});
/* ---------- PASSENGER ROUTE BUS VIEW ---------- */
app.get("/api/passenger/route/:routeNumber/buses", async (req, res) => {
  const route = await Route.findOne({ routeNumber: req.params.routeNumber });

  if (!route) {
    return res.status(404).json({ error: "Route not found" });
  }

  const routeNumberById = await getRouteNumberByIdMap(Route);
  const routeBuses = await Bus.find({ id: { $in: route.assignedBuses } }).lean();
  res.json(routeBuses.map(b => normalizeBusLive(b, routeNumberById)));
});
startSimulation(io, buses, incidents, stops, onSimTickUpdate, {
  getExternalWeather: () => liveWeatherProvider.getSnapshot(),
  getRouteStopIds: bus => {
    const routeId = toObjectIdString(bus.routeId);
    if (!routeId) return [];
    return routeStopIdsByRouteId.get(routeId) || [];
  },
  predictEta: (bus) => {
    if (!etaModel) return null;
    const features = extractFeatures({
      timestamp: new Date(),
      distanceToNextStop: bus.distanceToNextStop,
      dwellTime: bus.dwellRemainingSec || 0,
      incidentsNearby: bus.incidentsNearby || 0,
      trafficFactor: bus.trafficFactor || 1,
      externalTempC: bus.externalTempC,
      externalPrecipMm: bus.externalPrecipMm,
      externalWindSpeedKph: bus.externalWindSpeedKph,
      externalWeatherSeverity: bus.externalWeatherSeverity,
      externalTrafficImpact: bus.externalTrafficImpact || 1
    });
    return predictEtaMinutes(etaModel, features);
  }
});
app.get("/api/passenger/route/:routeNumber/timeline", async (req, res) => {
  try {
    const route = await Route.findOne({
      routeNumber: req.params.routeNumber
    }).populate("stops");

    if (!route)
      return res.status(404).json({ error: "Route not found" });

    const routeNumberById = await getRouteNumberByIdMap(Route);
    const routeBuses = await Bus.find({
      id: { $in: route.assignedBuses }
    }).lean();
    const normalizedBuses = routeBuses.map(b => normalizeBusLive(b, routeNumberById));

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
    const route = await Route.findOne({
      routeNumber: req.params.routeNumber
    }).populate("stops");

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
