# College Project Checklist

This checklist turns the project roadmap into an execution list for development, demo, and final submission.

## Project Summary

Project: Real-time bus tracking and transit simulation platform  
Stack:

- `backend/`: Node.js, Express, MongoDB, Socket.IO, simulation engine, ML ETA pipeline
- `frontend/`: React, Leaflet, passenger/admin dashboard

Core goals:

- simulate buses on routes with realistic stop behavior
- provide passenger-facing live ETAs and route visibility
- provide admin-facing route, bus, stop, and incident control
- support ML-based ETA improvement using simulation logs

## Must Have

These are the items that should be treated as required before final submission.

### 1. ETA Reliability

- [ ] Bus popup ETA, stop popup ETA, and route timeline ETA match the same live logic
- [ ] Selected bus popup shows terminal ETA by default
- [ ] Selected bus popup shows ETA to selected stop when a stop is selected
- [ ] Stop popups show all relevant buses for that stop
- [ ] Fastest bus is shown correctly at each stop
- [ ] Shared stops across multiple routes show arrivals without dropping buses

Definition of done:

- no visible ETA contradictions between bus popup, stop popup, and route timeline

### 2. Simulation Stability

- [ ] Buses stop at every normal stop for 1 minute
- [ ] Buses stop at route start/end terminals for 5 minutes
- [ ] Bus `nextStop` always updates to the correct stop name
- [ ] Adding a new bus to an existing route does not restart buses already running
- [ ] Removing a bus from a route removes it from route simulation and UI everywhere

Definition of done:

- route updates do not reset stable running buses unless route shape itself changes

### 3. Admin Workflow Quality

- [ ] Route builder follows a clean step order
- [ ] Existing-route editing is clear and predictable
- [ ] Bus assignment and removal are easy to understand
- [ ] Route creation/reset behavior leaves the panel in a clean state
- [ ] Admin can see route stops clearly for the selected route

Definition of done:

- an external user can build or edit a route without explanation from the developer

### 4. Validation and Guardrails

- [ ] Prevent saving route without route number
- [ ] Prevent saving route without polyline
- [ ] Prevent saving route with fewer than 2 stops
- [ ] Prevent saving route without at least 1 assigned bus
- [ ] Prevent duplicate route number creation
- [ ] Prevent invalid bus or stop references from being saved

Definition of done:

- invalid state is blocked with direct user-facing feedback

### 5. Passenger Experience

- [ ] Passenger can search by bus number
- [ ] Passenger can search by stop
- [ ] Passenger can search by start/end point
- [ ] Search selection focuses map correctly
- [ ] Only searched/focused route content is shown in passenger mode
- [ ] Stop and bus popups update while simulation continues in the background

Definition of done:

- passenger flow works cleanly from search to map to ETA

## Nice To Have

These increase presentation quality and make the project feel more complete.

### 1. Admin Analytics

- [ ] Show total routes
- [ ] Show total buses
- [ ] Show active/running buses
- [ ] Show delayed buses
- [ ] Show total incidents
- [ ] Show last simulation activity timestamp

### 2. Route Analytics

- [ ] Per-route stop count
- [ ] Per-route assigned bus count
- [ ] Per-route average ETA
- [ ] Per-route active incident count

### 3. ML Visibility

- [ ] Show raw ETA formula output
- [ ] Show ML ETA output
- [ ] Show final ETA used by system
- [ ] Show model sample count
- [ ] Show training timestamp
- [ ] Show confidence/range information

### 4. Simulation Logs

- [ ] Add recent simulation log viewer in admin mode
- [ ] Show bus id, route id, stop id, ETA, dwell, delay, timestamp

### 5. Empty and Loading States

- [ ] No route selected
- [ ] No buses available
- [ ] No arrivals near stop
- [ ] No incidents
- [ ] No training data
- [ ] Training in progress

## Future Scope

These are good items for viva discussion or report sections.

### 1. Better ML Models

- [ ] Incident-type-specific ETA effect model
- [ ] Better regression features for ETA
- [ ] Metrics like MAE/RMSE for ETA evaluation
- [ ] Online retraining or scheduled retraining

### 2. Stronger Route Editing

- [ ] Full visual route editing on map
- [ ] Drag-and-drop stop repositioning on map
- [ ] Better route revision history and comparison

### 3. Production Readiness

- [ ] Authentication hardening
- [ ] Better error monitoring
- [ ] Deployment configuration
- [ ] Responsive/mobile-first dashboard polish

## Pre-Demo Test Checklist

Run these before showing the project.

### Simulation

- [ ] Create route with at least 2 stops and 1 bus
- [ ] Confirm simulation starts after publish
- [ ] Confirm bus stops at each stop
- [ ] Confirm terminal dwell at start and end
- [ ] Confirm next stop updates correctly

### Multiple Buses

- [ ] Add another bus to existing route
- [ ] Confirm old bus keeps running
- [ ] Confirm new bus starts fresh
- [ ] Confirm both buses appear correctly on map

### Shared Stop

- [ ] Create a second route that uses a shared stop
- [ ] Confirm stop popup lists buses from both routes
- [ ] Confirm fastest bus is correct
- [ ] Confirm directional ETA remains stable

### Passenger Flow

- [ ] Search by bus number
- [ ] Search by stop
- [ ] Search by start point
- [ ] Search by end point
- [ ] Confirm map focus and popup behavior

### Incidents

- [ ] Add incident from admin
- [ ] Add incident from passenger
- [ ] Confirm incident affects ETA
- [ ] Confirm 30-minute prompt behavior
- [ ] Confirm incident removal works

### ML

- [ ] Generate enough simulation logs
- [ ] Train ETA model
- [ ] Confirm training status updates
- [ ] Confirm model panel displays samples/logs/weather

## Submission Package Checklist

Use this when preparing the final college submission.

- [ ] Project title
- [ ] Problem statement
- [ ] Objectives
- [ ] Technology stack
- [ ] Architecture diagram
- [ ] Database schema summary
- [ ] API summary
- [ ] Simulation workflow explanation
- [ ] ML workflow explanation
- [ ] Screenshots of passenger mode
- [ ] Screenshots of admin mode
- [ ] Setup and run instructions
- [ ] Challenges faced
- [ ] Limitations
- [ ] Future scope

## Recommended Work Order

Do work in this order to avoid breaking stable behavior:

1. ETA reliability
2. simulation stability
3. admin workflow and validation
4. analytics and ML visibility
5. documentation and submission prep

## Reminders

Items previously deferred and worth revisiting later:

- incident-specific ML training by incident type
- external incident datasets for richer ETA/impact modeling

