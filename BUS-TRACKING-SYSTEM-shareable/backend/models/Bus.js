const mongoose = require("mongoose");

const PointSchema = new mongoose.Schema(
  {
    lat: { type: Number, required: true },
    lng: { type: Number, required: true }
  },
  { _id: false }
);

const BusSchema = new mongoose.Schema({
  id: { type: String, unique: true, index: true },
  route: { type: [PointSchema], default: [] },
  index: { type: Number, default: 0 },
  eta: { type: Number, default: null },
  status: { type: String, default: "ON_TIME" },
  running: { type: Boolean, default: false },
  location: { type: PointSchema, default: null },
  bearing: { type: Number, default: 0 },
  dwellRemainingSec: { type: Number, default: 0 },
  routeId: { type: mongoose.Schema.Types.ObjectId, ref: "Route", default: null },
  nextStop: { type: mongoose.Schema.Types.ObjectId, ref: "Stop", default: null },
  travelDirection: { type: Number, enum: [-1, 1], default: 1 }
});

module.exports = mongoose.model("Bus", BusSchema);
