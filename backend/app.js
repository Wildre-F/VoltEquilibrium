require('dotenv').config();

const express = require('express');
const app = express();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const pool = require('./db');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'mysecretkey';

app.use(cors());
app.use(express.json());

// Basic endpoint to check if server is running
app.get('/', (req, res) => {
    res.send('Backend server is running');
});

// Test endpoint to verify API is working
app.get('/api/test', (req, res) => {
    res.status(200).json({
        success: true,
        message: 'API is working',
        version: '1.0'
    });
});

// Registration endpoint
app.post('/api/register', async (req, res) => {
    try {
        const { username, email, password } = req.body;

        const cleanUsername = username?.trim();
        const cleanEmail = email?.trim().toLowerCase();

        if (!cleanUsername || !cleanEmail || !password) {
            return res.status(400).json({
                success: false,
                message: 'Username, email, and password are required'
            });
        }

        const existingUser = await pool.query(
            'SELECT id FROM users WHERE email = $1',
            [cleanEmail]
        );

        if (existingUser.rows.length > 0) {
            return res.status(409).json({
                success: false,
                message: 'Email already exists'
            });
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        const result = await pool.query(
            `INSERT INTO users (username, email, password)
             VALUES ($1, $2, $3)
             RETURNING id, username, email`,
            [cleanUsername, cleanEmail, hashedPassword]
        );

        return res.status(201).json({
            success: true,
            message: 'User registered successfully',
            data: result.rows[0]
        });

    } catch (error) {
        console.error('Register error:', error.message);

        return res.status(500).json({
            success: false,
            message: 'Server error during registration'
        });
    }
});

// Login endpoint
app.post('/api/login', async (req, res, next) => {
    try {
        const { email, password } = req.body;

        const cleanEmail = email?.trim().toLowerCase();

        if (!cleanEmail || !password) {
            return res.status(400).json({
                success: false,
                message: 'Email and password are required'
            });
        }

        const result = await pool.query(
            'SELECT id, username, email, password FROM users WHERE email = $1',
            [cleanEmail]
        );

        const user = result.rows[0];

        if (!user) {
            return res.status(401).json({
                success: false,
                message: 'Invalid email or password'
            });
        }

        const isPasswordMatch = await bcrypt.compare(password, user.password);

        if (!isPasswordMatch) {
            return res.status(401).json({
                success: false,
                message: 'Invalid email or password'
            });
        }

        const token = jwt.sign(
            {
                id: user.id,
                email: user.email,
                username: user.username
            },
            JWT_SECRET,
            { expiresIn: '1h' }
        );

        return res.status(200).json({
            success: true,
            message: 'Login successful',
            token
        });
    } catch (error) {
        next(error);
    }
});

// Middleware to authenticate token for protected routes
function authenticateToken(req, res, next) {
    try {
        const authHeader = req.headers.authorization;

        if (!authHeader) {
            return res.status(401).json({
                success: false,
                message: 'Access token required'
            });
        }

        if (!authHeader.startsWith('Bearer ')) {
            return res.status(401).json({
                success: false,
                message: 'Authorisation header must start with Bearer'
            });
        }

        const token = authHeader.split(' ')[1];

        if (!token) {
            return res.status(401).json({
                success: false,
                message: 'Token not provided'
            });
        }

        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;

        next();
    } catch (error) {
        return res.status(403).json({
            success: false,
            message: 'Invalid or expired token'
        });
    }
}

// Protected dashboard endpoint
app.get('/api/dashboard', authenticateToken, (req, res) => {
    res.json({
        success: true,
        message: 'Welcome to the dashboard',
        user: req.user
    });
});

// Protected profile endpoint
app.get('/api/profile', authenticateToken, async (req, res, next) => {
    try {
        const result = await pool.query(
            'SELECT id, username, email, created_at FROM users WHERE id = $1',
            [req.user.id]
        );

        const user = result.rows[0];

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        return res.status(200).json({
            success: true,
            message: 'Profile retrieved successfully',
            data: user
        });
    } catch (error) {
        next(error);
    }
});

// Database test endpoint
app.get('/api/db-test', async (req, res) => {
    try {
        const result = await pool.query('SELECT NOW()');

        res.status(200).json({
            success: true,
            message: 'Database connection works',
            data: result.rows[0]
        });
    } catch (error) {
        console.error('Database test error:', error.message);

        res.status(500).json({
            success: false,
            message: 'Database connection failed'
        });
    }
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        success: false,
        message: 'Route not found'
    });
});

// General error handler
app.use((error, req, res, next) => {
    console.error('Server error:', error.message);

    res.status(500).json({
        success: false,
        message: 'Internal server error'
    });
});



// Start the server
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});