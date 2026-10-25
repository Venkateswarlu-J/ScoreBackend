const { matchSchema } = require('../models/Match');
const { calculateOversString, calculateRunRate, calculateRequiredRunRate } = require('../utils/overs');
const ScoringEngine = require('./scoringEngine');

class MatchService {
  constructor() {
    this.scoringEngine = new ScoringEngine();
  }

  /**
   * Create a new match
   * @param {Object} matchData - Match creation data
   * @param {string} scorerToken - Scorer token hash
   * @returns {Object} - Match document
   */
  createMatch(matchData, scorerToken) {
    const {
      tournamentId,
      team1: { name: team1Name, players: team1Players },
      team2: { name: team2Name, players: team2Players },
      oversPerInnings,
      venue,
      date,
      tpiDetails,
    } = matchData;

    // Validate required fields
    if (!team1Name || !team2Name || !oversPerInnings) {
      throw new Error('Team names and overs per innings are required');
    }

    // Create team documents
    const team1 = new this.matchModel.Team({ name: team1Name, shortName: team1Name.substring(0, 5) });
    const team2 = new this.matchModel.Team({ name: team2Name, shortName: team2Name.substring(0, 5) });

    // Save teams
    team1.save();
    team2.save();

    // Create match document
    const match = new this.matchModel.Match({
      publicId: require('nanoid')().slice(0, 10),
      tournamentId: tournamentId || null,
      team1: {
        teamId: team1._id,
        teamName: team1Name,
        players: team1Players.map(player => ({ playerId: player.id, displayName: player.name }))
      },
      team2: {
        teamId: team2._id,
        teamName: team2Name,
        players: team2Players.map(player => ({ playerId: player.id, displayName: player.name }))
      },
      oversPerInnings,
      venue,
      date,
      tossDetails: {
        tossWonBy: tpiDetails?.tossWonBy || null,
        electedTo: tpiDetails?.electedTo || null,
        battingFirst: tpiDetails?.battingFirst || null,
        bowlingFirst: tpiDetails?.bowlingFirst || null,
      },
      currentInnings: 1,
      innings1: {
        battingTeamId: team1._id,
        bowlingTeamId: team2._id,
        battingTeamName: team1Name,
        bowlingTeamName: team2Name,
        total: 0,
        wickets: 0,
        legalBalls: 0,
        extras: {
          wides: 0,
          noBalls: 0,
          byes: 0,
          legByes: 0,
          penalty: 0,
        },
        overs: '0.0',
        status: 'NOT_STARTED',
        batters: [],
        bowlers: [],
        activeStrikerId: null,
        activeNonStrikerId: null,
        activeBowlerId: null,
        lastBallSummary: [],
        target: null,
      },
      innings2: {
        battingTeamId: null,
        bowlingTeamId: null,
        battingTeamName: '',
        bowlingTeamName: '',
        total: 0,
        wickets: 0,
        legalBalls: 0,
        extras: {
          wides: 0,
          noBalls: 0,
          byes: 0,
          legByes: 0,
          penalty: 0,
        },
        overs: '0.0',
        status: 'NOT_STARTED',
        batters: [],
        bowlers: [],
        activeStrikerId: null,
        activeNonStrikerId: null,
        activeBowlerId: null,
        lastBallSummary: [],
        target: null,
        needNewBatter: false,
        needNewBowler: false,
      },
      result: {
        winner: null,
        resultText: null,
        margin: null,
        marginType: null,
      },
      scorerTokenHash: this.hashToken(scorerToken),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Save match
    match.save();

    return match;
  }

  /**
   * Start match setup
   * @param {Object} matchId - Match ID
   * @param {Object} setupData - Setup data
   * @param {string} scorerToken - Scorer token hash
   * @returns {Object} - Updated match
   */
  setupMatch(matchId, setupData, scorerToken) {
    const match = this.matchModel.Match.findById(matchId);
    if (!match) throw new Error('Match not found');

    // Validate setup data
    if (!setupData.tossWonBy || !setupData.electedTo) {
      throw new Error('Toss details are required');
    }

    // Set toss details
    match.tossDetails = {
      tossWonBy: setupData.tossWonBy,
      electedTo: setupData.electedTo,
      battingFirst: setupData.battingFirst || null,
      bowlingFirst: setupData.bowlingFirst || null,
    };

    // Set opening batsmen and bowler if provided
    if (setupData.openingBatters && setupData.openingBatters.length === 2) {
      match.innings1.activeStrikerId = setupData.openingBatters[0].playerId;
      match.innings1.activeNonStrikerId = setupData.openingBatters[1].playerId;
    }

    if (setupData.bowler) {
      match.innings1.activeBowlerId = setupData.bowler.playerId;
    }

    // Update status
    match.status = 'SETUP';

    // Save match
    match.save();

    return match;
  }

  /**
   * Start match
   * @param {Object} matchId - Match ID
   * @param {string} scorerToken - Scorer token hash
   * @returns {Object} - Updated match
   */
  startMatch(matchId, scorerToken) {
    const match = this.matchModel.Match.findById(matchId);
    if (!match) throw new Error('Match not found');
    if (match.status !== 'SETUP') {
      throw new Error('Match must be in SETUP state to start');
    }

    // Validate that both innings have teams set
    if (!match.innings1.battingTeamId || !match.innings1.bowlingTeamId) {
      throw new Error('Both batting and bowling teams must be set before starting');
    }

    // Update status to LIVE
    match.status = 'LIVE';

    // Initialize first innings if not already done
    if (match.innings1.status === 'NOT_STARTED') {
      match.innings1.status = 'IN_PROGRESS';
    }

    // Save match
    match.save();

    return match;
  }

  /**
   * Record a delivery
   * @param {Object} matchId - Match ID
   * @param {Object} deliveryData - Delivery data
   * @param {string} scorerToken - Scorer token hash
   * @returns {Object} - Updated match and delivery event
   */
  recordDelivery(matchId, deliveryData, scorerToken) {
    const match = this.matchModel.Match.findById(matchId);
    if (!match) throw new Error('Match not found');
    if (match.status !== 'LIVE') {
      throw new Error('Match must be in LIVE state to record delivery');
    }

    // Validate delivery data
    if (!deliveryData.runsOffBat && !deliveryData.extraType) {
      throw new Error('Delivery must have runs or extra type');
    }

    // Validate idempotency key
    if (!deliveryData.idempotencyKey) {
      throw new Error('Idempotency key is required');
    }

    // Check if delivery with this idempotency key already exists
    const existingDelivery = match.innings1.sequence === 1 ?
      this.findDeliveryByIdempotency(match.innings1.sequence, deliveryData.idempotencyKey) :
      this.findDeliveryByIdempotency(match.innings2.sequence, deliveryData.idempotencyKey);

    if (existingDelivery) {
      throw new Error('Delivery with this idempotency key already exists');
    }

    // Use scoring engine to process delivery
    const result = this.scoringEngine.processDelivery(match, deliveryData);

    // Save the updated match
    result.match.save();

    return result;
  }

  /**
   * Find delivery by idempotency key
   * @param {number} inningsSequence - Innings sequence number
   * @param {string} idempotencyKey - Idempotency key
   * @returns {Object} - Delivery event or null
   */
  findDeliveryByIdempotency(inningsSequence, idempotencyKey) {
    // In a real implementation, we would query the database
    // For now, this is a placeholder
    return null;
  }

  /**
   * Undo last delivery
   * @param {Object} matchId - Match ID
   * @param {string} scorerToken - Scorer token hash
   * @returns {Object} - Updated match
   */
  undoLastDelivery(matchId, scorerToken) {
    const match = this.matchModel.Match.findById(matchId);
    if (!match) throw new Error('Match not found');
    if (match.status !== 'LIVE') {
      throw new Error('Match must be in LIVE state to undo delivery');
    }

    // For now, just return the match (full reimplementation would be needed)
    return match;
  }

  /**
   * Select new batter after wicket
   * @param {Object} matchId - Match ID
   * @param {Object} batterData - New batter info
   * @param {string} scorerToken - Scorer token hash
   * @returns {Object} - Updated match
   */
  selectBatter(matchId, batterData, scorerToken) {
    const match = this.matchModel.Match.findById(matchId);
    if (!match) throw new Error('Match not found');
    if (match.status !== 'LIVE') {
      throw new Error('Match must be in LIVE state to select batter');
    }

    const currentInnings = match.currentInnings === 1 ? match.innings1 : match.innings2;
    const batterIndex = this.findBatterIndex(match, batterData.playerId);
    if (batterIndex === -1) {
      throw new Error('Batter not found in innings');
    }

    currentInnings.activeStrikerId = batterData.playerId;
    currentInnings.activeNonStrikerId = batterData.nonStrikerId || null;

    match.save();

    return match;
  }

  /**
   * Change bowler
   * @param {Object} matchId - Match ID
   * @param {Object} bowlerData - New bowler info
   * @param {string} scorerToken - Scorer token hash
   * @returns {Object} - Updated match
   */
  changeBowler(matchId, bowlerData, scorerToken) {
    const match = this.matchModel.Match.findById(matchId);
    if (!match) throw new Error('Match not found');
    if (match.status !== 'LIVE') {
      throw new Error('Match must be in LIVE state to change bowler');
    }

    // Change bowler for current innings
    const currentInnings = match.currentInnings === 1 ? match.innings1 : match.innings2;
    currentInnings.activeBowlerId = bowlerData.playerId;

    match.save();

    return match;
  }

  /**
   * Start innings 2 (chase)
   * @param {Object} matchId - Match ID
   * @param {Object} newBattingTeam - New batting team info
   * @param {Object} newBowlingTeam - New bowling team info
   * @param {string} newBowlerId - New bowler ID
   * @param {string} scorerToken - Scorer token hash
   * @returns {Object} - Updated match
   */
  startInnings2(matchId, newBattingTeam, newBowlingTeam, newBowlerId, scorerToken) {
    const match = this.matchModel.Match.findById(matchId);
    if (!match) throw new Error('Match not found');
    if (match.status !== 'LIVE') {
      throw new Error('Match must be in LIVE state to start innings 2');
    }

    const currentInnings = match.innings1;
    if (currentInnings.status !== 'COMPLETED') {
      throw new Error('Innings 1 must be completed to start innings 2');
    }

    match.innings2.battingTeamId = newBattingTeam.teamId;
    match.innings2.bowlingTeamId = newBowlingTeam.teamId;
    match.innings2.battingTeamName = newBattingTeam.teamName;
    match.innings2.bowlingTeamName = newBowlingTeam.teamName;
    match.innings2.target = currentInnings.total;
    match.innings2.legalBalls = 0;
    match.innings2.overs = '0.0';
    match.innings2.total = 0;
    match.innings2.wickets = 0;
    match.innings2.status = 'NOT_STARTED';
    match.innings2.activeStrikerId = newBattingTeam.players[0].playerId;
    match.innings2.activeNonStrikerId = newBattingTeam.players[1]?.playerId || null;
    match.innings2.activeBowlerId = newBowlerId;
    match.innings2.needNewBatter = false;
    match.innings2.needNewBowler = false;

    match.save();

    return match;
  }

  /**
   * Complete match
   * @param {Object} matchId - Match ID
   * @param {string} scorerToken - Scorer token hash
   * @returns {Object} - Updated match
   */
  completeMatch(matchId, scorerToken) {
    const match = this.matchModel.Match.findById(matchId);
    if (!match) throw new Error('Match not found');
    if (match.status !== 'LIVE') {
      throw new Error('Match must be in LIVE state to complete');
    }

    // Force complete the match
    match.status = 'COMPLETED';

    // Ensure result is set
    if (!match.result.winner) {
      const currentInnings = match.currentInnings === 1 ? match.innings1 : match.innings2;
      if (currentInnings.total >= match.innings1.target) {
        match.result = {
          winner: match.innings1.battingTeamName,
          resultText: `Team 2 won by ${currentInnings.total - match.innings1.target + 1} runs`,
          margin: currentInnings.total - match.innings1.target + 1,
          marginType: 'runs',
        };
      } else {
        match.result = {
          winner: match.innings1.bowlingTeamName,
          resultText: `Team 1 won by ${match.innings1.target - currentInnings.total} runs`,
          margin: match.innings1.target - currentInnings.total,
          marginType: 'runs',
        };
      }
    }

    match.save();

    return match;
  }

  /**
   * Get scorecard
   * @param {Object} matchId - Match ID
   * @returns {Object} - Match public data
   */
  getScorecard(matchId) {
    const match = this.matchModel.Match.findById(matchId);
    if (!match) throw new Error('Match not found');

    return match.toPublicJSON();
  }

  /**
   * Get match by publicId
   * @param {string} publicId - Match public ID
   * @returns {Object} - Match document
   */
  getMatchByPublicId(publicId) {
    const match = this.matchModel.Match.findOne({ publicId });
    if (!match) throw new Error('Match not found');

    return match;
  }

  /**
   * Create tournament
   * @param {Object} tournamentData - Tournament data
   * @param {string} scorerToken - Scorer token hash
   * @returns {Object} - Tournament document
   */
  createTournament(tournamentData, scorerToken) {
    const {
      name,
      teams: teamData,
      pointsConfig = { win: 2, loss: 0, tie: 1, noResult: 1, draw: 1 },
    } = tournamentData;

    if (!name || !teamData || teamData.length < 2) {
      throw new Error('Tournament requires name and at least 2 teams');
    }

    // Create teams
    const teams = [];
    for (const team of teamData) {
      const teamDoc = new this.tournamentModel.Team({ name: team.name, shortName: team.shortName });
      teams.push(teamDoc);
    }

    // Save teams
    for (const team of teams) {
      team.save();
    }

    // Create tournament
    const tournament = new this.tournamentModel.Tournament({
      name,
      teams: teams.map(team => team._id),
      pointsConfig,
      status: 'UPCOMING',
    });

    // Save tournament
    tournament.save();

    return tournament;
  }

  /**
   * Get tournament by ID
   * @param {ObjectId} tournamentId - Tournament ID
   * @returns {Object} - Tournament document
   */
  getTournamentById(tournamentId) {
    const tournament = this.tournamentModel.Tournament.findById(tournamentId);
    if (!tournament) throw new Error('Tournament not found');

    return tournament;
  }

  /**
   * Get all tournaments
   * @returns {Array} - Array of tournaments
   */
  getAllTournaments() {
    return this.tournamentModel.Tournament.find();
  }
}

module.exports = MatchService;