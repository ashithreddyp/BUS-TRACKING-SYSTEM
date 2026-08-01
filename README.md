# BUS-TRACKING-SYSTEM
<<<<<<< HEAD

Project layout is intentionally split into:

- `backend/` for API, simulation, ML, models, and persistence
- `frontend/` for React UI and map dashboard

## Backend Structure

- `backend/server.js`: API server and integration wiring
- `backend/models/`: Mongoose schemas (`Bus`, `Stop`, `Route`, `Incident`, `SimulationLog`)
- `backend/simulation/`: simulation engine (`gpsSimulator.js`)
- `backend/ml/`: ETA model and external-data enrichment
- `backend/services/`: shared backend domain helpers

## Frontend Structure

- `frontend/src/App.js`: top-level app coordinator
- `frontend/src/pages/`: dashboard pages and passenger views
- `frontend/src/components/map/`: map-only UI components/icons
- `frontend/src/utils/`: frontend utility helpers

## Notes

- Keep API and simulation logic inside `backend/`.
- Keep UI and map rendering logic inside `frontend/`.
- Do not place model/schema files outside `backend/models/`.

## Planning Docs

- `docs/COLLEGE_PROJECT_CHECKLIST.md`: submission checklist, roadmap, pre-demo test plan, and future scope
=======
Real-Time Bus Tracking &amp; Transit Simulation Platform with ML ETA Prediction Node.js, Express.js, React, MongoDB, Socket.IO, Leaflet, ML
>>>>>>> b135f15c34e2324ac8e51e6a21b5292f721c3857
