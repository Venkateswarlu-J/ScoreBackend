const mongoose = require('mongoose');

const wicketTypeSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['bowled', 'caught', 'runOut', 'stumped', 'lbw', 'hitWicket', 'caughtAndBowled', 'retired'],
    required: true,
  },
  dismissedBatterId: { type: String, required: true },
  fielderId: { type: String, default: null },
  dismissedBowler: { type: String, default: null },
}, { _id: false });

const deliveryEventSchema = new mongoose.Schema({
  matchId: {
    type: String,
    required: true,
    index: true,
  },
  inningsNumber: {
    type: Number,
    required: true,
    enum: [1, 2],
  },
  sequence: {
    type: Number,
    required: true,
  },
  strikerId: { type: String, required: true },
  nonStrikerId: { type: String, required: true },
  bowlerId: { type: String, required: true },
  runsOffBat: { type: Number, default: 0 },
  extraType: {
    type: String,
    enum: [null, 'wide', 'noBall', 'bye', 'legBye'],
    default: null,
  },
  extraRuns: { type: Number, default: 0 },
  isWicket: { type: Boolean, default: false },
  wicket: wicketTypeSchema,
  isLegalDelivery: {
    type: Boolean,
    default: true,
  },
  idempotencyKey: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

// Index for sequence within innings
deliveryEventSchema.index({ matchId: 1, inningsNumber: 1, sequence: 1 });

module.exports = mongoose.model('DeliveryEvent', deliveryEventSchema);