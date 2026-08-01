# BUS-TRACKING-SYSTEM

A real-time bus tracking and transit simulation platform with ML-based ETA prediction.

## Overview

The Bus Tracking System is designed to simulate and monitor public transportation using GPS simulation, route management, live tracking, and estimated arrival time prediction.

## Technologies Used

* **Backend:** Node.js, Express.js
* **Frontend:** React.js
* **Database:** MongoDB
* **Real-time Communication:** Socket.IO
* **Maps:** Leaflet
* **Machine Learning:** ETA prediction model

## Project Structure

```
BUS-TRACKING-SYSTEM/
│
├── backend/
│   ├── server.js              # API server and integration
│   ├── models/                # Database schemas
│   ├── simulation/            # GPS simulation engine
│   ├── ml/                    # ETA prediction logic
│   └── services/              # Backend utilities
│
├── frontend/
│   ├── src/
│   │   ├── components/        # UI and map components
│   │   ├── pages/             # Application pages
│   │   └── utils/             # Helper functions
│
└── docs/                      # Project documentation
```

## Features

* Real-time bus location tracking
* GPS simulation
* Interactive map dashboard
* Route and stop management
* Incident monitoring
* ML-based ETA prediction
* Passenger tracking interface

## Installation

### Backend

```bash
cd backend
npm install
```

Start the backend server:

```bash
npm start
```

### Frontend

```bash
cd frontend
npm install
```

Start the React application:

```bash
npm start
```

## Configuration

Create a `.env` file in the backend directory and add required environment variables.

Example:

```
MONGO_URI=your_database_connection
PORT=5000
```

## Future Improvements

* Mobile application support
* Real GPS device integration
* Advanced traffic prediction
* Cloud deployment

## License

This project is developed for educational purposes.
