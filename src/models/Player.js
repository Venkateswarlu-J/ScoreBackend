const mongoose = require('mongoose');

const playerSchema = new mongoose.Schema({
  displayName: {
    type: String,
    required: true,
    trim: true,
  },
  teamId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Team',
    default: null,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

playerSchema.index({ teamId: 1 });
playerSchema.index({ displayName: 1 });

module.exports = mongoose.model('Player', playerSchema);
