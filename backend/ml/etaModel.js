const fs = require("fs");
const path = require("path");

const MODEL_PATH = path.join(__dirname, "eta-model.json");

const ETA_FEATURES = [
  "distance_remaining_km",
  "current_speed_kmph",
  "time_of_day",
  "day_of_week",
  "historical_avg_delay_min",
  "active_incidents_count",
  "peak_hour_flag"
];

const DELAY_FEATURES = [
  "time_of_day",
  "day_of_week",
  "historical_delay_mean",
  "historical_delay_std",
  "incident_severity_score",
  "weather_flag"
];

const PEAK_FEATURES = [
  "hour_of_day",
  "average_delay_minutes",
  "bus_density",
  "incident_frequency"
];

const ALL_INPUTS = [
  "distance_remaining_km",
  "current_speed_kmph",
  "time_of_day",
  "day_of_week",
  "historical_avg_delay_min",
  "active_incidents_count",
  "peak_hour_flag",
  "historical_delay_mean",
  "historical_delay_std",
  "incident_severity_score",
  "weather_flag",
  "hour_of_day",
  "average_delay_minutes",
  "bus_density",
  "incident_frequency"
];

const OUTPUT_NAMES = [
  "predicted_eta_minutes",
  "predicted_delay_minutes",
  "cluster_id",
  "mapped_label"
];

function toNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function average(values, fallback = 0) {
  const list = (values || []).filter(v => Number.isFinite(v));
  if (!list.length) return fallback;
  return list.reduce((sum, value) => sum + value, 0) / list.length;
}

function stddev(values, fallback = 0) {
  const list = (values || []).filter(v => Number.isFinite(v));
  if (list.length < 2) return fallback;
  const mean = average(list, 0);
  const variance = average(list.map(v => (v - mean) ** 2), 0);
  return Math.sqrt(variance);
}

function bucketTs(timestamp, minutes = 15) {
  const ts = new Date(timestamp || Date.now()).getTime();
  if (!Number.isFinite(ts)) return "unknown";
  const bucketMs = minutes * 60 * 1000;
  return String(Math.floor(ts / bucketMs) * bucketMs);
}

function estimateSpeedKmph(row) {
  const distanceKm = Math.max(0, toNumber(row?.distanceToNextStop, 0));
  const etaMin = Math.max(0, toNumber(row?.eta, 0));
  if (distanceKm > 0.01 && etaMin > 0.2) {
    return clamp((distanceKm / etaMin) * 60, 5, 70);
  }
  const trafficFactor = Math.max(0.7, toNumber(row?.trafficFactor, 1));
  return clamp(30 / trafficFactor, 5, 45);
}

function estimateDelayTargetMinutes(row, speedKmph) {
  const etaMin = Math.max(0, toNumber(row?.eta, 0));
  const distanceKm = Math.max(0, toNumber(row?.distanceToNextStop, 0));
  const baseTravelMin = speedKmph > 0 ? (distanceKm / speedKmph) * 60 : 0;
  return clamp(etaMin - baseTravelMin, 0, 180);
}

function estimateIncidentSeverity(row) {
  return clamp(
    toNumber(row?.accidentNearby, 0) * 4 +
      toNumber(row?.roadWorkNearby, 0) * 2 +
      toNumber(row?.trafficJamNearby, 0) * 3 +
      toNumber(row?.floodNearby, 0) * 5 +
      toNumber(row?.incidentsNearby, 0) * 0.5,
    0,
    10
  );
}

function weatherFlag(row) {
  const severity = toNumber(row?.externalWeatherSeverity, 0);
  const precip = toNumber(row?.externalPrecipMm, 0);
  return severity > 0 || precip > 0.1 ? 1 : 0;
}

function buildDerivedRows(logs) {
  const rows = Array.isArray(logs) ? [...logs] : [];
  rows.sort((a, b) => new Date(a?.timestamp || 0) - new Date(b?.timestamp || 0));

  const routeBucketBusSet = new Map();
  const routeBucketIncidentValues = new Map();

  rows.forEach(row => {
    const routeKey = String(row?.routeId || "unassigned");
    const bucketKey = bucketTs(row?.timestamp);
    const composite = `${routeKey}|${bucketKey}`;
    if (!routeBucketBusSet.has(composite)) routeBucketBusSet.set(composite, new Set());
    routeBucketBusSet.get(composite).add(String(row?.busId || "UNKNOWN"));
    if (!routeBucketIncidentValues.has(composite)) routeBucketIncidentValues.set(composite, []);
    routeBucketIncidentValues.get(composite).push(Math.max(0, toNumber(row?.incidentsNearby, 0)));
  });

  const historyByBus = new Map();
  const derived = [];

  rows.forEach(row => {
    const ts = new Date(row?.timestamp || Date.now());
    const hour = ts.getHours();
    const day = ts.getDay();
    const routeKey = String(row?.routeId || "unassigned");
    const bucketKey = bucketTs(row?.timestamp);
    const composite = `${routeKey}|${bucketKey}`;
    const busId = String(row?.busId || "UNKNOWN");
    const prevDelays = historyByBus.get(busId) || [];
    const speedKmph = estimateSpeedKmph(row);
    const delayTarget = estimateDelayTargetMinutes(row, speedKmph);
    const etaTarget = Number.isFinite(Number(row?.eta))
      ? clamp(Number(row.eta), 0, 300)
      : clamp(delayTarget + Math.max(1, (toNumber(row?.distanceToNextStop, 0) / Math.max(1, speedKmph)) * 60), 0, 300);
    const incidentSeverity = estimateIncidentSeverity(row);
    const busDensity = (routeBucketBusSet.get(composite)?.size || 1) * 10;
    const incidentFrequency = average(routeBucketIncidentValues.get(composite) || [], 0);
    const avgDelay = average(prevDelays, delayTarget);
    const delayStd = stddev(prevDelays, Math.max(1, avgDelay * 0.15));

    derived.push({
      distance_remaining_km: clamp(toNumber(row?.distanceToNextStop, 0), 0, 200),
      current_speed_kmph: clamp(speedKmph, 0, 120),
      time_of_day: hour,
      day_of_week: day,
      historical_avg_delay_min: clamp(avgDelay, 0, 180),
      active_incidents_count: clamp(toNumber(row?.incidentsNearby, 0), 0, 20),
      peak_hour_flag: 0,
      historical_delay_mean: clamp(avgDelay, 0, 180),
      historical_delay_std: clamp(delayStd, 0, 120),
      incident_severity_score: incidentSeverity,
      weather_flag: weatherFlag(row),
      hour_of_day: hour,
      average_delay_minutes: clamp(delayTarget, 0, 180),
      bus_density: clamp(busDensity, 0, 500),
      incident_frequency: clamp(incidentFrequency, 0, 100),
      predicted_eta_minutes: etaTarget,
      predicted_delay_minutes: clamp(delayTarget, 0, 180)
    });

    historyByBus.set(busId, [...prevDelays.slice(-59), delayTarget]);
  });

  return derived;
}

function featureVector(row, featureNames) {
  return featureNames.map(name => toNumber(row?.[name], 0));
}

function computeFeatureMeans(rows) {
  const means = {};
  ALL_INPUTS.forEach(name => {
    means[name] = average(rows.map(row => toNumber(row?.[name], 0)), 0);
  });
  return means;
}

function computeMetrics(model, rows, featureNames, targetName) {
  if (!rows.length) return { samples: 0, mae: null, rmse: null };
  let se = 0;
  let ae = 0;
  rows.forEach(row => {
    const predicted = predictLinear(model, row, featureNames);
    const actual = toNumber(row?.[targetName], 0);
    const err = predicted - actual;
    se += err * err;
    ae += Math.abs(err);
  });
  return {
    samples: rows.length,
    mae: ae / rows.length,
    rmse: Math.sqrt(se / rows.length)
  };
}

function trainLinear(rows, featureNames, targetName, opts = {}) {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  if (!list.length) return { model: null, metrics: { samples: 0, mae: null, rmse: null } };

  const learningRate = toNumber(opts.learningRate, 0.003);
  const epochs = Math.max(50, Math.floor(toNumber(opts.epochs, 450)));
  const l2 = Math.max(0, toNumber(opts.l2, 0.0001));
  let bias = 0;
  const weights = Array(featureNames.length).fill(0);
  const n = list.length;

  for (let epoch = 0; epoch < epochs; epoch += 1) {
    let gBias = 0;
    const gWeights = Array(featureNames.length).fill(0);

    list.forEach(row => {
      const x = featureVector(row, featureNames);
      const y = toNumber(row?.[targetName], 0);
      const pred = bias + x.reduce((sum, value, index) => sum + value * weights[index], 0);
      const err = pred - y;
      gBias += err;
      for (let index = 0; index < weights.length; index += 1) {
        gWeights[index] += err * x[index];
      }
    });

    bias -= (learningRate * gBias) / n;
    for (let index = 0; index < weights.length; index += 1) {
      weights[index] -= learningRate * ((gWeights[index] / n) + l2 * weights[index]);
    }
  }

  const model = {
    bias,
    weights,
    featureNames,
    targetName
  };
  return {
    model,
    metrics: computeMetrics(model, list, featureNames, targetName)
  };
}

function predictLinear(model, row, featureNames = model?.featureNames || []) {
  if (!model || !Array.isArray(model.weights) || model.weights.length !== featureNames.length) {
    return null;
  }
  const x = featureVector(row, featureNames);
  return toNumber(model.bias, 0) + x.reduce((sum, value, index) => sum + value * model.weights[index], 0);
}

function squaredDistance(a, b) {
  let sum = 0;
  for (let index = 0; index < a.length; index += 1) {
    const diff = toNumber(a[index], 0) - toNumber(b[index], 0);
    sum += diff * diff;
  }
  return sum;
}

function trainPeakModel(rows) {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  if (list.length < 2) {
    return {
      model: {
        featureNames: PEAK_FEATURES,
        centroids: [[0, 0, 0, 0], [1, 1, 1, 1]],
        clusterLabelMap: { 0: "non-peak", 1: "peak" },
        clusterSizes: { 0: list.length, 1: 0 }
      },
      metrics: { samples: list.length, clusterSizes: { 0: list.length, 1: 0 } }
    };
  }

  const vectors = list.map(row => featureVector(row, PEAK_FEATURES));
  let centroids = [vectors[0].slice(), vectors[vectors.length - 1].slice()];
  let assignments = Array(vectors.length).fill(0);

  for (let iter = 0; iter < 20; iter += 1) {
    assignments = vectors.map(vec =>
      squaredDistance(vec, centroids[0]) <= squaredDistance(vec, centroids[1]) ? 0 : 1
    );
    const nextCentroids = [0, 1].map(clusterId => {
      const clusterRows = vectors.filter((_, index) => assignments[index] === clusterId);
      if (!clusterRows.length) return centroids[clusterId].slice();
      return PEAK_FEATURES.map((_, featureIndex) =>
        average(clusterRows.map(row => row[featureIndex]), 0)
      );
    });
    const movement = nextCentroids.reduce(
      (sum, centroid, index) => sum + squaredDistance(centroid, centroids[index]),
      0
    );
    centroids = nextCentroids;
    if (movement < 1e-6) break;
  }

  const peakClusterId =
    toNumber(centroids[0][1], 0) >= toNumber(centroids[1][1], 0) ? 0 : 1;
  const clusterLabelMap = {
    0: peakClusterId === 0 ? "peak" : "non-peak",
    1: peakClusterId === 1 ? "peak" : "non-peak"
  };
  const clusterSizes = assignments.reduce((acc, clusterId) => {
    acc[clusterId] = (acc[clusterId] || 0) + 1;
    return acc;
  }, { 0: 0, 1: 0 });

  return {
    model: {
      featureNames: PEAK_FEATURES,
      centroids,
      clusterLabelMap,
      clusterSizes
    },
    metrics: {
      samples: list.length,
      clusterSizes
    }
  };
}

function predictPeak(model, row) {
  if (!model?.centroids || !Array.isArray(model.centroids) || model.centroids.length < 2) {
    return { cluster_id: 0, mapped_label: "non-peak" };
  }
  const vec = featureVector(row, PEAK_FEATURES);
  const cluster_id =
    squaredDistance(vec, model.centroids[0]) <= squaredDistance(vec, model.centroids[1]) ? 0 : 1;
  return {
    cluster_id,
    mapped_label: model.clusterLabelMap?.[cluster_id] || "non-peak"
  };
}

function buildTrainingSamples(logs) {
  return buildDerivedRows(logs);
}

function trainTransitModels(samples, opts = {}) {
  const rows = Array.isArray(samples) ? samples.filter(Boolean) : [];
  if (!rows.length) {
    return {
      model: null,
      metrics: {
        eta: { samples: 0, mae: null, rmse: null },
        delay: { samples: 0, mae: null, rmse: null },
        peak: { samples: 0, clusterSizes: {} }
      }
    };
  }

  const { model: peakModel, metrics: peakMetrics } = trainPeakModel(rows);
  const rowsWithPeak = rows.map(row => {
    const peakPrediction = predictPeak(peakModel, row);
    return {
      ...row,
      peak_hour_flag: peakPrediction.mapped_label === "peak" ? 1 : 0,
      cluster_id: peakPrediction.cluster_id,
      mapped_label: peakPrediction.mapped_label
    };
  });

  const { model: delayModel, metrics: delayMetrics } = trainLinear(
    rowsWithPeak,
    DELAY_FEATURES,
    "predicted_delay_minutes",
    opts
  );
  const { model: etaModel, metrics: etaMetrics } = trainLinear(
    rowsWithPeak,
    ETA_FEATURES,
    "predicted_eta_minutes",
    opts
  );

  const featureMeans = computeFeatureMeans(rowsWithPeak);
  const model = {
    version: 3,
    trainedAt: new Date().toISOString(),
    samples: rowsWithPeak.length,
    inputGroups: {
      eta: ETA_FEATURES,
      delay: DELAY_FEATURES,
      peak: PEAK_FEATURES,
      all: ALL_INPUTS
    },
    outputNames: OUTPUT_NAMES,
    featureMeans,
    etaModel,
    delayModel,
    peakModel
  };

  return {
    model,
    metrics: {
      eta: etaMetrics,
      delay: delayMetrics,
      peak: peakMetrics
    }
  };
}

function buildRuntimeInputs(raw = {}, model = null) {
  const means = model?.featureMeans || {};
  const ts = new Date(raw?.timestamp || Date.now());
  const hour = ts.getHours();
  const day = ts.getDay();
  const distanceRemaining = clamp(
    toNumber(raw?.distance_remaining_km, raw?.distanceToNextStop ?? means.distance_remaining_km ?? 0),
    0,
    200
  );
  const currentSpeed = clamp(
    toNumber(raw?.current_speed_kmph, estimateSpeedKmph(raw)),
    0,
    120
  );
  const activeIncidents = clamp(
    toNumber(raw?.active_incidents_count, raw?.incidentsNearby ?? means.active_incidents_count ?? 0),
    0,
    20
  );
  const severity = clamp(
    toNumber(raw?.incident_severity_score, estimateIncidentSeverity(raw)),
    0,
    10
  );
  const weather = clamp(
    toNumber(raw?.weather_flag, weatherFlag(raw)),
    0,
    1
  );
  const averageDelay = clamp(
    toNumber(raw?.average_delay_minutes, raw?.eta != null ? estimateDelayTargetMinutes(raw, currentSpeed) : means.average_delay_minutes ?? 0),
    0,
    180
  );
  const runtime = {
    distance_remaining_km: distanceRemaining,
    current_speed_kmph: currentSpeed,
    time_of_day: clamp(toNumber(raw?.time_of_day, hour), 0, 23),
    day_of_week: clamp(toNumber(raw?.day_of_week, day), 0, 6),
    historical_avg_delay_min: clamp(toNumber(raw?.historical_avg_delay_min, means.historical_avg_delay_min ?? averageDelay), 0, 180),
    active_incidents_count: activeIncidents,
    peak_hour_flag: clamp(toNumber(raw?.peak_hour_flag, means.peak_hour_flag ?? 0), 0, 1),
    historical_delay_mean: clamp(toNumber(raw?.historical_delay_mean, means.historical_delay_mean ?? averageDelay), 0, 180),
    historical_delay_std: clamp(toNumber(raw?.historical_delay_std, means.historical_delay_std ?? Math.max(1, averageDelay * 0.15)), 0, 120),
    incident_severity_score: severity,
    weather_flag: weather,
    hour_of_day: clamp(toNumber(raw?.hour_of_day, hour), 0, 23),
    average_delay_minutes: averageDelay,
    bus_density: clamp(toNumber(raw?.bus_density, means.bus_density ?? 10), 0, 500),
    incident_frequency: clamp(toNumber(raw?.incident_frequency, activeIncidents), 0, 100)
  };

  const peakPrediction = model?.peakModel ? predictPeak(model.peakModel, runtime) : { cluster_id: 0, mapped_label: "non-peak" };
  runtime.peak_hour_flag = peakPrediction.mapped_label === "peak" ? 1 : runtime.peak_hour_flag;
  return { ...runtime, ...peakPrediction };
}

function predictTransitOutputs(model, rawFeatures) {
  if (!model?.etaModel || !model?.delayModel || !model?.peakModel) return null;
  const runtime = buildRuntimeInputs(rawFeatures, model);
  const predicted_delay_minutes = clamp(
    predictLinear(model.delayModel, runtime, DELAY_FEATURES),
    0,
    180
  );
  const etaRuntime = {
    ...runtime,
    historical_avg_delay_min: clamp(
      toNumber(runtime.historical_avg_delay_min, 0),
      0,
      180
    )
  };
  const predicted_eta_minutes = clamp(
    predictLinear(model.etaModel, etaRuntime, ETA_FEATURES),
    0,
    300
  );
  return {
    predicted_eta_minutes,
    predicted_delay_minutes,
    cluster_id: runtime.cluster_id,
    mapped_label: runtime.mapped_label,
    features: runtime
  };
}

function predictEtaRange(model, rawFeatures, etaMinutes = null, predictedDelayMinutes = null) {
  const eta = clamp(
    toNumber(etaMinutes, toNumber(rawFeatures?.predicted_eta_minutes, 0)),
    0,
    300
  );
  const predictedDelay = clamp(
    toNumber(predictedDelayMinutes, toNumber(rawFeatures?.predicted_delay_minutes, 0)),
    0,
    180
  );
  const incidents = clamp(toNumber(rawFeatures?.active_incidents_count ?? rawFeatures?.incidentsNearby, 0), 0, 20);
  const weather = clamp(toNumber(rawFeatures?.weather_flag, weatherFlag(rawFeatures)), 0, 1);
  const peak = String(rawFeatures?.mapped_label || "").toLowerCase() === "peak" || toNumber(rawFeatures?.peak_hour_flag, 0) === 1;
  const plusMinus = clamp(1 + predictedDelay * 0.12 + incidents * 0.35 + weather * 1.2 + (peak ? 1 : 0), 1, 12);
  return {
    lower: Math.max(0, eta - plusMinus),
    upper: eta + plusMinus,
    plusMinus
  };
}

function saveModel(model) {
  fs.writeFileSync(MODEL_PATH, JSON.stringify(model, null, 2), "utf-8");
}

function loadModel() {
  if (!fs.existsSync(MODEL_PATH)) return null;
  try {
    const raw = fs.readFileSync(MODEL_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.etaModel || !parsed.delayModel || !parsed.peakModel) return null;
    return parsed;
  } catch {
    return null;
  }
}

module.exports = {
  MODEL_PATH,
  ETA_FEATURES,
  DELAY_FEATURES,
  PEAK_FEATURES,
  ALL_INPUTS,
  OUTPUT_NAMES,
  buildTrainingSamples,
  trainTransitModels,
  predictTransitOutputs,
  predictEtaRange,
  saveModel,
  loadModel
};
