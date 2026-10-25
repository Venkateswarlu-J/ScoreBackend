const mongoose = require('mongoose');

const tournamentSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
  },
  teams: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Team',
  }],
  status: {
    type: String,
    enum: ['UPCOMING', 'ACTIVE', 'COMPLETED'],
    default: 'UPCOMING',
  },
  pointsConfig: {
    win: { type: Number, default: 2 },
    loss: { type: Number, default: 0 },
    tie: { type: Number, default: 1 },
    noResult: { type: Number, default: 1 },
    draw: { type: Number, default: 1 },
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

tournamentSchema.index({ status: 1 });

module.exports = mongoose.model('Tournament', tournamentSchema);
