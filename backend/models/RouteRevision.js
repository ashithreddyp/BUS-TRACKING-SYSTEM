const mongoose = require("mongoose");

const RouteRevisionSchema = new mongoose.Schema(
  {
    routeId: { type: mongoose.Schema.Types.ObjectId, ref: "Route", index: true, required: true },
    routeNumber: { type: String, index: true, required: true },
    action: { type: String, enum: ["create", "update", "rollback", "delete"], required: true },
    snapshot: {
      routeNumber: { type: String, required: true },
      routeName: { type: String, default: null },
      startPointName: { type: String, default: null },
      endPointName: { type: String, default: null },
      stops: [{ type: mongoose.Schema.Types.ObjectId, ref: "Stop" }],
      polyline: [{ lat: Number, lng: Number }],
      assignedBuses: [{ type: String }]
    },
    metadata: {
      previousRouteNumber: { type: String, default: null },
      changedFields: [{ type: String }]
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model("RouteRevision", RouteRevisionSchema);
