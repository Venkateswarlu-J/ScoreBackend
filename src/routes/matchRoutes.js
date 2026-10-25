const express = require('express');
const { nanoid } = require('nanoid');
const Match = require('../models/Match');
const DeliveryEvent = require('../models/DeliveryEvent');
const { generateToken, hashToken, verifyToken } = require('../utils/generateToken');
const { generateIdempotencyKey } = require('../utils/idempotency');
const ScoringEngine = require('../services/scoringEngine');
const authMiddleware = require('../middleware/auth');
const { mutationLimiter, readLimiter } = require('../middleware/rateLimiter');

const router = express.Router();
const scoringEngine = new ScoringEngine();

// Allowed overs formats
const ALLOWED_OVERS = [1, 2, 3, 4, 5, 6, 8, 10, 15, 20, 30, 50];

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Broadcast updated match state to everyone in the match room */
function broadcastMatchUpdate(req, match) {
  try {
    const io = req.app.get('io');
    if (io) {
      io.to(`match:${match.publicId}`).emit('scoreUpdate', match.toPublicJSON());
    }
  } catch (_) {
    // Non-fatal; viewers just won't get the push
  }
}

/**
 * Re-derive full innings state by replaying all remaining DeliveryEvents.
 * Returns the mutated innings object (caller must mark modified + save).
 */
async function recalculateInnings(match, inningsNumber) {
  const innings = inningsNumber === 1 ? match.innings1 : match.innings2;

  // ---- snapshot the opening state we set during /setup or /start-innings ----
  // We preserve: batters list (resetting stats), bowlers list (resetting stats),
  // activeStrikerId / activeNonStrikerId / activeBowlerId as they were at kick-off.
  // We do NOT touch battingTeamId/Name, bowlingTeamId/Name, target, status.

  // Reset running totals
  innings.total = 0;
  innings.wickets = 0;
  innings.legalBalls = 0;
  innings.overs = '0.0';
  innings.extras = { wides: 0, noBalls: 0, byes: 0, legByes: 0, penalty: 0 };
  innings.lastBallSummary = [];
  innings.needNewBatter = false;
  innings.needNewBowler = false;

  // Reset batter stats (keep identity fields)
  for (const b of innings.batters) {
    b.runs = 0;
    b.ballsFaced = 0;
    b.fours = 0;
    b.sixes = 0;
    b.isOut = false;
    b.dismissalType = undefined;
  }

  // Reset bowler stats
  for (const b of innings.bowlers) {
    b.legalBallsBowled = 0;
    b.oversBowled = '0';
    b.maidens = 0;
    b.runsConceded = 0;
    b.wickets = 0;
    b.widesBowled = 0;
    b.noBallsBowled = 0;
  }

  // Restore opening striker/non-striker/bowler from the first entry of each list
  // (they were set correctly by /setup or /start-innings)
  if (innings.batters.length >= 2) {
    innings.activeStrikerId = innings.batters[0].playerId;
    innings.activeNonStrikerId = innings.batters[1].playerId;
  }
  if (innings.bowlers.length >= 1) {
    innings.activeBowlerId = innings.bowlers[0].playerId;
  }

  // Fetch all remaining delivery events for this innings
  const events = await DeliveryEvent.find({
    matchId: match._id,
    inningsNumber,
  }).sort({ sequence: 1 });

  // Replay each event
  for (const ev of events) {
    applyDeliveryToInnings(innings, ev, match.oversPerInnings);
  }

  return innings;
}

/**
 * Apply a single DeliveryEvent to the innings state.
 * This is the single source-of-truth for scoring — used both in the
 * live delivery route and in recalculation after undo.
 */
function applyDeliveryToInnings(innings, ev, oversPerInnings) {
  const runsOffBat = ev.runsOffBat || 0;
  const extraRuns = ev.extraRuns || 0;
  const extraType = ev.extraType || null;
  const isLegal = ev.isLegalDelivery;

  // ── 1. total runs ──────────────────────────────────────────────────────────
  let deliveryTotal = runsOffBat + extraRuns;
  if (extraType === 'wide' || extraType === 'noBall') {
    deliveryTotal += 1; // penalty run
  }
  innings.total += deliveryTotal;

  // ── 2. extras breakdown ───────────────────────────────────────────────────
  // Map delivery extraType (camelCase singular) to innings.extras key (camelCase plural)
  const extrasFieldMap = {
    wide:   'wides',
    noBall: 'noBalls',
    bye:    'byes',
    legBye: 'legByes',
  };
  if (extraType) {
    const extrasKey = extrasFieldMap[extraType] || extraType;
    // wides / no-balls: penalty run (1) + any extra runs hit off the delivery
    // byes / leg-byes : just the extra runs (no penalty)
    if (extraType === 'wide' || extraType === 'noBall') {
      innings.extras[extrasKey] = (innings.extras[extrasKey] || 0) + 1 + extraRuns;
    } else {
      innings.extras[extrasKey] = (innings.extras[extrasKey] || 0) + extraRuns;
    }
  }

  // ── 3. batter stats ───────────────────────────────────────────────────────
  if (extraType !== 'wide') {
    // Batter faces the ball (unless it's a wide)
    const striker = innings.batters.find(b => b.playerId === ev.strikerId);
    if (striker) {
      striker.ballsFaced += 1;
      // Runs off bat credit
      striker.runs += runsOffBat;
      if (runsOffBat === 4) striker.fours += 1;
      if (runsOffBat === 6) striker.sixes += 1;
    }
  }

  // ── 4. bowler stats ───────────────────────────────────────────────────────
  const bowler = innings.bowlers.find(b => b.playerId === ev.bowlerId);
  if (bowler) {
    if (isLegal) {
      bowler.legalBallsBowled += 1;
      const completedOvers = Math.floor(bowler.legalBallsBowled / 6);
      const remainingBalls = bowler.legalBallsBowled % 6;
      bowler.oversBowled = `${completedOvers}.${remainingBalls}`;
    }
    // Runs conceded = runs off bat + extras (but NOT byes/leg-byes)
    if (extraType !== 'bye' && extraType !== 'legBye') {
      bowler.runsConceded += deliveryTotal;
    } else {
      // Byes/leg-byes charged to extras, not to bowler
      bowler.runsConceded += 0;
    }
    if (extraType === 'wide') bowler.widesBowled = (bowler.widesBowled || 0) + 1;
    if (extraType === 'noBall') bowler.noBallsBowled = (bowler.noBallsBowled || 0) + 1;
    if (ev.isWicket) {
      // Byes/leg-byes/run-outs don't credit bowler
      const noCredit = ['run out', 'Run Out', 'obstructing the field', 'hit the ball twice'].some(
        t => (ev.wicket?.type || '').toLowerCase().includes(t.toLowerCase())
      );
      if (!noCredit) bowler.wickets += 1;
    }
  }

  // ── 5. legal balls & overs ────────────────────────────────────────────────
  if (isLegal) {
    innings.legalBalls += 1;
  }
  const completedOvers = Math.floor(innings.legalBalls / 6);
  const remainingBalls = innings.legalBalls % 6;
  innings.overs = `${completedOvers}.${remainingBalls}`;

  // ── 6. wicket ─────────────────────────────────────────────────────────────
  if (ev.isWicket && ev.wicket) {
    innings.wickets += 1;
    const dismissed = innings.batters.find(b => b.playerId === ev.wicket.dismissedBatterId);
    if (dismissed) {
      dismissed.isOut = true;
      dismissed.dismissalType = ev.wicket.type;
      // Store bowler name for dismissal display
      if (ev.wicket.dismissedBowler) {
        dismissed.dismissalBowler = ev.wicket.dismissedBowler;
      } else {
        // Look up bowler name from innings bowlers list
        const bowler = innings.bowlers.find(b => b.playerId === ev.bowlerId);
        if (bowler) dismissed.dismissalBowler = bowler.displayName;
      }
    }
    innings.needNewBatter = true;
    if (innings.wickets >= 10) {
      innings.status = 'COMPLETED';
    }
  }

  // ── 7. strike rotation ────────────────────────────────────────────────────
  // First apply run-based rotation, then end-of-over rotation.
  // They must NOT both fire when odd runs on last ball of over —
  // the end-of-over swap is the only one that should stand in that case
  // because the batters cross ends already.
  //
  // Rule: after end-of-over ball, ALWAYS swap (the bowler changes ends).
  //       On normal mid-over balls, swap only on odd total runs.
  const totalRunsForRotation = runsOffBat + extraRuns; // wides don't count for rotation check

  const isEndOfOver = isLegal && innings.legalBalls % 6 === 0;

  if (isEndOfOver) {
    // End of over: always swap (regardless of runs)
    const temp = innings.activeStrikerId;
    innings.activeStrikerId = innings.activeNonStrikerId;
    innings.activeNonStrikerId = temp;
    innings.needNewBowler = true;
  } else {
    // Mid-over: swap only on odd total (off bat + extras, not penalty)
    if (totalRunsForRotation % 2 === 1) {
      const temp = innings.activeStrikerId;
      innings.activeStrikerId = innings.activeNonStrikerId;
      innings.activeNonStrikerId = temp;
    }
  }

  // ── 8. last ball summary (structured object for the frontend) ─────────────
  const ballObj = {
    runs: runsOffBat,
    extraType: extraType || null,
    extraRuns,
    isWicket: ev.isWicket || false,
    isLegal,
    type: ev.isWicket
      ? 'wicket'
      : extraType
      ? extraType
      : runsOffBat === 0
      ? 'dot'
      : runsOffBat === 4 || runsOffBat === 6
      ? 'boundary'
      : 'run',
  };
  innings.lastBallSummary.push(ballObj);
  if (innings.lastBallSummary.length > 30) {
    innings.lastBallSummary.shift();
  }

  // ── 9. innings completion (overs exhausted) ───────────────────────────────
  if (oversPerInnings > 0 && innings.legalBalls >= oversPerInnings * 6) {
    innings.status = 'COMPLETED';
  }
}

// ─── routes ───────────────────────────────────────────────────────────────────

/**
 * POST /api/matches
 * Create a new match
 * Supported overs: Super Over (0), 2, 3, 4, 5, 6, 8, 10, 15, 20, 30, 50
 */
router.post('/', readLimiter, async (req, res, next) => {
  try {
    const { team1, team2, oversPerInnings, venue, date, tournamentId } = req.body;

    if (!team1 || !team2 || oversPerInnings === undefined) {
      return res.status(400).json({ error: 'Team names and overs per innings are required' });
    }

    // Validate overs format
    const overs = parseInt(oversPerInnings);
    if (!ALLOWED_OVERS.includes(overs)) {
      return res.status(400).json({
        error: 'Invalid overs format',
        allowed: ALLOWED_OVERS,
        message: 'Overs must be Super Over (0), 2, 3, 4, 5, 6, 8, 10, 15, 20, 30, or 50'
      });
    }

    // Generate public ID and scorer token
    const publicId = nanoid(10);
    const scorerToken = generateToken();
    const scorerTokenHash = hashToken(scorerToken);

    // Create match
    const match = new Match({
      publicId,
      tournamentId: tournamentId || null,
      team1: {
        teamId: null,
        teamName: team1.name || team1,
        players: team1.players || [],
      },
      team2: {
        teamId: null,
        teamName: team2.name || team2,
        players: team2.players || [],
      },
      oversPerInnings: parseInt(oversPerInnings),
      venue: venue || null,
      date: date || null,
      status: 'CREATED',
      tossDetails: {},
      currentInnings: 1,
      innings1: {
        battingTeamId: null,
        bowlingTeamId: null,
        battingTeamName: team1.name || team1,
        bowlingTeamName: team2.name || team2,
        total: 0,
        wickets: 0,
        legalBalls: 0,
        extras: { wides: 0, noBalls: 0, byes: 0, legByes: 0, penalty: 0 },
        overs: '0.0',
        status: 'NOT_STARTED',
        batters: [],
        bowlers: [],
        activeStrikerId: null,
        activeNonStrikerId: null,
        activeBowlerId: null,
        lastBallSummary: [],
      },
      innings2: {
        battingTeamId: null,
        bowlingTeamId: null,
        battingTeamName: team2.name || team2,
        bowlingTeamName: team1.name || team1,
        total: 0,
        wickets: 0,
        legalBalls: 0,
        extras: { wides: 0, noBalls: 0, byes: 0, legByes: 0, penalty: 0 },
        overs: '0.0',
        status: 'NOT_STARTED',
        batters: [],
        bowlers: [],
        activeStrikerId: null,
        activeNonStrikerId: null,
        activeBowlerId: null,
        lastBallSummary: [],
      },
      result: { winner: null, resultText: null, margin: null, marginType: null },
      scorerTokenHash,
    });

    await match.save();

    res.status(201).json({
      match: match.toPublicJSON(),
      scorerToken,
      publicUrl: `/match/${publicId}`,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/matches
 * List matches with filters
 */
router.get('/', readLimiter, async (req, res, next) => {
  try {
    const { status, tournamentId } = req.query;
    const filter = {};

    if (status) filter.status = status;
    if (tournamentId) filter.tournamentId = tournamentId;

    const matches = await Match.find(filter).sort({ createdAt: -1 });
    const publicMatches = matches.map(m => m.toPublicJSON());

    res.json(publicMatches);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/matches/:matchId
 * Get match by public ID
 */
router.get('/:matchId', readLimiter, async (req, res, next) => {
  try {
    const match = await Match.findOne({ publicId: req.params.matchId });
    if (!match) return res.status(404).json({ error: 'Match not found' });

    res.json(match.toPublicJSON());
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/matches/:matchId/setup
 * Setup match with toss and opening batters
 */
router.post('/:matchId/setup', mutationLimiter, authMiddleware, async (req, res, next) => {
  try {
    const match = await Match.findOne({ publicId: req.params.matchId });
    if (!match) return res.status(404).json({ error: 'Match not found' });

    // Verify scorer token
    if (!verifyToken(req.scorerToken, match.scorerTokenHash)) {
      return res.status(401).json({ error: 'Invalid scorer token' });
    }

    const { tossDetails, openingBatters, bowler } = req.body;

    if (!tossDetails || !tossDetails.tossWonBy || !tossDetails.electedTo) {
      return res.status(400).json({ error: 'Toss details required' });
    }

    // Set toss details
    match.tossDetails = {
      tossWonBy: tossDetails.tossWonBy,
      electedTo: tossDetails.electedTo,
      battingFirst: tossDetails.battingFirst || null,
      bowlingFirst: tossDetails.bowlingFirst || null,
    };

    // Set opening batters and bowler
    if (openingBatters && openingBatters.length === 2) {
      const striker = openingBatters[0];
      const nonStriker = openingBatters[1];

      // Extract playerId and displayName, handling both object and string formats
      // Handle case where striker might be a string (legacy) or object { playerId, displayName }
      let strikerId, strikerName, nonStrikerId, nonStrikerName;

      if (typeof striker === 'string') {
        strikerId = striker;
        strikerName = striker;
      } else {
        strikerId = striker.playerId;
        strikerName = striker.displayName || striker.playerId;
      }

      if (typeof nonStriker === 'string') {
        nonStrikerId = nonStriker;
        nonStrikerName = nonStriker;
      } else {
        nonStrikerId = nonStriker.playerId;
        nonStrikerName = nonStriker.displayName || nonStriker.playerId;
      }

      match.innings1.activeStrikerId = strikerId;
      match.innings1.activeNonStrikerId = nonStrikerId;

      // Add batters to innings
      match.innings1.batters = [
        { playerId: strikerId, displayName: strikerName, runs: 0, ballsFaced: 0, fours: 0, sixes: 0, isOut: false },
        { playerId: nonStrikerId, displayName: nonStrikerName, runs: 0, ballsFaced: 0, fours: 0, sixes: 0, isOut: false },
      ];
    }

    if (bowler) {
      let bowlerPlayerId, bowlerDisplayName;

      if (typeof bowler === 'string') {
        bowlerPlayerId = bowler;
        bowlerDisplayName = bowler;
      } else {
        bowlerPlayerId = bowler.playerId;
        bowlerDisplayName = bowler.displayName || bowler.playerId;
      }

      match.innings1.activeBowlerId = bowlerPlayerId;
      match.innings1.bowlers = [
        { playerId: bowlerPlayerId, displayName: bowlerDisplayName, legalBallsBowled: 0, oversBowled: '0', maidens: 0, runsConceded: 0, wickets: 0, widesBowled: 0, noBallsBowled: 0 },
      ];
    }

    match.status = 'SETUP';
    match.innings1.status = 'NOT_STARTED';

    await match.save();

    res.json(match.toPublicJSON());
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/matches/:matchId/start
 * Start match (transition to LIVE)
 */
router.post('/:matchId/start', mutationLimiter, authMiddleware, async (req, res, next) => {
  try {
    const match = await Match.findOne({ publicId: req.params.matchId });
    if (!match) return res.status(404).json({ error: 'Match not found' });

    // Verify scorer token
    if (!verifyToken(req.scorerToken, match.scorerTokenHash)) {
      return res.status(401).json({ error: 'Invalid scorer token' });
    }

    if (match.status !== 'SETUP') {
      return res.status(400).json({ error: 'Match must be in SETUP state to start' });
    }

    if (!match.innings1.activeStrikerId || !match.innings1.activeBowlerId) {
      return res.status(400).json({ error: 'Opening batters and bowler must be set' });
    }

    match.status = 'LIVE';
    match.innings1.status = 'IN_PROGRESS';

    await match.save();

    broadcastMatchUpdate(req, match);

    res.json(match.toPublicJSON());
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/matches/:matchId/deliveries
 * Record a delivery
 */
router.post('/:matchId/deliveries', mutationLimiter, authMiddleware, async (req, res, next) => {
  try {
    const match = await Match.findOne({ publicId: req.params.matchId });
    if (!match) return res.status(404).json({ error: 'Match not found' });

    // Verify scorer token
    if (!verifyToken(req.scorerToken, match.scorerTokenHash)) {
      return res.status(401).json({ error: 'Invalid scorer token' });
    }

    if (match.status !== 'LIVE') {
      return res.status(400).json({ error: 'Match is not in LIVE state' });
    }

    const deliveryData = req.body;
    const idempotencyKey = deliveryData.idempotencyKey || generateIdempotencyKey();

    // Check for duplicate idempotency key
    const existingDelivery = await DeliveryEvent.findOne({ idempotencyKey });
    if (existingDelivery) {
      return res.status(409).json({ error: 'Delivery with this idempotency key already exists' });
    }

    const currentInnings = match.currentInnings === 1 ? match.innings1 : match.innings2;

    // Require all three player IDs
    const strikerId = deliveryData.strikerId || currentInnings.activeStrikerId;
    const nonStrikerId = deliveryData.nonStrikerId || currentInnings.activeNonStrikerId;
    const bowlerId = deliveryData.bowlerId || currentInnings.activeBowlerId;

    if (!strikerId || !nonStrikerId || !bowlerId) {
      return res.status(400).json({
        error: 'strikerId, nonStrikerId and bowlerId are required. Call /setup first.',
      });
    }

    const inningsSequence = (await DeliveryEvent.countDocuments({
      matchId: match._id,
      inningsNumber: match.currentInnings,
    })) + 1;

    const isLegalDelivery = deliveryData.isLegalDelivery !== undefined
      ? deliveryData.isLegalDelivery
      : !['wide', 'noBall'].includes(deliveryData.extraType);

    // Create and save delivery event
    const deliveryEvent = new DeliveryEvent({
      matchId: match._id,
      inningsNumber: match.currentInnings,
      sequence: inningsSequence,
      strikerId,
      nonStrikerId,
      bowlerId,
      runsOffBat: deliveryData.runsOffBat || 0,
      extraType: deliveryData.extraType || null,
      extraRuns: deliveryData.extraRuns || 0,
      isWicket: deliveryData.isWicket || false,
      wicket: deliveryData.wicket || null,
      isLegalDelivery,
      idempotencyKey,
    });

    await deliveryEvent.save();

    // Apply to innings state
    scoringEngine.applyDelivery(currentInnings, deliveryEvent, match.oversPerInnings);

    // ── Innings completion checks ───────────────────────────────────────────
    // Check if innings is complete (overs exhausted OR all wickets lost OR target reached)
    let inningsJustCompleted = false;

    // Get team size for all-out detection (default to 11 players if not set)
    const battingTeamSize = match.currentInnings === 1
      ? (match.team1?.players?.length || 11)
      : (match.team2?.players?.length || 11);
    const maxWickets = battingTeamSize - 1; // All out when n-1 wickets fall

    // 1. Overs exhausted
    if (match.oversPerInnings > 0 && currentInnings.legalBalls >= match.oversPerInnings * 6) {
      currentInnings.status = 'COMPLETED';
      inningsJustCompleted = true;
    }

    // 2. All wickets lost (team_size - 1 wickets, or default 10)
    if (currentInnings.wickets >= maxWickets) {
      currentInnings.status = 'COMPLETED';
      inningsJustCompleted = true;
    }

    // 3. Target reached (innings 2 only)
    if (match.currentInnings === 2 && currentInnings.target != null && currentInnings.total >= currentInnings.target) {
      currentInnings.status = 'COMPLETED';
      inningsJustCompleted = true;
      // Auto-complete match when target is chased
      match.status = 'COMPLETED';
      if (!match.result.winner) {
        const wktsRemaining = maxWickets - (match.innings2.wickets || 0);
        match.result = {
          winner: match.innings2.battingTeamName || match.team2.teamName,
          resultText: `${match.innings2.battingTeamName || match.team2.teamName} won by ${wktsRemaining} wicket${wktsRemaining !== 1 ? 's' : ''}`,
          margin: wktsRemaining,
          marginType: 'wickets',
        };
      }
    }

    // 4. First innings completed - transition to INNINGS_BREAK (not auto-start innings 2)
    if (match.currentInnings === 1 && inningsJustCompleted && match.status === 'LIVE') {
      match.status = 'INNINGS_BREAK';
      // Set target for second innings
      match.innings2.target = match.innings1.total + 1;
    }

    // 5. Second innings completed without chasing target - check for tie or match over
    if (match.currentInnings === 2 && inningsJustCompleted && match.status !== 'COMPLETED') {
      const margin = match.innings1.total - (match.innings2.total || 0);

      if (margin === 0) {
        // Match is TIED - offer super over
        match.status = 'TIED';
        match.result = {
          winner: null,
          resultText: 'Match Tied!',
          margin: 0,
          marginType: null, // No margin type for a tie
        };
      } else {
        // Team that batted first wins
        match.status = 'COMPLETED';
        match.result = {
          winner: match.innings1.battingTeamName || match.team1.teamName,
          resultText: `${match.innings1.battingTeamName || match.team1.teamName} won by ${margin} run${margin !== 1 ? 's' : ''}`,
          margin,
          marginType: 'runs',
        };
      }
    }

    match.markModified('innings1');
    match.markModified('innings2');
    await match.save();

    broadcastMatchUpdate(req, match);

    res.json({ match: match.toPublicJSON(), deliveryEvent });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ error: 'Duplicate delivery' });
    }
    next(error);
  }
});

/**
 * POST /api/matches/:matchId/undo
 * Undo last delivery — deletes it then replays the rest to rebuild innings state
 */
router.post('/:matchId/undo', mutationLimiter, authMiddleware, async (req, res, next) => {
  try {
    const match = await Match.findOne({ publicId: req.params.matchId });
    if (!match) return res.status(404).json({ error: 'Match not found' });

    // Verify scorer token
    if (!verifyToken(req.scorerToken, match.scorerTokenHash)) {
      return res.status(401).json({ error: 'Invalid scorer token' });
    }

    if (match.status !== 'LIVE') {
      return res.status(400).json({ error: 'Match is not in LIVE state' });
    }

    // Find most-recent delivery (for active innings)
    const lastDelivery = await DeliveryEvent.findOne({
      matchId: match._id,
      inningsNumber: match.currentInnings,
    }).sort({ sequence: -1 });

    if (!lastDelivery) {
      return res.status(400).json({ error: 'No deliveries to undo' });
    }

    // Delete it
    await DeliveryEvent.deleteOne({ _id: lastDelivery._id });

    // Recalculate innings state from scratch
    await scoringEngine.recalculateInnings(match, match.currentInnings);

    // If the innings was marked COMPLETED after recalc, reopen it if appropriate
    const innings = match.currentInnings === 1 ? match.innings1 : match.innings2;
    if (innings.status === 'COMPLETED') {
      const oversNotDone = match.oversPerInnings === 0 || innings.legalBalls < match.oversPerInnings * 6;
      const wicketsNotOut = innings.wickets < 10;
      const targetNotReached = match.currentInnings === 1 || !innings.target || innings.total < innings.target;
      if (oversNotDone && wicketsNotOut && targetNotReached) {
        innings.status = 'IN_PROGRESS';
      }
    }

    match.markModified('innings1');
    match.markModified('innings2');
    await match.save();

    broadcastMatchUpdate(req, match);

    res.json({ message: 'Delivery undone', match: match.toPublicJSON() });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/matches/:matchId/select-batter
 * Select new batter after wicket
 */
router.post('/:matchId/select-batter', mutationLimiter, authMiddleware, async (req, res, next) => {
  try {
    const match = await Match.findOne({ publicId: req.params.matchId });
    if (!match) return res.status(404).json({ error: 'Match not found' });

    // Verify scorer token
    if (!verifyToken(req.scorerToken, match.scorerTokenHash)) {
      return res.status(401).json({ error: 'Invalid scorer token' });
    }

    const { playerId, displayName } = req.body;
    const currentInnings = match.currentInnings === 1 ? match.innings1 : match.innings2;

    // Add new batter if not already tracked
    const existing = currentInnings.batters.find(b => b.playerId === playerId);
    if (!existing) {
      currentInnings.batters.push({
        playerId,
        displayName: displayName || playerId,
        runs: 0,
        ballsFaced: 0,
        fours: 0,
        sixes: 0,
        isOut: false,
      });
    }

    currentInnings.activeStrikerId = playerId;
    currentInnings.needNewBatter = false;

    match.markModified('innings1');
    match.markModified('innings2');
    await match.save();

    broadcastMatchUpdate(req, match);

    res.json(match.toPublicJSON());
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/matches/:matchId/change-bowler
 * Change bowler (required at start of every new over)
 */
router.post('/:matchId/change-bowler', mutationLimiter, authMiddleware, async (req, res, next) => {
  try {
    const match = await Match.findOne({ publicId: req.params.matchId });
    if (!match) return res.status(404).json({ error: 'Match not found' });

    // Verify scorer token
    if (!verifyToken(req.scorerToken, match.scorerTokenHash)) {
      return res.status(401).json({ error: 'Invalid scorer token' });
    }

    const { playerId, displayName } = req.body;
    const currentInnings = match.currentInnings === 1 ? match.innings1 : match.innings2;

    currentInnings.activeBowlerId = playerId;

    // Add bowler if not already tracked
    const bowlerExists = currentInnings.bowlers.some(b => b.playerId === playerId);
    if (!bowlerExists) {
      currentInnings.bowlers.push({
        playerId,
        displayName: displayName || playerId,
        legalBallsBowled: 0,
        oversBowled: '0',
        maidens: 0,
        runsConceded: 0,
        wickets: 0,
        widesBowled: 0,
        noBallsBowled: 0,
      });
    }

    currentInnings.needNewBowler = false;

    match.markModified('innings1');
    match.markModified('innings2');
    await match.save();

    broadcastMatchUpdate(req, match);

    res.json(match.toPublicJSON());
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/matches/:matchId/start-innings
 * Start innings 2 (chase)
 */
router.post('/:matchId/start-innings', mutationLimiter, authMiddleware, async (req, res, next) => {
  try {
    const match = await Match.findOne({ publicId: req.params.matchId });
    if (!match) return res.status(404).json({ error: 'Match not found' });

    // Verify scorer token
    if (!verifyToken(req.scorerToken, match.scorerTokenHash)) {
      return res.status(401).json({ error: 'Invalid scorer token' });
    }

    // Allow starting innings 2 if innings 1 is completed OR match is in INNINGS_BREAK
    if (match.innings1.status !== 'COMPLETED' && match.status !== 'INNINGS_BREAK') {
      return res.status(400).json({ error: 'Innings 1 must be completed first' });
    }

    const { openingBatters, bowler } = req.body;

    // FIX: Determine batting and bowling teams correctly for second innings
    // The team that batted first in innings1 now bowls, and vice versa
    const firstInningsBattingTeam = match.innings1.battingTeamName;
    const isTeam1BattingFirst = firstInningsBattingTeam === match.team1?.teamName;

    const battingTeam = isTeam1BattingFirst ? match.team2 : match.team1;
    const bowlingTeam = isTeam1BattingFirst ? match.team1 : match.team2;

    match.currentInnings = 2;
    match.status = 'LIVE';
    match.innings2.battingTeamId = battingTeam.teamId;
    match.innings2.bowlingTeamId = bowlingTeam.teamId;
    match.innings2.battingTeamName = battingTeam.teamName;
    match.innings2.bowlingTeamName = bowlingTeam.teamName;
    match.innings2.target = match.innings1.total + 1; // target = score + 1 to win
    match.innings2.status = 'IN_PROGRESS';

    if (openingBatters && openingBatters.length === 2) {
      const s0 = openingBatters[0];
      const s1 = openingBatters[1];

      let strikerId, strikerName, nonStrikerId, nonStrikerName;

      if (typeof s0 === 'string') {
        strikerId = s0;
        strikerName = s0;
      } else {
        strikerId = s0.playerId;
        strikerName = s0.displayName || s0.playerId;
      }

      if (typeof s1 === 'string') {
        nonStrikerId = s1;
        nonStrikerName = s1;
      } else {
        nonStrikerId = s1.playerId;
        nonStrikerName = s1.displayName || s1.playerId;
      }

      match.innings2.activeStrikerId = strikerId;
      match.innings2.activeNonStrikerId = nonStrikerId;
      match.innings2.batters = [
        { playerId: strikerId, displayName: strikerName, runs: 0, ballsFaced: 0, fours: 0, sixes: 0, isOut: false },
        { playerId: nonStrikerId, displayName: nonStrikerName, runs: 0, ballsFaced: 0, fours: 0, sixes: 0, isOut: false },
      ];
    }

    if (bowler) {
      let bowlerPlayerId, bowlerDisplayName;

      if (typeof bowler === 'string') {
        bowlerPlayerId = bowler;
        bowlerDisplayName = bowler;
      } else {
        bowlerPlayerId = bowler.playerId;
        bowlerDisplayName = bowler.displayName || bowler.playerId;
      }

      match.innings2.activeBowlerId = bowlerPlayerId;
      match.innings2.bowlers = [
        { playerId: bowlerPlayerId, displayName: bowlerDisplayName, legalBallsBowled: 0, oversBowled: '0', maidens: 0, runsConceded: 0, wickets: 0, widesBowled: 0, noBallsBowled: 0 },
      ];
    }

    match.markModified('innings2');
    await match.save();

    broadcastMatchUpdate(req, match);

    res.json(match.toPublicJSON());
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/matches/:matchId/start-super-over
 * Start super over for tied match
 */
router.post('/:matchId/start-super-over', mutationLimiter, authMiddleware, async (req, res, next) => {
  try {
    const match = await Match.findOne({ publicId: req.params.matchId });
    if (!match) return res.status(404).json({ error: 'Match not found' });

    // Verify scorer token
    if (!verifyToken(req.scorerToken, match.scorerTokenHash)) {
      return res.status(401).json({ error: 'Invalid scorer token' });
    }

    if (match.status !== 'TIED') {
      return res.status(400).json({ error: 'Match must be tied to start super over' });
    }

    const { openingBatters, bowler, battingTeam, bowlingTeam } = req.body;

    // Initialize super over innings
    match.hasSuperOver = true;
    match.status = 'SUPER_OVER';
    match.currentInnings = 1; // Reset to 1 for super over tracking

    // Super Over 1 - team that batted second in main match bats first
    match.superOver1 = {
      battingTeamName: battingTeam || match.innings2.battingTeamName,
      bowlingTeamName: bowlingTeam || match.innings1.battingTeamName,
      total: 0,
      wickets: 0,
      legalBalls: 0,
      overs: '0.0',
      extras: { wides: 0, noBalls: 0, byes: 0, legByes: 0, penalty: 0 },
      status: 'IN_PROGRESS',
      batters: [],
      bowlers: [],
      lastBallSummary: [],
    };

    if (openingBatters && openingBatters.length === 2) {
      const s0 = openingBatters[0];
      const s1 = openingBatters[1];

      match.superOver1.activeStrikerId = s0.playerId;
      match.superOver1.activeNonStrikerId = s1.playerId;
      match.superOver1.batters = [
        { playerId: s0.playerId, displayName: s0.displayName || s0.playerId, runs: 0, ballsFaced: 0, fours: 0, sixes: 0, isOut: false },
        { playerId: s1.playerId, displayName: s1.displayName || s1.playerId, runs: 0, ballsFaced: 0, fours: 0, sixes: 0, isOut: false },
      ];
    }

    if (bowler) {
      match.superOver1.activeBowlerId = bowler.playerId;
      match.superOver1.bowlers = [
        { playerId: bowler.playerId, displayName: bowler.displayName || bowler.playerId, legalBallsBowled: 0, oversBowled: '0', maidens: 0, runsConceded: 0, wickets: 0, widesBowled: 0, noBallsBowled: 0 },
      ];
    }

    // Super Over 2 - placeholder
    match.superOver2 = {
      battingTeamName: bowlingTeam || match.innings1.battingTeamName,
      bowlingTeamName: battingTeam || match.innings2.battingTeamName,
      total: 0,
      wickets: 0,
      legalBalls: 0,
      overs: '0.0',
      extras: { wides: 0, noBalls: 0, byes: 0, legByes: 0, penalty: 0 },
      status: 'NOT_STARTED',
      batters: [],
      bowlers: [],
      lastBallSummary: [],
      target: null,
    };

    match.markModified('superOver1');
    match.markModified('superOver2');
    await match.save();

    broadcastMatchUpdate(req, match);

    res.json(match.toPublicJSON());
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/matches/:matchId/complete
 * Complete match manually
 */
router.post('/:matchId/complete', mutationLimiter, authMiddleware, async (req, res, next) => {
  try {
    const match = await Match.findOne({ publicId: req.params.matchId });
    if (!match) return res.status(404).json({ error: 'Match not found' });

    // Verify scorer token
    if (!verifyToken(req.scorerToken, match.scorerTokenHash)) {
      return res.status(401).json({ error: 'Invalid scorer token' });
    }

    match.status = 'COMPLETED';

    // Set result if not already set
    if (!match.result.winner) {
      const team1Score = match.innings1.total;
      const team2Score = match.innings2.total || 0;
      const target = match.innings2.target || team1Score + 1;

      if (team2Score >= target) {
        const wktsRemaining = 10 - (match.innings2.wickets || 0);
        match.result = {
          winner: match.innings2.battingTeamName || match.team2.teamName,
          resultText: `${match.innings2.battingTeamName || match.team2.teamName} won by ${wktsRemaining} wicket${wktsRemaining !== 1 ? 's' : ''}`,
          margin: wktsRemaining,
          marginType: 'wickets',
        };
      } else {
        const margin = team1Score - team2Score;
        match.result = {
          winner: match.innings1.battingTeamName || match.team1.teamName,
          resultText: `${match.innings1.battingTeamName || match.team1.teamName} won by ${margin} run${margin !== 1 ? 's' : ''}`,
          margin,
          marginType: 'runs',
        };
      }
    }

    await match.save();

    broadcastMatchUpdate(req, match);

    res.json(match.toPublicJSON());
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/matches/:matchId/scorecard
 * Get detailed scorecard
 */
router.get('/:matchId/scorecard', readLimiter, async (req, res, next) => {
  try {
    const match = await Match.findOne({ publicId: req.params.matchId });
    if (!match) return res.status(404).json({ error: 'Match not found' });

    res.json(match.toPublicJSON());
  } catch (error) {
    next(error);
  }
});

module.exports = router;
