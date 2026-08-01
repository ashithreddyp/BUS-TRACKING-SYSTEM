const mongoose = require('mongoose');

const IncidentSchema = new mongoose.Schema({
  type: { type: String, required: true },
  createdByRole: {
    type: String,
    enum: ["user", "admin"],
    default: "user"
  },
  lastPromptAt: { type: Date, default: null },
  location: {
    lat: { type: Number, required: true },
    lng: { type: Number, required: true }
  }
}, { timestamps: true });

module.exports = mongoose.model('Incident', IncidentSchema);
