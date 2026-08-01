const mongoose = require("mongoose");

const LogSchema = new mongoose.Schema({
  busId: { type: String, index: true },
  routeId: { type: mongoose.Schema.Types.ObjectId, ref: "Route", default: null },
  timestamp: { type: Date, index: true },
  currentLat: Number,
  currentLng: Number,
  nextStopId: { type: mongoose.Schema.Types.ObjectId, ref: "Stop", default: null },
  distanceToNextStop: Number,
  dwellTime: Number,
  incidentsNearby: Number,
  trafficFactor: Number,
  externalTempC: Number,
  externalPrecipMm: Number,
  externalWindSpeedKph: Number,
  externalWeatherCode: Number,
  externalWeatherSeverity: Number,
  externalTrafficImpact: Number,
  actualETAT: { type: Date, default: null },
  eta: Number,
  status: String,
  // Keep backward compatibility with previous shape.
  location: { lat: Number, lng: Number }
});

module.exports = mongoose.model("SimulationLog", LogSchema);
