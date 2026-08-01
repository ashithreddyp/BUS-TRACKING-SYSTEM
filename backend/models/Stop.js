const mongoose = require('mongoose');

const StopSchema = new mongoose.Schema({
  name: { type: String, default: null },
  location: {
    lat: { type: Number, required: true },
    lng: { type: Number, required: true }
  }
}, { timestamps: true });

module.exports = mongoose.model('Stop', StopSchema);
