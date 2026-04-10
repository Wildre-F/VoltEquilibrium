const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const jwt = require('jsonwebtoken');
const pool = require('./db');

if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET environment variable is required');
}
const JWT_SECRET = process.env.JWT_SECRET;

async function findOrCreateUser(email, username) {
    const existing = await pool.query(
        'SELECT id, username, email FROM users WHERE email = $1',
        [email]
    );

    if (existing.rows.length > 0) return existing.rows[0];

    const result = await pool.query(
        `INSERT INTO users (username, email, password)
         VALUES ($1, $2, $3)
         RETURNING id, username, email`,
        [username, email, '!']
    );

    return result.rows[0];
}

passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: '/auth/google/callback'
}, async (accessToken, refreshToken, profile, done) => {
    try {
        const email = profile.emails[0].value;
        const username = profile.displayName;
        const user = await findOrCreateUser(email, username);
        done(null, user);
    } catch (error) {
        done(error, null);
    }
}));

module.exports = passport;