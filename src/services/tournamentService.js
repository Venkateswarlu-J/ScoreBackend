class TournamentService {
  /**
   * Create a tournament
   * @param {Object} tournamentData - Tournament data
   * @returns {Object} - Tournament document
   */
  createTournament(tournamentData) {
    const { name, teams, pointsConfig } = tournamentData;

    if (!name || !teams || teams.length < 2) {
      throw new Error('Tournament requires name and at least 2 teams');
    }

    return {
      name,
      teams,
      pointsConfig: pointsConfig || {
        win: 2,
        loss: 0,
        tie: 1,
        noResult: 1,
        draw: 1,
      },
      status: 'UPCOMING',
      createdAt: new Date(),
    };
  }

  /**
   * Get tournament standings/points table
   * @param {Object} tournament - Tournament document
   * @param {Array} matches - Array of match documents
   * @returns {Array} - Points table with team standings
   */
  getPointsTable(tournament, matches) {
    const pointsConfig = tournament.pointsConfig;
    const standings = {};

    // Initialize standings
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

    // Process each match
    for (const match of matches) {
      if (match.status !== 'COMPLETED' || !match.result.winner) {
        continue;
      }

      const team1Id = match.team1.teamId;
      const team2Id = match.team2.teamId;
      const team1Score = match.innings1.total;
      const team2Score = match.innings2?.total || 0;

      // Update runs for/against
      standings[team1Id].runsFor += team1Score;
      standings[team1Id].runsAgainst += team2Score;
      standings[team2Id].runsFor += team2Score;
      standings[team2Id].runsAgainst += team1Score;

      // Update match results
      standings[team1Id].played += 1;
      standings[team2Id].played += 1;

      if (match.result.winner === match.team1.teamName) {
        standings[team1Id].won += 1;
        standings[team1Id].points += pointsConfig.win;
        standings[team2Id].lost += 1;
        standings[team2Id].points += pointsConfig.loss;
      } else if (match.result.winner === match.team2.teamName) {
        standings[team2Id].won += 1;
        standings[team2Id].points += pointsConfig.win;
        standings[team1Id].lost += 1;
        standings[team1Id].points += pointsConfig.loss;
      } else if (match.result.resultText.includes('tie')) {
        standings[team1Id].tied += 1;
        standings[team1Id].points += pointsConfig.tie;
        standings[team2Id].tied += 1;
        standings[team2Id].points += pointsConfig.tie;
      } else if (match.result.resultText.includes('no result')) {
        standings[team1Id].noResult += 1;
        standings[team1Id].points += pointsConfig.noResult;
        standings[team2Id].noResult += 1;
        standings[team2Id].points += pointsConfig.noResult;
      }
    }

    // Calculate net run rate
    for (const teamId in standings) {
      const team = standings[teamId];
      if (team.runsFor > 0 || team.runsAgainst > 0) {
        team.netRunRate = team.runsFor - team.runsAgainst;
      }
    }

    // Sort by points (descending), then by net run rate (descending)
    return Object.values(standings).sort((a, b) => {
      if (b.points !== a.points) {
        return b.points - a.points;
      }
      return b.netRunRate - a.netRunRate;
    });
  }

  /**
   * Get tournament fixtures/matches
   * @param {Object} tournament - Tournament document
   * @param {Array} matches - Array of match documents for this tournament
   * @returns {Array} - Organized matches by status
   */
  getFixtures(tournament, matches) {
    const fixtures = {
      upcoming: [],
      live: [],
      completed: [],
    };

    for (const match of matches) {
      if (match.status === 'UPCOMING' || match.status === 'CREATED') {
        fixtures.upcoming.push(match);
      } else if (match.status === 'LIVE' || match.status === 'INNINGS_BREAK') {
        fixtures.live.push(match);
      } else if (match.status === 'COMPLETED') {
        fixtures.completed.push(match);
      }
    }

    return fixtures;
  }
}

module.exports = TournamentService;
