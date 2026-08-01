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
  isWeekend: { type: Number, default: 0 },
  externalHolidayName: { type: String, default: null },
  externalHolidayImpact: { type: Number, default: 1 },
  closestIncidentType: { type: String, default: null },
  closestIncidentDistanceKm: { type: Number, default: null },
  accidentNearby: { type: Number, default: 0 },
  roadWorkNearby: { type: Number, default: 0 },
  trafficJamNearby: { type: Number, default: 0 },
  floodNearby: { type: Number, default: 0 },
  actualETAT: { type: Date, default: null },
  eta: Number,
  etaLower: { type: Number, default: null },
  etaUpper: { type: Number, default: null },
  etaConfidencePlusMinus: { type: Number, default: null },
  delayRiskLabel: { type: String, default: null },
  delayRiskConfidence: { type: Number, default: null },
  predictedDelayMinutes: { type: Number, default: null },
  clusterId: { type: Number, default: null },
  mappedLabel: { type: String, default: null },
  status: String,
  // Keep backward compatibility with previous shape.
  location: { lat: Number, lng: Number }
});

module.exports = mongoose.model("SimulationLog", LogSchema);
