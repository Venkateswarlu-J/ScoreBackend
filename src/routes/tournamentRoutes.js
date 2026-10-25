const express = require('express');
const Tournament = require('../models/Tournament');
const Team = require('../models/Team');
const Match = require('../models/Match');
const authMiddleware = require('../middleware/auth');
const { mutationLimiter, readLimiter } = require('../middleware/rateLimiter');

const router = express.Router();

/**
 * POST /api/tournaments
 * Create a tournament
 */
router.post('/', mutationLimiter, async (req, res, next) => {
  try {
    const { name, teams, pointsConfig } = req.body;

    if (!name || !teams || teams.length < 2) {
      return res.status(400).json({ error: 'Tournament requires name and at least 2 teams' });
    }

    // Create team documents
    const createdTeams = [];
    for (const teamData of teams) {
      const team = new Team({
        name: teamData.name,
        shortName: teamData.shortName || teamData.name.substring(0, 5),
        players: [],
      });
      await team.save();
      createdTeams.push(team._id);
    }

    // Create tournament
    const tournament = new Tournament({
      name,
      teams: createdTeams,
      status: 'UPCOMING',
      pointsConfig: pointsConfig || {
        win: 2,
        loss: 0,
        tie: 1,
        noResult: 1,
        draw: 1,
      },
    });

    await tournament.save();

    res.status(201).json(tournament);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/tournaments
 * List all tournaments
 */
router.get('/', readLimiter, async (req, res, next) => {
  try {
    const tournaments = await Tournament.find().populate('teams').sort({ createdAt: -1 });
    res.json(tournaments);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/tournaments/:tournamentId
 * Get tournament with matches and standings
 */
router.get('/:tournamentId', readLimiter, async (req, res, next) => {
  try {
    const tournament = await Tournament.findById(req.params.tournamentId).populate('teams');
    if (!tournament) {
      return res.status(404).json({ error: 'Tournament not found' });
    }

    // Get all matches for this tournament
    const matches = await Match.find({ tournamentId: req.params.tournamentId });

    // Calculate standings
    const standings = {};
    for (const team of tournament.teams) {
      standings[team._id] = {
        teamId: team._id,
        teamName: team.name,
        played: 0,
        won: 0,
        lost: 0,
        tied: 0,
        noResult: 0,
        points: 0,
        runsFor: 0,
        runsAgainst: 0,
        netRunRate: 0,
      };
    }

    // Process matches
    const pointsConfig = tournament.pointsConfig;
    for (const match of matches) {
      if (match.status !== 'COMPLETED' || !match.result.winner) continue;

      const team1Id = match.team1.teamId;
      const team2Id = match.team2.teamId;
      const team1Score = match.innings1.total;
      const team2Score = match.innings2?.total || 0;

      if (standings[team1Id]) standings[team1Id].runsFor += team1Score;
      if (standings[team1Id]) standings[team1Id].runsAgainst += team2Score;
      if (standings[team2Id]) standings[team2Id].runsFor += team2Score;
      if (standings[team2Id]) standings[team2Id].runsAgainst += team1Score;

      if (standings[team1Id]) standings[team1Id].played += 1;
      if (standings[team2Id]) standings[team2Id].played += 1;

      if (match.result.winner === match.team1.teamName) {
        if (standings[team1Id]) standings[team1Id].won += 1;
        if (standings[team1Id]) standings[team1Id].points += pointsConfig.win;
        if (standings[team2Id]) standings[team2Id].lost += 1;
        if (standings[team2Id]) standings[team2Id].points += pointsConfig.loss;
      } else if (match.result.winner === match.team2.teamName) {
        if (standings[team2Id]) standings[team2Id].won += 1;
        if (standings[team2Id]) standings[team2Id].points += pointsConfig.win;
        if (standings[team1Id]) standings[team1Id].lost += 1;
        if (standings[team1Id]) standings[team1Id].points += pointsConfig.loss;
      }
    }

    // Sort by points
    const sortedStandings = Object.values(standings).sort((a, b) => b.points - a.points);

    res.json({
      tournament,
      matches,
      standings: sortedStandings,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/tournaments/:tournamentId/matches
 * Create a match in tournament
 */
router.post('/:tournamentId/matches', mutationLimiter, async (req, res, next) => {
  try {
    const tournament = await Tournament.findById(req.params.tournamentId);
    if (!tournament) {
      return res.status(404).json({ error: 'Tournament not found' });
    }

    const { team1, team2, oversPerInnings } = req.body;

    if (!team1 || !team2 || !oversPerInnings) {
      return res.status(400).json({ error: 'Team names and overs per innings are required' });
    }

    // Generate match (reuse match creation logic from matchRoutes)
    const { nanoid } = require('nanoid');
    const { generateToken, hashToken } = require('../utils/generateToken');

    const publicId = nanoid(10);
    const scorerToken = generateToken();
    const scorerTokenHash = hashToken(scorerToken);

    const match = new Match({
      publicId,
      tournamentId: req.params.tournamentId,
      team1: { teamName: team1, players: [] },
      team2: { teamName: team2, players: [] },
      oversPerInnings: parseInt(oversPerInnings),
      status: 'CREATED',
      currentInnings: 1,
      innings1: {
        battingTeamName: team1,
        bowlingTeamName: team2,
        total: 0,
        wickets: 0,
        legalBalls: 0,
        extras: { wides: 0, noBalls: 0, byes: 0, legByes: 0, penalty: 0 },
        overs: '0.0',
        status: 'NOT_STARTED',
        batters: [],
        bowlers: [],
        lastBallSummary: [],
      },
      innings2: {
        battingTeamName: team2,
        bowlingTeamName: team1,
        total: 0,
        wickets: 0,
        legalBalls: 0,
        extras: { wides: 0, noBalls: 0, byes: 0, legByes: 0, penalty: 0 },
        overs: '0.0',
        status: 'NOT_STARTED',
        batters: [],
        bowlers: [],
        lastBallSummary: [],
      },
      result: { winner: null, resultText: null },
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

module.exports = router;
