const fs = require("fs");
const path = require("path");

const MODEL_PATH = path.join(__dirname, "eta-model.json");
const FEATURE_NAMES = [
  "distanceToNextStop",
  "dwellTimeMin",
  "incidentsNearby",
  "trafficFactor",
  "hourSin",
  "hourCos",
  "externalTempNorm",
  "externalPrecipNorm",
  "externalWindNorm",
  "externalWeatherSeverityNorm"
];

function toNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function extractFeatures(logLike) {
  const ts = new Date(logLike.timestamp || Date.now());
  const hour = ts.getHours() + ts.getMinutes() / 60;
  const hourAngle = (2 * Math.PI * hour) / 24;
  const externalWeatherSeverity = Math.max(0, toNumber(logLike.externalWeatherSeverity, 0));
  const externalTempC = toNumber(logLike.externalTempC, 0);
  const externalPrecipMm = Math.max(0, toNumber(logLike.externalPrecipMm, 0));
  const externalWindSpeedKph = Math.max(0, toNumber(logLike.externalWindSpeedKph, 0));

  return {
    distanceToNextStop: Math.max(0, toNumber(logLike.distanceToNextStop, 0)),
    dwellTimeMin: Math.max(0, toNumber(logLike.dwellTime, 0)) / 60,
    incidentsNearby: Math.max(0, toNumber(logLike.incidentsNearby, 0)),
    trafficFactor:
      Math.max(0.5, toNumber(logLike.trafficFactor, 1)) *
      Math.max(0.8, toNumber(logLike.externalTrafficImpact, 1)),
    hourSin: Math.sin(hourAngle),
    hourCos: Math.cos(hourAngle),
    externalTempNorm: Math.max(-1, Math.min(1.2, externalTempC / 40)),
    externalPrecipNorm: Math.max(0, Math.min(3, externalPrecipMm / 10)),
    externalWindNorm: Math.max(0, Math.min(3, externalWindSpeedKph / 40)),
    externalWeatherSeverityNorm: Math.max(0, Math.min(1, externalWeatherSeverity / 3))
  };
}

function featureVector(features) {
  return FEATURE_NAMES.map(name => toNumber(features[name], 0));
}

function predictEtaMinutes(model, features) {
  if (!model || !Array.isArray(model.weights) || model.weights.length !== FEATURE_NAMES.length) {
    return null;
  }
  const x = featureVector(features);
  const y = toNumber(model.bias, 0) + x.reduce((sum, xi, i) => sum + model.weights[i] * xi, 0);
  return Math.max(0, y);
}

function computeMetrics(model, samples) {
  if (!samples.length) {
    return { rmse: null, mae: null };
  }
  let se = 0;
  let ae = 0;
  for (const s of samples) {
    const p = predictEtaMinutes(model, s.features);
    const e = (p ?? 0) - s.target;
    se += e * e;
    ae += Math.abs(e);
  }
  return {
    rmse: Math.sqrt(se / samples.length),
    mae: ae / samples.length
  };
}

function buildTrainingSamples(logs) {
  const groups = new Map();

  for (const log of logs) {
    if (!log.nextStopId || !log.timestamp) continue;
    const key = `${log.busId || "UNKNOWN"}|${String(log.nextStopId)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(log);
  }

  const samples = [];
  const MAX_LOOKBACK_MIN = 60;

  for (const [, rows] of groups) {
    rows.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    let pending = [];
    for (const row of rows) {
      const rowTs = new Date(row.timestamp).getTime();
      if (!Number.isFinite(rowTs)) continue;

      pending.push(row);

      if (row.actualETAT) {
        const arrivalTs = new Date(row.actualETAT).getTime();
        if (!Number.isFinite(arrivalTs)) {
          pending = [];
          continue;
        }

        for (const p of pending) {
          const pTs = new Date(p.timestamp).getTime();
          if (!Number.isFinite(pTs) || pTs > arrivalTs) continue;
          const targetMin = (arrivalTs - pTs) / 60000;
          if (targetMin < 0 || targetMin > MAX_LOOKBACK_MIN) continue;
          samples.push({
            features: extractFeatures(p),
            target: targetMin
          });
        }
        pending = [];
      }
    }
  }

  // Fallback path:
  // If arrival-labeled samples are sparse, use simulator ETA as supervised target.
  // This keeps training usable early, before enough actual arrival events accumulate.
  if (samples.length < 30) {
    const fallbackSamples = [];
    for (const row of logs) {
      if (!row) continue;
      const etaMin = Number(row.eta);
      if (!Number.isFinite(etaMin)) continue;
      if (etaMin < 0 || etaMin > 120) continue;
      fallbackSamples.push({
        features: extractFeatures(row),
        target: etaMin
      });
    }

    if (!samples.length) return fallbackSamples;
    if (fallbackSamples.length) {
      const needed = Math.max(0, 200 - samples.length);
      if (needed > 0) {
        const step = Math.max(1, Math.floor(fallbackSamples.length / needed));
        for (let i = 0; i < fallbackSamples.length && samples.length < 200; i += step) {
          samples.push(fallbackSamples[i]);
        }
      }
    }
  }

  return samples;
}

function trainLinearRegression(samples, opts = {}) {
  const lr = toNumber(opts.learningRate, 0.003);
  const epochs = Math.max(1, Math.floor(toNumber(opts.epochs, 400)));
  const l2 = Math.max(0, toNumber(opts.l2, 0.0001));

  if (!samples.length) {
    return {
      model: null,
      stats: { samples: 0, rmse: null, mae: null }
    };
  }

  let bias = 0;
  const weights = Array(FEATURE_NAMES.length).fill(0);
  const n = samples.length;

  for (let epoch = 0; epoch < epochs; epoch++) {
    let gBias = 0;
    const gWeights = Array(FEATURE_NAMES.length).fill(0);

    for (const s of samples) {
      const x = featureVector(s.features);
      const pred = bias + x.reduce((sum, xi, i) => sum + xi * weights[i], 0);
      const err = pred - s.target;

      gBias += err;
      for (let i = 0; i < weights.length; i++) {
        gWeights[i] += err * x[i];
      }
    }

    bias -= (lr * gBias) / n;
    for (let i = 0; i < weights.length; i++) {
      const reg = l2 * weights[i];
      weights[i] -= lr * ((gWeights[i] / n) + reg);
    }
  }

  const model = {
    version: 1,
    featureNames: FEATURE_NAMES,
    bias,
    weights,
    trainedAt: new Date().toISOString(),
    samples: n
  };

  const metrics = computeMetrics(model, samples);
  return {
    model,
    stats: {
      samples: n,
      rmse: metrics.rmse,
      mae: metrics.mae
    }
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
    if (!parsed || !Array.isArray(parsed.weights)) return null;
    return parsed;
  } catch {
    return null;
  }
}

module.exports = {
  MODEL_PATH,
  FEATURE_NAMES,
  extractFeatures,
  predictEtaMinutes,
  buildTrainingSamples,
  trainLinearRegression,
  saveModel,
  loadModel
};
