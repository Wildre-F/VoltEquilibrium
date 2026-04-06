// ===== Dependencies =====
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");
const fetch = require("node-fetch");

// ===== Internal Modules =====
const pool = require("./db");
const passport = require("./passport");

// ===== App Init =====
const app = express();

// ===== Constants =====
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "mysecretkey";

// ===== Middleware =====
app.use(cors({ origin: process.env.FRONTEND_URL }));
app.use(express.json());
app.use(passport.initialize());

// Prevent caching of protected pages
app.use((req, res, next) => {
  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, private",
  );
  next();
});

// Basic endpoint to check if server is running
app.get("/", (req, res) => {
  res.send("Backend server is running");
});

// Test endpoint to verify API is working
app.get("/api/test", (req, res) => {
  res.status(200).json({
    success: true,
    message: "API is working",
    version: "1.0",
  });
});

// Registration endpoint
app.post("/api/register", async (req, res) => {
  try {
    const { username, email, password } = req.body;

    const cleanUsername = username?.trim();
    const cleanEmail = email?.trim().toLowerCase();

    if (!cleanUsername || !cleanEmail || !password) {
      return res.status(400).json({
        success: false,
        message: "Username, email, and password are required",
      });
    }

    const existingUser = await pool.query(
      "SELECT id FROM users WHERE email = $1",
      [cleanEmail],
    );

    if (existingUser.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: "Email already exists",
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `INSERT INTO users (username, email, password)
             VALUES ($1, $2, $3)
             RETURNING id, username, email`,
      [cleanUsername, cleanEmail, hashedPassword],
    );

    return res.status(201).json({
      success: true,
      message: "User registered successfully",
      data: result.rows[0],
    });
  } catch (error) {
    console.error("Register error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Server error during registration",
    });
  }
});

// Login endpoint
app.post("/api/login", async (req, res, next) => {
  try {
    const { email, password } = req.body;

    const cleanEmail = email?.trim().toLowerCase();

    if (!cleanEmail || !password) {
      return res.status(400).json({
        success: false,
        message: "Email and password are required",
      });
    }

    const result = await pool.query(
      "SELECT id, username, email, password FROM users WHERE email = $1",
      [cleanEmail],
    );

    const user = result.rows[0];

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Account not found, please register first",
      });
    }

    const isPasswordMatch = await bcrypt.compare(password, user.password);

    if (!isPasswordMatch) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
      });
    }

    const token = jwt.sign(
      {
        id: user.id,
        email: user.email,
        username: user.username,
      },
      JWT_SECRET,
      { expiresIn: "1h" },
    );

    return res.status(200).json({
      success: true,
      message: "Login successful",
      token,
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
        message: "Access token required",
      });
    }

    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "Authorisation header must start with Bearer",
      });
    }

    const token = authHeader.split(" ")[1];

    if (!token) {
      return res.status(401).json({
        success: false,
        message: "Token not provided",
      });
    }

    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;

    next();
  } catch (error) {
    return res.status(403).json({
      success: false,
      message: "Invalid or expired token",
    });
  }
}

// Protected dashboard endpoint
app.get("/api/dashboard", authenticateToken, (req, res) => {
  res.json({
    success: true,
    message: "Welcome to the dashboard",
    user: req.user,
  });
});

// Protected profile endpoint
app.get("/api/profile", authenticateToken, async (req, res, next) => {
  try {
    const result = await pool.query(
      "SELECT id, username, email, created_at FROM users WHERE id = $1",
      [req.user.id],
    );

    const user = result.rows[0];

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Profile retrieved successfully",
      data: user,
    });
  } catch (error) {
    next(error);
  }
});

// Database test endpoint
app.get("/api/db-test", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW()");

    res.status(200).json({
      success: true,
      message: "Database connection works",
      data: result.rows[0],
    });
  } catch (error) {
    console.error("Database test error:", error.message);

    res.status(500).json({
      success: false,
      message: "Database connection failed",
    });
  }
});

// Google OAuth
app.get(
  "/auth/google",
  passport.authenticate("google", { scope: ["profile", "email"] }),
);

app.get(
  "/auth/google/callback",
  passport.authenticate("google", {
    session: false,
    failureRedirect: "/login.html",
  }),
  (req, res) => {
    const token = jwt.sign(
      { id: req.user.id, email: req.user.email, username: req.user.username },
      JWT_SECRET,
      { expiresIn: "1h" },
    );
    res.redirect(
      `${process.env.FRONTEND_URL}/frontend/Dashboard.html?token=${token}`,
    );
  },
);

// Forgot password
app.post("/api/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;
    const cleanEmail = email?.trim().toLowerCase();

    if (!cleanEmail) {
      return res.status(400).json({
        success: false,
        message: "Email is required",
      });
    }

    const result = await pool.query(
      "SELECT id, username FROM users WHERE email = $1",
      [cleanEmail],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "No account found with that email",
      });
    }

    const user = result.rows[0];
    const resetToken = require("crypto").randomBytes(32).toString("hex");
    const resetExpiry = new Date(Date.now() + 3600000); // 1 hour

    await pool.query(
      `UPDATE users SET reset_token = $1, reset_token_expiry = $2 WHERE id = $3`,
      [resetToken, resetExpiry, user.id],
    );

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
      tls: {
        rejectUnauthorized: false,
      },
    });

    const resetLink = `${process.env.FRONTEND_URL}/frontend/reset-password.html?token=${resetToken}`;

    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: cleanEmail,
      subject: "VoltEquilibrium Password Reset",
      html: `
                <h2>Password Reset Request</h2>
                <p>Hi ${user.username},</p>
                <p>Click the link below to reset your password. This link expires in 1 hour.</p>
                <a href="${resetLink}">Reset Password</a>
                <p>If you didn't request this, ignore this email.</p>
            `,
    });

    return res.status(200).json({
      success: true,
      message: "Password reset email sent",
    });
  } catch (error) {
    console.error("Forgot password error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Error sending reset email",
    });
  }
});

// Reset password
app.post("/api/reset-password", async (req, res) => {
  try {
    const { token, password } = req.body;

    if (!token || !password) {
      return res.status(400).json({
        success: false,
        message: "Token and password are required",
      });
    }

    const result = await pool.query(
      `SELECT id FROM users WHERE reset_token = $1 AND reset_token_expiry > NOW()`,
      [token],
    );

    if (result.rows.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid or expired reset token",
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    await pool.query(
      `UPDATE users SET password = $1, reset_token = NULL, reset_token_expiry = NULL WHERE id = $2`,
      [hashedPassword, result.rows[0].id],
    );

    return res.status(200).json({
      success: true,
      message: "Password reset successful",
    });
  } catch (error) {
    console.error("Reset password error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Error resetting password",
    });
  }
});

// Load shedding status proxy
app.get("/api/loadshedding", async (req, res) => {
  try {
    const response = await fetch(
      "https://loadshedding.eskom.co.za/LoadShedding/GetStatus",
    );
    const status = await response.json();
    const stage = status - 1;
    return res.status(200).json({
      success: true,
      stage,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Could not fetch load shedding status",
    });
  }
});

// ===== Setup Routes =====

// Check if user has completed setup
app.get("/api/setup/status", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM inverters WHERE user_id = $1",
      [req.user.id],
    );

    const userResult = await pool.query(
      "SELECT role, location FROM users WHERE id = $1",
      [req.user.id],
    );

    return res.status(200).json({
      success: true,
      hasSetup: result.rows.length > 0,
      inverters: result.rows,
      role: userResult.rows[0].role,
      location: userResult.rows[0].location,
    });
  } catch (error) {
    console.error("Setup status error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Error checking setup status",
    });
  }
});

app.post("/api/setup/inverter", authenticateToken, async (req, res) => {
  try {
    const { name, type, capacity, location, lat, lng } = req.body;

    if (!name || !type) {
      return res.status(400).json({
        success: false,
        message: "Name and type are required",
      });
    }

    if (!["solar", "wind"].includes(type)) {
      return res.status(400).json({
        success: false,
        message: "Type must be solar or wind",
      });
    }

    // Check if user already has this type
    const existing = await pool.query(
      "SELECT id FROM inverters WHERE user_id = $1 AND type = $2",
      [req.user.id, type],
    );

    if (existing.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: `You already have a ${type} inverter`,
      });
    }

    // Add inverter
    const result = await pool.query(
      `INSERT INTO inverters (user_id, name, type, capacity)
             VALUES ($1, $2, $3, $4)
             RETURNING *`,
      [req.user.id, name, type, capacity],
    );

    await pool.query(
      "UPDATE users SET role = $1, location = $2, lat = $3, lng = $4 WHERE id = $5",
      ["generator", location || null, lat, lng, req.user.id],
    );

    return res.status(201).json({
      success: true,
      message: "Inverter added successfully",
      data: result.rows[0],
    });
  } catch (error) {
    console.error("Add inverter error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Error adding inverter",
    });
  }
});

// Delete inverter
app.delete("/api/setup/inverter/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    // Make sure inverter belongs to user
    const inverter = await pool.query(
      "SELECT id FROM inverters WHERE id = $1 AND user_id = $2",
      [id, req.user.id],
    );

    if (inverter.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Inverter not found",
      });
    }

    await pool.query("DELETE FROM inverters WHERE id = $1", [id]);

    // Check if user has any inverters left
    const remaining = await pool.query(
      "SELECT id FROM inverters WHERE user_id = $1",
      [req.user.id],
    );

    // If no inverters left, revert to consumer
    if (remaining.rows.length === 0) {
      await pool.query("UPDATE users SET role = $1 WHERE id = $2", [
        "consumer",
        req.user.id,
      ]);
    }

    return res.status(200).json({
      success: true,
      message: "Inverter removed successfully",
    });
  } catch (error) {
    console.error("Delete inverter error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Error removing inverter",
    });
  }
});

// Update profile
app.put("/api/profile/update", authenticateToken, async (req, res) => {
  try {
    const { username, email, password } = req.body;

    if (!username || !email) {
      return res.status(400).json({
        success: false,
        message: "Username and email are required",
      });
    }

    // Check if email is taken by another user
    const existing = await pool.query(
      "SELECT id FROM users WHERE email = $1 AND id != $2",
      [email.trim().toLowerCase(), req.user.id],
    );

    if (existing.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: "Email already in use by another account",
      });
    }

    if (password) {
      const hashedPassword = await bcrypt.hash(password, 10);
      await pool.query(
        "UPDATE users SET username = $1, email = $2, password = $3 WHERE id = $4",
        [username, email.trim().toLowerCase(), hashedPassword, req.user.id],
      );
    } else {
      await pool.query(
        "UPDATE users SET username = $1, email = $2 WHERE id = $3",
        [username, email.trim().toLowerCase(), req.user.id],
      );
    }

    return res.status(200).json({
      success: true,
      message: "Profile updated successfully",
    });
  } catch (error) {
    console.error("Update profile error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Error updating profile",
    });
  }
});

// Delete account
app.delete("/api/account", authenticateToken, async (req, res) => {
  try {
    // Delete in order to avoid foreign key constraint errors
    await pool.query(
      "DELETE FROM energy_readings WHERE inverter_id IN (SELECT id FROM inverters WHERE user_id = $1)",
      [req.user.id],
    );
    await pool.query("DELETE FROM inverters WHERE user_id = $1", [req.user.id]);
    await pool.query("DELETE FROM users WHERE id = $1", [req.user.id]);

    return res.status(200).json({
      success: true,
      message: "Account deleted successfully",
    });
  } catch (error) {
    console.error("Delete account error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Error deleting account",
    });
  }
});

// Submit energy reading from inverter
app.post("/api/readings", authenticateToken, async (req, res) => {
  try {
    const { inverter_id, kwh } = req.body;

    if (!inverter_id || kwh === undefined) {
      return res.status(400).json({
        success: false,
        message: "inverter_id and kwh are required",
      });
    }

    const result = await pool.query(
      `INSERT INTO energy_readings (inverter_id, kwh)
             VALUES ($1, $2)
             RETURNING *`,
      [inverter_id, kwh],
    );

    return res.status(201).json({
      success: true,
      message: "Reading recorded",
      data: result.rows[0],
    });
  } catch (error) {
    console.error("Reading error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Error recording reading",
    });
  }
});

// Get latest readings for all inverters
app.get("/api/readings/latest", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`
            SELECT 
                i.id,
                i.name,
                i.type,
                i.location,
                er.kwh,
                er.recorded_at
            FROM inverters i
            LEFT JOIN LATERAL (
                SELECT kwh, recorded_at
                FROM energy_readings
                WHERE inverter_id = i.id
                ORDER BY recorded_at DESC
                LIMIT 1
            ) er ON true
            ORDER BY i.type, i.name
        `);

    const solar = result.rows.filter((r) => r.type === "solar");
    const wind = result.rows.filter((r) => r.type === "wind");

    const totalSolar = solar.reduce(
      (sum, r) => sum + parseFloat(r.kwh || 0),
      0,
    );
    const totalWind = wind.reduce((sum, r) => sum + parseFloat(r.kwh || 0), 0);
    const totalGeneration = totalSolar + totalWind;

    return res.status(200).json({
      success: true,
      data: {
        inverters: result.rows,
        solar,
        wind,
        totals: {
          solar: totalSolar.toFixed(2),
          wind: totalWind.toFixed(2),
          generation: totalGeneration.toFixed(2),
        },
      },
    });
  } catch (error) {
    console.error("Readings error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Error fetching readings",
    });
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Route not found",
  });
});

// General error handler
app.use((error, req, res, next) => {
  console.error("Server error:", error.message);

  res.status(500).json({
    success: false,
    message: "Internal server error",
  });
});

// Start the server
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
