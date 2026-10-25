require('dotenv').config();

const env = {
  PORT: process.env.PORT || 5000,
  MONGODB_URI: process.env.MONGODB_URI || 'mongodb://localhost:27017/localscore',
  CORS_ORIGIN: process.env.CORS_ORIGIN || 'http://localhost:5173',
  SCORER_TOKEN_SECRET: process.env.SCORER_TOKEN_SECRET || 'dev-secret-change-in-production',
  NODE_ENV: process.env.NODE_ENV || 'development',
};

module.exports = env;
