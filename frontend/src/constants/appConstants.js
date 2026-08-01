export const API_BASE_URL = "http://localhost:5000";
export const SOCKET_URL = API_BASE_URL;

export const THEME_STORAGE_KEY = "theme_mode";
export const MODE_STORAGE_KEY = "portal_mode";
export const STOP_REUSE_RADIUS_METERS = 25;
export const SEARCH_DEBOUNCE_MS = 140;

export const INCIDENT_TYPES = ["Accident", "Road Work", "Traffic Jam", "Flood"];

export const DEFAULT_ML_STATUS = {
  enabled: false,
  trainedAt: null,
  samples: 0,
  inputGroups: {
    eta: [],
    delay: [],
    peak: [],
    all: []
  },
  outputNames: [],
  etaModel: null,
  delayModel: null,
  peakModel: null,
  trainingData: {
    logs30d: 0,
    totalLogs: 0,
    lastLogAt: null
  }
};

export const MAP_CENTER = [13.08, 77.58];
