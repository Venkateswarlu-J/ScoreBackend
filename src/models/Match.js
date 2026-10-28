const mongoose = require('mongoose');

// Allowed overs formats: Super Over (0), 2, 3, 4, 5, 6, 8, 10, 15, 20, 30, 50
const ALLOWED_OVERS = [1, 2, 3, 4, 5, 6, 8, 10, 15, 20, 30, 50];

const batterStatsSchema = new mongoose.Schema({
  playerId: { type: String, required: true },
  displayName: { type: String, required: true },
  runs: { type: Number, default: 0 },
  ballsFaced: { type: Number, default: 0 },
  fours: { type: Number, default: 0 },
  sixes: { type: Number, default: 0 },
  isOut: { type: Boolean, default: false },
  dismissalType: { type: String, default: null },
  dismissalBowler: { type: String, default: null },
  dismissalFielder: { type: String, default: null },
}, { _id: false });

const bowlerStatsSchema = new mongoose.Schema({
  playerId: { type: String, required: true },
  displayName: { type: String, required: true },
  legalBallsBowled: { type: Number, default: 0 },
  oversBowled: { type: String, default: '0' },
  maidens: { type: Number, default: 0 },
  runsConceded: { type: Number, default: 0 },
  wickets: { type: Number, default: 0 },
  widesBowled: { type: Number, default: 0 },
  noBallsBowled: { type: Number, default: 0 },
  currentOverRuns: { type: Number, default: 0 },
  currentOverLegalBalls: { type: Number, default: 0 },
  currentOverWickets: { type: Number, default: 0 },
}, { _id: false });

const inningsSubSchema = new mongoose.Schema({
  battingTeamId: { type: String, default: null },
  bowlingTeamId: { type: String, default: null },
  battingTeamName: { type: String, default: '' },
  bowlingTeamName: { type: String, default: '' },
  total: { type: Number, default: 0 },
  wickets: { type: Number, default: 0 },
  legalBalls: { type: Number, default: 0 },
  extras: {
    wides: { type: Number, default: 0 },
    noBalls: { type: Number, default: 0 },
    byes: { type: Number, default: 0 },
    legByes: { type: Number, default: 0 },
    penalty: { type: Number, default: 0 },
  },
  overs: { type: String, default: '0.0' },
  status: {
    type: String,
    enum: ['NOT_STARTED', 'IN_PROGRESS', 'COMPLETED'],
    default: 'NOT_STARTED',
  },
  batters: [batterStatsSchema],
  bowlers: [bowlerStatsSchema],
  activeStrikerId: { type: String, default: null },
  activeNonStrikerId: { type: String, default: null },
  activeBowlerId: { type: String, default: null },
  lastBallSummary: { type: [mongoose.Schema.Types.Mixed], default: [] },
  target: { type: Number, default: null },
  needNewBatter: { type: Boolean, default: false },
  needNewBowler: { type: Boolean, default: false },
}, { _id: false });

const playerRefSchema = new mongoose.Schema({
  playerId: { type: String, required: true },
  displayName: { type: String, required: true },
}, { _id: false });

const teamInfoSchema = new mongoose.Schema({
  teamId: { type: String, default: null },
  teamName: { type: String, required: true },
  players: [playerRefSchema],
}, { _id: false });

const matchSchema = new mongoose.Schema({
  publicId: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  tournamentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Tournament',
    default: null,
  },
  team1: teamInfoSchema,
  team2: teamInfoSchema,
  oversPerInnings: {
    type: Number,
    required: true,
    enum: [1, 2, 3, 4, 5, 6, 8, 10, 15, 20, 30, 50],
    validate: {
      validator: function(v) {
        return ALLOWED_OVERS.includes(v);
      },
      message: 'Overs must be Super Over (0), 2, 3, 4, 5, 6, 8, 10, 15, 20, 30, or 50'
    }
  },
  venue: { type: String, default: null },
  date: { type: Date, default: null },
  status: {
    type: String,
    enum: ['CREATED', 'SETUP', 'LIVE', 'INNINGS_BREAK', 'TIED', 'SUPER_OVER', 'COMPLETED'],
    default: 'CREATED',
  },
  tossDetails: {
    tossWonBy: { type: String, default: null },
    electedTo: { type: String, enum: ['bat', 'bowl', null], default: null },
    battingFirst: { type: String, default: null },
    bowlingFirst: { type: String, default: null },
  },
  currentInnings: {
    type: Number,
    enum: [1, 2],
    default: 1,
  },
  innings1: {
    type: inningsSubSchema,
    default: () => ({}),
  },
  innings2: {
    type: inningsSubSchema,
    default: () => ({}),
  },
  // Super Over support (array to allow multiple Super Overs)
  superOvers: [{
    type: inningsSubSchema,
    default: () => ({}),
  }],
  hasSuperOver: {
    type: Boolean,
    default: false,
  },
  result: {
    winner: { type: String, default: null },
    resultText: { type: String, default: null },
    margin: { type: Number, default: null },
    marginType: { type: String, enum: ['runs', 'wickets', null], default: null },
  },
  scorerTokenHash: {
    type: String,
    required: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

matchSchema.index({ status: 1 });
matchSchema.index({ tournamentId: 1 });
matchSchema.index({ createdAt: -1 });

matchSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

// Strip scorer token hash from JSON output
matchSchema.methods.toPublicJSON = function () {
  const obj = this.toObject();
  delete obj.scorerTokenHash;
  return obj;
};

module.exports = mongoose.model('Match', matchSchema);
module.exports.ALLOWED_OVERS = ALLOWED_OVERS;
