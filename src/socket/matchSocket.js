const Match = require('../models/Match');
const { verifyToken } = require('../utils/generateToken');

/**
 * Setup Socket.IO for match live updates
 * @param {Object} io - Socket.IO server instance
 */
function setupMatchSocket(io) {
  io.on('connection', (socket) => {
    console.log(`Client connected: ${socket.id}`);

    /**
     * Join a match room — accepts both event name styles:
     *   'joinMatch'  { publicId, scorerToken? }  (original)
     *   'join-match' { matchId }                  (frontend uses matchId = publicId)
     */
    async function handleJoinMatch(data) {
      try {
        // Normalise: frontend sends { matchId }, server prefers { publicId }
        const publicId = data.publicId || data.matchId;
        const scorerToken = data.scorerToken || null;

        if (!publicId) {
          return socket.emit('error', { message: 'publicId (or matchId) required' });
        }

        const match = await Match.findOne({ publicId });
        if (!match) {
          return socket.emit('error', { message: 'Match not found' });
        }

        // Verify scorer token if provided
        let isScorer = false;
        if (scorerToken) {
          isScorer = verifyToken(scorerToken, match.scorerTokenHash);
          if (!isScorer) {
            console.warn(`Invalid scorer token for match ${publicId}`);
          }
        }

        // Join room
        const roomName = `match:${publicId}`;
        socket.join(roomName);

        // Store match info in socket for later broadcasts
        socket.matchId = match._id;
        socket.publicId = publicId;
        socket.isScorer = isScorer;

        // Send current match state to the joining client
        socket.emit('matchState', match.toPublicJSON());

        // Notify others in the room
        socket.to(roomName).emit('userJoined', {
          message: `User joined match ${publicId}`,
          isScorer,
        });

        console.log(`Socket ${socket.id} joined room ${roomName}`);
      } catch (error) {
        socket.emit('error', { message: error.message });
      }
    }

    // Support both event name conventions
    socket.on('joinMatch', handleJoinMatch);
    socket.on('join-match', handleJoinMatch);

    /**
     * Manual score-update push from scorer (legacy — delivery route now broadcasts automatically)
     */
    socket.on('scoreUpdate', async (data) => {
      try {
        if (!socket.isScorer) {
          return socket.emit('error', { message: 'Not authorized to update score' });
        }

        if (!socket.publicId) {
          return socket.emit('error', { message: 'Not in a match room' });
        }

        const match = await Match.findOne({ publicId: socket.publicId });
        if (!match) {
          return socket.emit('error', { message: 'Match not found' });
        }

        const roomName = `match:${socket.publicId}`;
        io.to(roomName).emit('scoreUpdate', match.toPublicJSON());

        console.log(`Score update broadcast for match ${socket.publicId}`);
      } catch (error) {
        socket.emit('error', { message: error.message });
      }
    });

    /**
     * Ping/pong for connection health check
     */
    socket.on('ping', () => {
      socket.emit('pong');
    });

    /**
     * Handle disconnect
     */
    socket.on('disconnect', () => {
      console.log(`Client disconnected: ${socket.id}`);
      if (socket.publicId) {
        const roomName = `match:${socket.publicId}`;
        socket.to(roomName).emit('userLeft', { message: 'User disconnected' });
      }
    });

    /**
     * Handle reconnect — re-send current match state
     */
    socket.on('reconnect', async (data) => {
      try {
        const publicId = data.publicId || data.matchId;
        if (publicId) {
          const match = await Match.findOne({ publicId });
          if (match) {
            socket.emit('matchState', match.toPublicJSON());
            console.log(`Socket ${socket.id} reconnected to match ${publicId}`);
          }
        }
      } catch (error) {
        socket.emit('error', { message: error.message });
      }
    });
  });
}

module.exports = setupMatchSocket;
