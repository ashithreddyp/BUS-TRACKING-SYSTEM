const mongoose = require("mongoose");

const RouteSchema = new mongoose.Schema(
  {
    routeNumber: {
      type: String,
      required: true,
      unique: true,
      index: true
    },

    routeName: {
      type: String,
      default: null
    },

    startPointName: {
      type: String,
      default: null
    },

    endPointName: {
      type: String,
      default: null
    },

    stops: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Stop",
        required: true
      }
    ],

    polyline: [
      {
        lat: Number,
        lng: Number
      }
    ],

    assignedBuses: [
      {
        type: String,
        ref: "Bus"
      }
    ]
  },
  { timestamps: true }
);

module.exports = mongoose.model("Route", RouteSchema);
