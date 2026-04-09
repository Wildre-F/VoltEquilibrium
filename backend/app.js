// ===== Dependencies =====
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");
const fetch = require("node-fetch");
const mqtt = require("mqtt");

// ===== Internal Modules =====
const pool = require("./db");
const passport = require("./passport");
const launcher = require("./launcher");

// ===== App Init =====
const app = express();

// ===== Constants =====
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "mysecretkey";

// ===== Middleware =====
app.use(cors({ origin: process.env.FRONTEND_URL }));
app.use(express.json());
app.use(passport.initialize());

// ===== MQTT Setup =====
const mqttClient = mqtt.connect("mqtt://mqtt:1883");

mqttClient.on("connect", () => {
  console.log("Connected to MQTT broker");
  // Subscribe to all user topics
  mqttClient.subscribe("voltequilibrium/#", (err) => {
    if (!err) console.log("Subscribed to voltequilibrium/#");
  });
});

mqttClient.on("message", async (topic, message) => {
  try {
    const parts = topic.split("/");
    // New format: voltequilibrium/{apiKey}/{deviceId}/{type}
    // Old format: voltequilibrium/{apiKey}/{type}  ← still supported for compatibility
    let apiKey, deviceId, deviceType;

    if (parts.length === 4) {
      // New format
      apiKey = parts[1];
      deviceId = parseInt(parts[2]);
      deviceType = parts[3];
    } else if (parts.length === 3) {
      // Old format fallback
      apiKey = parts[1];
      deviceId = null;
      deviceType = parts[2];
    } else {
      return;
    }

    const data = JSON.parse(message.toString());

    // Find user by API key
    const userResult = await pool.query(
      "SELECT id FROM users WHERE api_key = $1",
      [apiKey],
    );

    if (userResult.rows.length === 0) {
      console.log(`Unknown API key: ${apiKey}`);
      return;
    }

    const userId = userResult.rows[0].id;

    if (deviceType === "solar" || deviceType === "wind") {
      // If deviceId provided, look up by id directly; else fall back to type match
      const inverterResult = deviceId
        ? await pool.query(
            "SELECT id FROM inverters WHERE id = $1 AND user_id = $2",
            [deviceId, userId],
          )
        : await pool.query(
            "SELECT id FROM inverters WHERE user_id = $1 AND type = $2",
            [userId, deviceType],
          );

      if (inverterResult.rows.length === 0) return;
      const inverterId = inverterResult.rows[0].id;

      // Save raw reading
      await pool.query(
        `INSERT INTO raw_readings 
                (inverter_id, dc_voltage, dc_current, ac_voltage, ac_current, 
                frequency, temperature, power_w, energy_kwh, wind_speed, rotor_rpm, pitch_angle)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          inverterId,
          data.dc_voltage || null,
          data.dc_current || null,
          data.ac_voltage || null,
          data.ac_current || null,
          data.frequency || null,
          data.temperature || null,
          data.power_w || null,
          data.energy_kwh || null,
          data.wind_speed || null,
          data.rotor_rpm || null,
          data.pitch_angle || null,
        ],
      );

      // Save energy reading summary
      if (data.energy_kwh) {
        await pool.query(
          "INSERT INTO energy_readings (inverter_id, kwh) VALUES ($1, $2)",
          [inverterId, data.energy_kwh],
        );
      }

      console.log(
        `[${deviceType}] User ${userId}: ${data.power_w}W | ${data.energy_kwh}kWh`,
      );
    } else if (deviceType === "battery") {
      // Find battery for this user
      const batteryResult = await pool.query(
        "SELECT id FROM batteries WHERE user_id = $1",
        [userId],
      );

      if (batteryResult.rows.length === 0) return;
      const batteryId = batteryResult.rows[0].id;

      await pool.query(
        `INSERT INTO battery_readings 
                (battery_id, state_of_charge, voltage, current, temperature, power_w)
                VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          batteryId,
          data.state_of_charge || null,
          data.voltage || null,
          data.current || null,
          data.temperature || null,
          data.power_w || null,
        ],
      );

      console.log(
        `[battery] User ${userId}: ${data.state_of_charge}% | ${data.voltage}V`,
      );
    }
  } catch (error) {
    console.error("MQTT message error:", error.message);
  }
});

mqttClient.on("error", (error) => {
  console.error("MQTT error:", error.message);
});

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
      `${process.env.FRONTEND_URL}/frontend/setup.html?token=${token}`,
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

// Loadshedding status proxy
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
      message: "Could not fetch loadshedding status",
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
    const { name, type, capacity, location, lat, lng, profile } = req.body;

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
      `INSERT INTO inverters (user_id, name, type, capacity, profile)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING *`,
      [req.user.id, name, type, capacity, profile || null],
    );

    await pool.query(
      `INSERT INTO batteries (user_id, name, capacity_kwh) 
   VALUES ($1, $2, 10.0) 
   ON CONFLICT DO NOTHING`,
      [req.user.id, "Main Battery"],
    );

    // Reuse existing API key if user already has one, otherwise generate
    const crypto = require("crypto");
    const existingKey = await pool.query(
      "SELECT api_key FROM users WHERE id = $1",
      [req.user.id],
    );
    const apiKey =
      existingKey.rows[0].api_key ||
      "VE-" + crypto.randomBytes(8).toString("hex");

    await pool.query(
      "UPDATE users SET role = $1, location = $2, lat = $3, lng = $4, api_key = $5 WHERE id = $6",
      ["generator", location || null, lat, lng, apiKey, req.user.id],
    );

    // Start the simulator immediately — no server restart needed
    const simToken = jwt.sign(
      { id: req.user.id, role: "generator", purpose: "simulator" },
      JWT_SECRET,
      { expiresIn: "30d" },
    );
    if (profile && lat && lng) {
      launcher.startSimulator({
        apiKey,
        profile,
        lat: parseFloat(lat),
        lng: parseFloat(lng),
        token: simToken,
        deviceId: result.rows[0].id,
      });
    }

    return res.status(201).json({
      success: true,
      message: "Inverter added successfully",
      data: result.rows[0],
      apiKey: apiKey,
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

    // Stop the simulator for this inverter before deleting
    const userRow = await pool.query(
      "SELECT api_key FROM users WHERE id = $1",
      [req.user.id],
    );
    const deletedInverter = await pool.query(
      "SELECT profile FROM inverters WHERE id = $1",
      [id],
    );
    if (userRow.rows[0]?.api_key && deletedInverter.rows[0]?.profile) {
      launcher.stopSimulator(
        userRow.rows[0].api_key,
        deletedInverter.rows[0].profile,
      );
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

// Update user location
app.put("/api/profile/location", authenticateToken, async (req, res) => {
  try {
    const { location, lat, lng } = req.body;

    if (!lat || !lng) {
      return res
        .status(400)
        .json({ success: false, message: "lat and lng are required" });
    }

    await pool.query(
      "UPDATE users SET location = $1, lat = $2, lng = $3 WHERE id = $4",
      [location || null, parseFloat(lat), parseFloat(lng), req.user.id],
    );

    // Also restart simulators with new location so weather updates immediately
    const userRow = await pool.query(
      "SELECT api_key FROM users WHERE id = $1",
      [req.user.id],
    );
    const inverters = await pool.query(
      "SELECT id, profile FROM inverters WHERE user_id = $1",
      [req.user.id],
    );

    if (userRow.rows[0]?.api_key && inverters.rows.length > 0) {
      const simToken = jwt.sign(
        { id: req.user.id, role: "generator", purpose: "simulator" },
        JWT_SECRET,
        { expiresIn: "30d" },
      );
      // Stop old simulators and restart with new coordinates
      launcher.stopAllForUser(userRow.rows[0].api_key);
      setTimeout(() => {
        inverters.rows.forEach((inv) => {
          launcher.startSimulator({
            apiKey: userRow.rows[0].api_key,
            profile: inv.profile,
            lat: parseFloat(lat),
            lng: parseFloat(lng),
            token: simToken,
            deviceId: inv.id,
          });
        });
      }, 1000);
    }

    return res.status(200).json({ success: true, message: "Location updated" });
  } catch (error) {
    console.error("Location update error:", error.message);
    return res
      .status(500)
      .json({ success: false, message: "Error updating location" });
  }
});

// Delete all user data but keep account
app.delete("/api/account/data", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    // Stop all running simulators for this user before wiping data
    const userKeyRow = await pool.query(
      "SELECT api_key FROM users WHERE id = $1",
      [userId],
    );
    if (userKeyRow.rows[0]?.api_key) {
      launcher.stopAllForUser(userKeyRow.rows[0].api_key);
    }

    // Delete in correct order to respect foreign keys
    await pool.query(
      `
      DELETE FROM battery_readings 
      WHERE battery_id IN (SELECT id FROM batteries WHERE user_id = $1)
    `,
      [userId],
    );

    await pool.query("DELETE FROM batteries WHERE user_id = $1", [userId]);

    await pool.query(
      `
      DELETE FROM energy_readings 
      WHERE inverter_id IN (SELECT id FROM inverters WHERE user_id = $1)
    `,
      [userId],
    );

    await pool.query(
      `
      DELETE FROM raw_readings 
      WHERE inverter_id IN (SELECT id FROM inverters WHERE user_id = $1)
    `,
      [userId],
    );

    await pool.query("DELETE FROM inverters WHERE user_id = $1", [userId]);

    // Clear api_key and reset role to consumer
    await pool.query(
      "UPDATE users SET api_key = NULL, role = 'consumer' WHERE id = $1",
      [userId],
    );

    return res
      .status(200)
      .json({ success: true, message: "All data deleted successfully" });
  } catch (error) {
    console.error("Delete data error:", error.message);
    return res
      .status(500)
      .json({ success: false, message: "Error deleting data" });
  }
});

// Get user API key
app.get("/api/user/apikey", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query("SELECT api_key FROM users WHERE id = $1", [
      req.user.id,
    ]);

    return res.status(200).json({
      success: true,
      apiKey: result.rows[0].api_key,
    });
  } catch (error) {
    console.error("API key error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Error fetching API key",
    });
  }
});

// Shared weather cache — all simulators use this instead of hitting Open-Meteo directly
let weatherCache = {};

app.get("/api/weather", authenticateToken, async (req, res) => {
  const { lat, lng } = req.query;
  const key = `${lat},${lng}`;
  const now = Date.now();

  // Return cached result if less than 15 minutes old
  if (weatherCache[key] && now - weatherCache[key].fetchedAt < 15 * 60 * 1000) {
    return res.json({
      success: true,
      data: weatherCache[key].data,
      cached: true,
    });
  }

  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=cloud_cover,wind_speed_10m,temperature_2m&timezone=auto`;
    const response = await fetch(url);
    const data = await response.json();

    weatherCache[key] = {
  fetchedAt: now,
  data: {
    cloudCover: data.current.cloud_cover,
    windSpeed: data.current.wind_speed_10m,
    temperature: data.current.temperature_2m,
    timezone: data.timezone, 
  },
};

    return res.json({
      success: true,
      data: weatherCache[key].data,
      cached: false,
    });
  } catch (error) {
    return res
      .status(500)
      .json({ success: false, message: "Weather fetch failed" });
  }
});

// Hourly forecast for the weather widget — uses Open-Meteo hourly endpoint
// Returns current conditions + next 6 hours
app.get("/api/weather/forecast", authenticateToken, async (req, res) => {
  try {
    const userRow = await pool.query(
      "SELECT lat, lng, location FROM users WHERE id = $1",
      [req.user.id],
    );

    const user = userRow.rows[0];
    if (!user?.lat || !user?.lng) {
      return res
        .status(400)
        .json({
          success: false,
          message: "No location set. Please update your location in profile.",
        });
    }

    const { lat, lng, location } = user;
    const cacheKey = `forecast:${lat},${lng}`;
    const now = Date.now();

    // Cache forecasts for 15 minutes (same as weather cache)
    if (
      weatherCache[cacheKey] &&
      now - weatherCache[cacheKey].fetchedAt < 15 * 60 * 1000
    ) {
      return res.json({
        success: true,
        data: weatherCache[cacheKey].data,
        cached: true,
      });
    }

    // Open-Meteo hourly: temperature, wind speed, cloud cover for next 7 hours
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
      `&current=temperature_2m,wind_speed_10m,cloud_cover` +
      `&hourly=temperature_2m,wind_speed_10m,cloud_cover` +
      `&forecast_days=2&timezone=auto`;

    const response = await fetch(url);
    const data = await response.json();

    // Find the current hour index in the hourly array
    const currentIso = data.current.time; // e.g. "2026-04-09T12:00"
    const hourlyTimes = data.hourly.time;
    const currentIdx = hourlyTimes.findIndex((t) => t === currentIso);
    const startIdx = currentIdx >= 0 ? currentIdx : 0;

    // Build next 6 hours
    const hourly = [];
    for (let i = 1; i <= 6; i++) {
      const idx = startIdx + i;
      if (idx >= hourlyTimes.length) break;
      hourly.push({
        time: hourlyTimes[idx].split("T")[1], // "14:00"
        temp: data.hourly.temperature_2m[idx],
        wind: data.hourly.wind_speed_10m[idx],
        cloud: data.hourly.cloud_cover[idx],
      });
    }

    const result = {
      location: location || `${lat}, ${lng}`,
      current: {
        temp: data.current.temperature_2m,
        wind: data.current.wind_speed_10m,
        cloud: data.current.cloud_cover,
      },
      hourly,
    };

    weatherCache[cacheKey] = { fetchedAt: now, data: result };
    return res.json({ success: true, data: result, cached: false });
  } catch (error) {
    console.error("Forecast error:", error.message);
    return res
      .status(500)
      .json({ success: false, message: "Forecast fetch failed" });
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

app.get("/api/readings/latest", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT 
        i.id as inverter_id,
        i.name as inverter_name,
        i.type,
        i.profile,
        rr.power_w,
        rr.dc_voltage,
        rr.dc_current,
        rr.ac_voltage,
        rr.ac_current,
        rr.frequency,
        rr.temperature as inverter_temp,
        rr.energy_kwh,
        rr.wind_speed,
        rr.rotor_rpm,
        rr.pitch_angle,
        br.state_of_charge,
        br.voltage as battery_voltage,
        br.current as battery_current,
        br.temperature as battery_temp,
        br.power_w as battery_power,
        rr.recorded_at
      FROM inverters i
      JOIN users u ON i.user_id = u.id
      LEFT JOIN LATERAL (
        SELECT * FROM raw_readings 
        WHERE inverter_id = i.id 
        ORDER BY recorded_at DESC 
        LIMIT 1
      ) rr ON true
      LEFT JOIN LATERAL (
        SELECT * FROM battery_readings 
        WHERE battery_id = (SELECT id FROM batteries WHERE user_id = u.id LIMIT 1)
        ORDER BY recorded_at DESC 
        LIMIT 1
      ) br ON true
      WHERE u.id = $1
      ORDER BY i.type, i.name;
    `,
      [req.user.id],
    );

    const solar = result.rows.filter((r) => r.type === "solar");
    const wind = result.rows.filter((r) => r.type === "wind");
    const totalPower = result.rows.reduce(
      (sum, r) => sum + (parseFloat(r.power_w) || 0),
      0,
    );

    return res.status(200).json({
      success: true,
      data: {
        all: result.rows,
        solar,
        wind,
        totalPower: Math.round(totalPower),
        totalPowerMW: (totalPower / 1000).toFixed(2),
        lastUpdated: new Date(),
      },
    });
  } catch (error) {
    console.error("Dashboard readings error:", error.message);
    return res
      .status(500)
      .json({ success: false, message: "Error fetching live readings" });
  }
});

// Get last N raw readings per inverter for chart pre-population
app.get("/api/readings/history", authenticateToken, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100); // max 100

    const result = await pool.query(
      `
      SELECT
        i.id as inverter_id,
        i.type,
        i.profile,
        rr.power_w,
        rr.wind_speed,
        rr.rotor_rpm,
        rr.pitch_angle,
        rr.dc_voltage,
        rr.ac_voltage,
        rr.energy_kwh,
        rr.recorded_at
      FROM inverters i
      JOIN users u ON i.user_id = u.id
      JOIN LATERAL (
        SELECT * FROM raw_readings
        WHERE inverter_id = i.id
        ORDER BY recorded_at DESC
        LIMIT $2
      ) rr ON true
      WHERE u.id = $1
      ORDER BY i.type, rr.recorded_at ASC
    `,
      [req.user.id, limit],
    );

    const solar = result.rows.filter((r) => r.type === "solar");
    const wind = result.rows.filter((r) => r.type === "wind");

    return res.status(200).json({ success: true, data: { solar, wind } });
  } catch (error) {
    console.error("History error:", error.message);
    return res
      .status(500)
      .json({ success: false, message: "Error fetching history" });
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

  setTimeout(() => {
    launcher.startAllSimulators();
  }, 3000);
});
