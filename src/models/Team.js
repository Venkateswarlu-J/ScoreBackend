const mongoose = require('mongoose');

const teamSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
  },
  shortName: {
    type: String,
    trim: true,
    maxlength: 5,
  },
  players: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Player',
  }],
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

teamSchema.index({ name: 1 });

module.exports = mongoose.model('Team', teamSchema);
