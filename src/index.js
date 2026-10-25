require('dotenv').config();

console.log('🏏 LocalScore - Built by JV');
console.log('Copyright © 2026 Javvaji Venkateswarlu. All rights reserved.\n');

const express = require('express');
const http = require('http');
const { Server: SocketIOServer } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const mongoose = require('mongoose');

const env = require('./config/env');
const connectDB = require('./config/db');
const setupMatchSocket = require('./socket/matchSocket');
const errorHandler = require('./middleware/errorHandler');
const { mutationLimiter, readLimiter } = require('./middleware/rateLimiter');

const matchRoutes = require('./routes/matchRoutes');
const tournamentRoutes = require('./routes/tournamentRoutes');

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: {
    origin: env.CORS_ORIGIN,
    credentials: true,
  },
});

// ========== MIDDLEWARE ==========

// Security
app.use(helmet());

// Logging
app.use(morgan('dev'));

// CORS
app.use(cors({
  origin: env.CORS_ORIGIN,
  credentials: true,
}));

// Body parser
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ limit: '10kb', extended: true }));

// ========== DATABASE CONNECTION ==========

let mongoConnected = false;

async function initializeDatabase() {
  try {
    if (env.NODE_ENV !== 'test') {
      await connectDB();
      mongoConnected = true;
      console.log('Database initialized successfully');
    }
  } catch (error) {
    console.error('Database initialization failed:', error.message);
    if (env.NODE_ENV !== 'test') {
      process.exit(1);
    }
  }
}

// ========== ROUTES ==========

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    mongodb: mongoConnected ? 'connected' : 'disconnected',
  });
});

// API routes
app.use('/api/matches', readLimiter, matchRoutes);
app.use('/api/tournaments', readLimiter, tournamentRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use(errorHandler);

// ========== SOCKET.IO SETUP ==========

// Attach io to app so Express routes can emit via req.app.get('io')
app.set('io', io);

setupMatchSocket(io);

// ========== SERVER START ==========

const PORT = env.PORT || 5000;

async function start() {
  try {
    // Initialize database
    await initializeDatabase();

    // Start server
    server.listen(PORT, () => {
      console.log(`✓ LocalScore server running on port ${PORT}`);
      console.log(`✓ Environment: ${env.NODE_ENV}`);
      console.log(`✓ CORS origin: ${env.CORS_ORIGIN}`);
    });
  } catch (error) {
    console.error('Server startup failed:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    if (mongoConnected) {
      mongoose.connection.close();
    }
    process.exit(0);
  });
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    if (mongoConnected) {
      mongoose.connection.close();
    }
    process.exit(0);
  });
});

// Start the server
if (require.main === module) {
  start();
}

module.exports = { app, server, io };
