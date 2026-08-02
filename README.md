# 🚌 BUS-TRACKING-SYSTEM

## Real-Time Bus Tracking & Transit Simulation Platform with ML-Based ETA Prediction

A full-stack intelligent bus tracking system that simulates GPS-based bus movement, provides real-time location updates, manages routes and incidents, and predicts estimated arrival times using machine learning.

---

# 📌 Overview

The **Bus Tracking System** is designed to improve public transportation monitoring by providing real-time bus tracking, route visualization, passenger information, and ETA prediction.

The platform combines:

* GPS simulation
* Real-time communication
* Interactive maps
* Route management
* Incident tracking
* Machine learning-based ETA prediction

---

# ✨ Features

## 🚌 Real-Time Tracking

* Live bus location updates
* GPS movement simulation
* Interactive map visualization
* Bus tracking dashboard

## 🗺️ Route Management

* Route creation and monitoring
* Bus stop management
* Route visualization
* Passenger route information

## 🚨 Incident Monitoring

* Report transportation incidents
* Monitor affected routes
* Improve travel awareness

## 🤖 ML-Based ETA Prediction

* Predict estimated arrival times
* Analyze simulated movement data
* Improve arrival accuracy

## 👥 Passenger Features

* View bus locations
* Track routes
* Check estimated arrival times

---

# 🏗️ System Architecture

```
                User
                 |
                 |
        React Frontend
                 |
                 |
        Socket.IO Connection
                 |
                 |
        Node.js + Express API
                 |
        ------------------
        |                |
    MongoDB        ML ETA Model
        |
 GPS Simulation Engine
```

---

# 🛠️ Technologies Used

| Category                | Technology           |
| ----------------------- | -------------------- |
| Frontend                | React.js             |
| Backend                 | Node.js              |
| API Framework           | Express.js           |
| Database                | MongoDB              |
| Real-Time Communication | Socket.IO            |
| Maps                    | Leaflet              |
| Machine Learning        | ETA Prediction Model |

---

# 📂 Project Structure

```
BUS-TRACKING-SYSTEM/

│
├── backend/
│
│   ├── server.js
│   ├── models/
│   │   └── Database schemas
│   │
│   ├── simulation/
│   │   └── GPS simulation engine
│   │
│   ├── ml/
│   │   └── ETA prediction logic
│   │
│   └── services/
│       └── Backend utilities
│
├── frontend/
│
│   └── src/
│
│       ├── components/
│       │   └── UI and map components
│       │
│       ├── pages/
│       │   └── Application pages
│       │
│       └── utils/
│           └── Helper functions
│
├── docs/
│
└── README.md
```

---

# ⚙️ Installation & Setup

## 1. Clone Repository

```bash
git clone https://github.com/ashithreddyp/BUS-TRACKING-SYSTEM.git
```

Move into the project:

```bash
cd BUS-TRACKING-SYSTEM
```

---

# Backend Setup

Navigate to backend:

```bash
cd backend
```

Install dependencies:

```bash
npm install
```

Create environment file:

```
.env
```

Example:

```env
PORT=5000
MONGO_URI=your_database_connection
```

Start backend:

```bash
npm start
```

---

# Frontend Setup

Open another terminal:

```bash
cd frontend
```

Install dependencies:

```bash
npm install
```

Start React application:

```bash
npm start
```

# 🔄 How It Works

1. GPS simulator generates bus movement data.
2. Backend processes location updates.
3. Socket.IO broadcasts real-time updates.
4. React dashboard displays bus positions.
5. ETA model predicts arrival times.
6. Users view live transport information.

---

# 🚀 Future Improvements

* Mobile application support
* Real GPS hardware integration
* Advanced traffic prediction
* Cloud deployment
* User authentication
* Route optimization
* Push notifications

---

# 👨‍💻 Developer

**Ashith Reddy**

GitHub:

https://github.com/ashithreddyp

---

# 📄 License

This project is developed for educational purposes.
