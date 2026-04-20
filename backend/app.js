// ═══════════════════════════════════════════════════════════════════════════
// Dependencies
// ═══════════════════════════════════════════════════════════════════════════
require("dotenv").config();
const crypto     = require("crypto");
const express    = require("express");
const cors       = require("cors");
const bcrypt     = require("bcrypt");
const jwt        = require("jsonwebtoken");
const nodemailer = require("nodemailer");
const fetch      = require("node-fetch");
const mqtt       = require("mqtt");
const rateLimit  = require("express-rate-limit");

// ═══════════════════════════════════════════════════════════════════════════
// Internal Modules
// ═══════════════════════════════════════════════════════════════════════════
const pool     = require("./db");
const passport = require("./passport");
const launcher = require("./launcher");

// ═══════════════════════════════════════════════════════════════════════════
// App Init
// ═══════════════════════════════════════════════════════════════════════════
const app = express();

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;

if (!process.env.JWT_SECRET) {
  throw new Error("JWT_SECRET environment variable is required");
}
const JWT_SECRET = process.env.JWT_SECRET;

// South Africa grid emission factor (Eskom):
//   CO2_KG_PER_KWH — every kWh generated at home instead of drawing from the
//                    grid avoids 0.928 kg of CO2.
//   RANDS_PER_KWH  — approximate Eskom tariff: generating 1 kWh yourself
//                    saves roughly R2.50 you would otherwise have paid Eskom.
const CO2_KG_PER_KWH = 0.928;
const RANDS_PER_KWH  = 2.5;

// In-memory cache for Open-Meteo weather responses (current + forecast).
// Keyed by "lat,lng" for current weather and "forecast:lat,lng" for forecasts.
// Each entry: { fetchedAt: <epoch ms>, data: <response object> }
const weatherCache = {};

// ═══════════════════════════════════════════════════════════════════════════
// Middleware
// ═══════════════════════════════════════════════════════════════════════════
app.use(cors({ origin: process.env.FRONTEND_URL }));
app.use(express.json());
app.use(passport.initialize());

// Prevent browsers from caching protected API responses
app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
  next();
});

// ═══════════════════════════════════════════════════════════════════════════
// Rate Limiting
// ═══════════════════════════════════════════════════════════════════════════
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many attempts, please try again later",
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// MQTT — Ingest telemetry from simulators/inverters
// ═══════════════════════════════════════════════════════════════════════════
const mqttClient = mqtt.connect("mqtt://mqtt:1883");

mqttClient.on("connect", () => {
  console.log("Connected to MQTT broker");
  mqttClient.subscribe("voltequilibrium/#", (err) => {
    if (!err) console.log("Subscribed to voltequilibrium/#");
  });
});

mqttClient.on("message", async (topic, message) => {
  try {
    const parts = topic.split("/");

    // Supported topic formats:
    //   New: voltequilibrium/{apiKey}/{deviceId}/{type}
    //   Old: voltequilibrium/{apiKey}/{type}          (kept for compatibility)
    let apiKey, deviceId, deviceType;

    if (parts.length === 4) {
      apiKey     = parts[1];
      deviceId   = parseInt(parts[2]);
      deviceType = parts[3];
    } else if (parts.length === 3) {
      apiKey     = parts[1];
      deviceId   = null;
      deviceType = parts[2];
    } else {
      return;
    }

    const data = JSON.parse(message.toString());

    const userResult = await pool.query(
      "SELECT id FROM users WHERE api_key = $1",
      [apiKey],
    );

    if (userResult.rows.length === 0) {
      console.log(`Unknown API key: ${apiKey}`);
      return;
    }

    const userId = userResult.rows[0].id;

    // ── Solar / Wind inverter readings ──────────────────────────────────────
    if (deviceType === "solar" || deviceType === "wind") {
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

      // Use ?? null so that a genuine 0 value (e.g. energy_kwh at day start)
      // is stored as 0 and not silently dropped as null.
      await pool.query(
        `INSERT INTO raw_readings
          (inverter_id, dc_voltage, dc_current, ac_voltage, ac_current,
           frequency, temperature, power_w, energy_kwh, wind_speed, rotor_rpm, pitch_angle,
           load_watts, load_kwh, grid_watts, grid_kwh)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [
          inverterId,
          data.dc_voltage    ?? null,
          data.dc_current    ?? null,
          data.ac_voltage    ?? null,
          data.ac_current    ?? null,
          data.frequency     ?? null,
          data.temperature   ?? null,
          data.power_w       ?? null,
          data.energy_kwh    ?? null,
          data.wind_speed    ?? null,
          data.rotor_rpm     ?? null,
          data.pitch_angle   ?? null,
          data.load_watts    ?? null,
          data.load_kwh      ?? null,
          data.grid_watts    ?? null,
          data.grid_kwh      ?? null,
        ],
      );

      // energy_readings stores a per-message kWh snapshot (used for quick totals)
      if (data.energy_kwh != null) {
        await pool.query(
          "INSERT INTO energy_readings (inverter_id, kwh) VALUES ($1, $2)",
          [inverterId, data.energy_kwh],
        );
      }

      console.log(`[${deviceType}] User ${userId}: ${data.power_w}W | ${data.energy_kwh}kWh`);

    // ── Battery readings ────────────────────────────────────────────────────
    } else if (deviceType === "battery") {
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
          data.state_of_charge ?? null,
          data.voltage         ?? null,
          data.current         ?? null,
          data.temperature     ?? null,
          data.power_w         ?? null,
        ],
      );

      console.log(`[battery] User ${userId}: ${data.state_of_charge}% | ${data.voltage}V`);
    }
  } catch (error) {
    console.error("MQTT message error:", error.message);
  }
});

mqttClient.on("error", (error) => {
  console.error("MQTT error:", error.message);
});

// ═══════════════════════════════════════════════════════════════════════════
// Auth Helper
// ═══════════════════════════════════════════════════════════════════════════

function authenticateToken(req, res, next) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res.status(401).json({ success: false, message: "Access token required" });
    }

    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "Authorisation header must start with Bearer",
      });
    }

    const token = authHeader.split(" ")[1];

    if (!token) {
      return res.status(401).json({ success: false, message: "Token not provided" });
    }

    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(403).json({ success: false, message: "Invalid or expired token" });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Utility Routes
// ═══════════════════════════════════════════════════════════════════════════

// Health check
app.get("/", (req, res) => {
  res.send("Backend server is running");
});

// API smoke test
app.get("/api/test", (req, res) => {
  res.status(200).json({ success: true, message: "API is working", version: "1.0" });
});

// Database connectivity check
app.get("/api/db-test", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW()");
    res.status(200).json({ success: true, message: "Database connection works", data: result.rows[0] });
  } catch (error) {
    console.error("Database test error:", error.message);
    res.status(500).json({ success: false, message: "Database connection failed" });
  }
});

// Protected dashboard smoke test
app.get("/api/dashboard", authenticateToken, (req, res) => {
  res.json({ success: true, message: "Welcome to the dashboard", user: req.user });
});

// Loadshedding status proxy (Eskom)
app.get("/api/loadshedding", async (req, res) => {
  try {
    const response = await fetch("https://loadshedding.eskom.co.za/LoadShedding/GetStatus");
    const status   = await response.json();
    return res.status(200).json({ success: true, stage: status - 1 });
  } catch {
    return res.status(500).json({ success: false, message: "Could not fetch loadshedding status" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Auth Routes
// ═══════════════════════════════════════════════════════════════════════════

app.post("/api/register", authLimiter, async (req, res) => {
  try {
    const cleanUsername = req.body.username?.trim();
    const cleanEmail    = req.body.email?.trim().toLowerCase();
    const { password }  = req.body;

    if (!cleanUsername || !cleanEmail || !password) {
      return res.status(400).json({
        success: false,
        message: "Username, email, and password are required",
      });
    }

    const existing = await pool.query("SELECT id FROM users WHERE email = $1", [cleanEmail]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ success: false, message: "Email already exists" });
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
    return res.status(500).json({ success: false, message: "Server error during registration" });
  }
});

app.post("/api/login", authLimiter, async (req, res, next) => {
  try {
    const cleanEmail   = req.body.email?.trim().toLowerCase();
    const { password } = req.body;

    if (!cleanEmail || !password) {
      return res.status(400).json({ success: false, message: "Email and password are required" });
    }

    const result = await pool.query(
      "SELECT id, username, email, password, role FROM users WHERE email = $1",
      [cleanEmail],
    );

    const user = result.rows[0];
    if (!user) {
      return res.status(401).json({ success: false, message: "Account not found, please register first" });
    }

    const isPasswordMatch = await bcrypt.compare(password, user.password);
    if (!isPasswordMatch) {
      return res.status(401).json({ success: false, message: "Invalid email or password" });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, username: user.username, role: user.role },
      JWT_SECRET,
      { expiresIn: "1h" },
    );

    return res.status(200).json({ success: true, message: "Login successful", token });
  } catch (error) {
    next(error);
  }
});

// ── Google OAuth ─────────────────────────────────────────────────────────────

app.get("/auth/google", passport.authenticate("google", { scope: ["profile", "email"] }));

app.get(
  "/auth/google/callback",
  passport.authenticate("google", { session: false, failureRedirect: "/login.html" }),
  (req, res) => {
    const token = jwt.sign(
      { id: req.user.id, email: req.user.email, username: req.user.username, role: req.user.role },
      JWT_SECRET,
      { expiresIn: "1h" },
    );
    res.redirect(`${process.env.FRONTEND_URL}/frontend/setup.html?token=${token}`);
  },
);

// ── Password Reset ────────────────────────────────────────────────────────────

app.post("/api/forgot-password", authLimiter, async (req, res) => {
  try {
    const cleanEmail = req.body.email?.trim().toLowerCase();

    if (!cleanEmail) {
      return res.status(400).json({ success: false, message: "Email is required" });
    }

    const result = await pool.query(
      "SELECT id, username FROM users WHERE email = $1",
      [cleanEmail],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "No account found with that email" });
    }

    const user       = result.rows[0];
    const resetToken = crypto.randomBytes(32).toString("hex");
    const resetExpiry = new Date(Date.now() + 3_600_000); // 1 hour

    await pool.query(
      "UPDATE users SET reset_token = $1, reset_token_expiry = $2 WHERE id = $3",
      [resetToken, resetExpiry, user.id],
    );

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
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

    return res.status(200).json({ success: true, message: "Password reset email sent" });
  } catch (error) {
    console.error("Forgot password error:", error.message);
    return res.status(500).json({ success: false, message: "Error sending reset email" });
  }
});

app.post("/api/reset-password", async (req, res) => {
  try {
    const { token, password } = req.body;

    if (!token || !password) {
      return res.status(400).json({ success: false, message: "Token and password are required" });
    }

    const result = await pool.query(
      "SELECT id FROM users WHERE reset_token = $1 AND reset_token_expiry > NOW()",
      [token],
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ success: false, message: "Invalid or expired reset token" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    await pool.query(
      "UPDATE users SET password = $1, reset_token = NULL, reset_token_expiry = NULL WHERE id = $2",
      [hashedPassword, result.rows[0].id],
    );

    return res.status(200).json({ success: true, message: "Password reset successful" });
  } catch (error) {
    console.error("Reset password error:", error.message);
    return res.status(500).json({ success: false, message: "Error resetting password" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Profile & Account Routes
// ═══════════════════════════════════════════════════════════════════════════

app.get("/api/profile", authenticateToken, async (req, res, next) => {
  try {
    const result = await pool.query(
      "SELECT id, username, email, created_at FROM users WHERE id = $1",
      [req.user.id],
    );

    const user = result.rows[0];
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    return res.status(200).json({ success: true, message: "Profile retrieved successfully", data: user });
  } catch (error) {
    next(error);
  }
});

app.put("/api/profile/update", authenticateToken, async (req, res) => {
  try {
    const { username, email, password } = req.body;

    if (!username || !email) {
      return res.status(400).json({ success: false, message: "Username and email are required" });
    }

    const existing = await pool.query(
      "SELECT id FROM users WHERE email = $1 AND id != $2",
      [email.trim().toLowerCase(), req.user.id],
    );

    if (existing.rows.length > 0) {
      return res.status(409).json({ success: false, message: "Email already in use by another account" });
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

    return res.status(200).json({ success: true, message: "Profile updated successfully" });
  } catch (error) {
    console.error("Update profile error:", error.message);
    return res.status(500).json({ success: false, message: "Error updating profile" });
  }
});

app.put("/api/profile/location", authenticateToken, async (req, res) => {
  try {
    const { location, lat, lng } = req.body;

    if (lat == null || lng == null) {
      return res.status(400).json({ success: false, message: "lat and lng are required" });
    }

    await pool.query(
      "UPDATE users SET location = $1, lat = $2, lng = $3 WHERE id = $4",
      [location || null, parseFloat(lat), parseFloat(lng), req.user.id],
    );

    // Restart simulators with the new coordinates so weather adjusts immediately
    const userRow  = await pool.query("SELECT api_key FROM users WHERE id = $1", [req.user.id]);
    const inverters = await pool.query("SELECT id, profile FROM inverters WHERE user_id = $1", [req.user.id]);

    if (userRow.rows[0]?.api_key && inverters.rows.length > 0) {
      const simToken = jwt.sign(
        { id: req.user.id, role: "generator", purpose: "simulator" },
        JWT_SECRET,
        { expiresIn: "30d" },
      );
      launcher.stopAllForUser(userRow.rows[0].api_key);
      setTimeout(() => {
        inverters.rows.forEach((inv) => {
          launcher.startSimulator({
            apiKey:   userRow.rows[0].api_key,
            profile:  inv.profile,
            lat:      parseFloat(lat),
            lng:      parseFloat(lng),
            token:    simToken,
            deviceId: inv.id,
          });
        });
      }, 1000);
    }

    return res.status(200).json({ success: true, message: "Location updated" });
  } catch (error) {
    console.error("Location update error:", error.message);
    return res.status(500).json({ success: false, message: "Error updating location" });
  }
});

app.get("/api/user/apikey", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query("SELECT api_key FROM users WHERE id = $1", [req.user.id]);
    return res.status(200).json({ success: true, apiKey: result.rows[0].api_key });
  } catch (error) {
    console.error("API key error:", error.message);
    return res.status(500).json({ success: false, message: "Error fetching API key" });
  }
});

// Delete all generated data but keep the account
app.delete("/api/account/data", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const userKeyRow = await pool.query("SELECT api_key FROM users WHERE id = $1", [userId]);
    if (userKeyRow.rows[0]?.api_key) {
      launcher.stopAllForUser(userKeyRow.rows[0].api_key);
    }

    // Delete in FK-safe order
    await pool.query(
      "DELETE FROM battery_readings WHERE battery_id IN (SELECT id FROM batteries WHERE user_id = $1)",
      [userId],
    );
    await pool.query("DELETE FROM batteries WHERE user_id = $1", [userId]);
    await pool.query(
      "DELETE FROM energy_readings WHERE inverter_id IN (SELECT id FROM inverters WHERE user_id = $1)",
      [userId],
    );
    await pool.query(
      "DELETE FROM raw_readings WHERE inverter_id IN (SELECT id FROM inverters WHERE user_id = $1)",
      [userId],
    );
    await pool.query("DELETE FROM inverters WHERE user_id = $1", [userId]);
    await pool.query("UPDATE users SET api_key = NULL, role = 'consumer' WHERE id = $1", [userId]);

    return res.status(200).json({ success: true, message: "All data deleted successfully" });
  } catch (error) {
    console.error("Delete data error:", error.message);
    return res.status(500).json({ success: false, message: "Error deleting data" });
  }
});

// Delete the entire account (cascades to all data via FK ON DELETE CASCADE)
app.delete("/api/account", authenticateToken, async (req, res) => {
  try {
    const userId     = req.user.id;
    const userKeyRow = await pool.query("SELECT api_key FROM users WHERE id = $1", [userId]);

    if (userKeyRow.rows[0]?.api_key) {
      launcher.stopAllForUser(userKeyRow.rows[0].api_key);
    }

    await pool.query("DELETE FROM users WHERE id = $1", [userId]);
    return res.status(200).json({ success: true, message: "Account deleted successfully" });
  } catch (error) {
    console.error("Delete account error:", error.message);
    return res.status(500).json({ success: false, message: "Error deleting account" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Setup Routes  (inverter / profile onboarding)
// ═══════════════════════════════════════════════════════════════════════════

app.get("/api/setup/status", authenticateToken, async (req, res) => {
  try {
    const result     = await pool.query("SELECT * FROM inverters WHERE user_id = $1", [req.user.id]);
    const userResult = await pool.query("SELECT role, location FROM users WHERE id = $1", [req.user.id]);

    return res.status(200).json({
      success:   true,
      hasSetup:  result.rows.length > 0,
      inverters: result.rows,
      role:      userResult.rows[0].role,
      location:  userResult.rows[0].location,
    });
  } catch (error) {
    console.error("Setup status error:", error.message);
    return res.status(500).json({ success: false, message: "Error checking setup status" });
  }
});

app.post("/api/setup/inverter", authenticateToken, async (req, res) => {
  try {
    const { name, type, capacity, location, lat, lng, profile } = req.body;

    if (!name || !type) {
      return res.status(400).json({ success: false, message: "Name and type are required" });
    }

    if (!["solar", "wind"].includes(type)) {
      return res.status(400).json({ success: false, message: "Type must be solar or wind" });
    }

    const existing = await pool.query(
      "SELECT id FROM inverters WHERE user_id = $1 AND type = $2",
      [req.user.id, type],
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ success: false, message: `You already have a ${type} inverter` });
    }

    const serialPrefix  = type === "solar" ? "VE-SOL" : "VE-WND";
    const serialSuffix  = crypto.randomBytes(3).toString("hex").toUpperCase();
    const serialNumber  = `${serialPrefix}-${serialSuffix}`;

    const firmwareMap = {
      "solar-small": "FW-2.1.4",
      "solar-large": "FW-2.3.1",
      "wind-small":  "FW-3.0.2",
      "wind-large":  "FW-3.2.0",
    };
    const firmwareVersion = firmwareMap[profile] || "FW-1.0.0";

    const result = await pool.query(
      `INSERT INTO inverters (user_id, name, type, capacity, profile, serial_number, firmware_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [req.user.id, name, type, capacity, profile || null, serialNumber, firmwareVersion],
    );

    await pool.query(
      "INSERT INTO batteries (user_id, name, capacity_kwh) VALUES ($1, $2, 10.0) ON CONFLICT DO NOTHING",
      [req.user.id, "Main Battery"],
    );

    // Reuse an existing API key if the user already has one
    const existingKey = await pool.query("SELECT api_key FROM users WHERE id = $1", [req.user.id]);
    const apiKey      = existingKey.rows[0].api_key || "VE-" + crypto.randomBytes(8).toString("hex");

    await pool.query(
      "UPDATE users SET role = $1, location = $2, lat = $3, lng = $4, api_key = $5 WHERE id = $6",
      ["generator", location || null, lat, lng, apiKey, req.user.id],
    );

    // Start the simulator immediately — no server restart required
    const simToken = jwt.sign(
      { id: req.user.id, role: "generator", purpose: "simulator" },
      JWT_SECRET,
      { expiresIn: "30d" },
    );
    if (profile && lat != null && lng != null) {
      launcher.startSimulator({
        apiKey,
        profile,
        lat:      parseFloat(lat),
        lng:      parseFloat(lng),
        token:    simToken,
        deviceId: result.rows[0].id,
      });
    }

    return res.status(201).json({
      success: true,
      message: "Inverter added successfully",
      data:    result.rows[0],
      apiKey,
    });
  } catch (error) {
    console.error("Add inverter error:", error.message);
    return res.status(500).json({ success: false, message: "Error adding inverter" });
  }
});

app.delete("/api/setup/inverter/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    const inverter = await pool.query(
      "SELECT id FROM inverters WHERE id = $1 AND user_id = $2",
      [id, req.user.id],
    );
    if (inverter.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Inverter not found" });
    }

    // Stop the simulator before deleting so it doesn't keep writing data
    const userRow        = await pool.query("SELECT api_key FROM users WHERE id = $1", [req.user.id]);
    const deletedInverter = await pool.query("SELECT profile FROM inverters WHERE id = $1", [id]);
    if (userRow.rows[0]?.api_key && deletedInverter.rows[0]?.profile) {
      launcher.stopSimulator(userRow.rows[0].api_key, deletedInverter.rows[0].profile);
    }

    await pool.query("DELETE FROM inverters WHERE id = $1", [id]);

    // Revert to consumer role if no inverters remain
    const remaining = await pool.query("SELECT id FROM inverters WHERE user_id = $1", [req.user.id]);
    if (remaining.rows.length === 0) {
      await pool.query("UPDATE users SET role = $1 WHERE id = $2", ["consumer", req.user.id]);
    }

    return res.status(200).json({ success: true, message: "Inverter removed successfully" });
  } catch (error) {
    console.error("Delete inverter error:", error.message);
    return res.status(500).json({ success: false, message: "Error removing inverter" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Weather Routes
// ═══════════════════════════════════════════════════════════════════════════

// Current conditions — used by simulators to adjust output based on cloud/wind
app.get("/api/weather", authenticateToken, async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);

  if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return res.status(400).json({ success: false, message: "Valid lat and lng are required" });
  }

  const key = `${lat},${lng}`;
  const now = Date.now();

  if (weatherCache[key] && now - weatherCache[key].fetchedAt < 15 * 60 * 1000) {
    return res.json({ success: true, data: weatherCache[key].data, cached: true });
  }

  try {
    const url      = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=cloud_cover,wind_speed_10m,temperature_2m&timezone=auto`;
    const response = await fetch(url);
    const data     = await response.json();

    weatherCache[key] = {
      fetchedAt: now,
      data: {
        cloudCover:  data.current.cloud_cover,
        windSpeed:   data.current.wind_speed_10m,
        temperature: data.current.temperature_2m,
        timezone:    data.timezone,
      },
    };

    return res.json({ success: true, data: weatherCache[key].data, cached: false });
  } catch {
    return res.status(500).json({ success: false, message: "Weather fetch failed" });
  }
});

// Hourly forecast — drives the weather widget on the dashboard
// Returns current conditions + next 6 hours in the site's local timezone
app.get("/api/weather/forecast", authenticateToken, async (req, res) => {
  try {
    const userRow = await pool.query(
      "SELECT lat, lng, location FROM users WHERE id = $1",
      [req.user.id],
    );

    const user = userRow.rows[0];
    if (!user?.lat || !user?.lng) {
      return res.status(400).json({
        success: false,
        message: "No location set. Please update your location in profile.",
      });
    }

    const { lat, lng, location } = user;
    const cacheKey = `forecast:${lat},${lng}`;
    const now      = Date.now();

    if (weatherCache[cacheKey] && now - weatherCache[cacheKey].fetchedAt < 15 * 60 * 1000) {
      return res.json({ success: true, data: weatherCache[cacheKey].data, cached: true });
    }

    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
      `&current=temperature_2m,wind_speed_10m,cloud_cover` +
      `&hourly=temperature_2m,wind_speed_10m,cloud_cover` +
      `&forecast_days=2&timezone=auto`;

    const response = await fetch(url);
    const data     = await response.json();

    // data.current.time is UTC; data.hourly.time is local (timezone=auto).
    // Use utc_offset_seconds from the response to derive the matching local hour.
    const utcOffsetMs = (data.utc_offset_seconds ?? 0) * 1000;
    const localNow    = new Date(Date.now() + utcOffsetMs);
    const pad         = (n) => String(n).padStart(2, "0");
    const localIso    =
      `${localNow.getUTCFullYear()}-${pad(localNow.getUTCMonth() + 1)}-` +
      `${pad(localNow.getUTCDate())}T${pad(localNow.getUTCHours())}:00`;

    const hourlyTimes = data.hourly.time;
    const currentIdx  = hourlyTimes.findIndex((t) => t === localIso);
    const startIdx    = currentIdx >= 0 ? currentIdx : 0;

    const hourly = [];
    for (let i = 1; i <= 6; i++) {
      const idx = startIdx + i;
      if (idx >= hourlyTimes.length) break;
      hourly.push({
        time:  hourlyTimes[idx].split("T")[1],
        temp:  data.hourly.temperature_2m[idx],
        wind:  data.hourly.wind_speed_10m[idx],
        cloud: data.hourly.cloud_cover[idx],
      });
    }

    const result = {
      location: location || `${lat}, ${lng}`,
      current: {
        temp:  data.current.temperature_2m,
        wind:  data.current.wind_speed_10m,
        cloud: data.current.cloud_cover,
      },
      hourly,
    };

    weatherCache[cacheKey] = { fetchedAt: now, data: result };
    return res.json({ success: true, data: result, cached: false });
  } catch (error) {
    console.error("Forecast error:", error.message);
    return res.status(500).json({ success: false, message: "Forecast fetch failed" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Readings Routes
// ═══════════════════════════════════════════════════════════════════════════

// Manual kWh submission (used when not going through MQTT)
app.post("/api/readings", authenticateToken, async (req, res) => {
  try {
    const { inverter_id, kwh } = req.body;

    if (!inverter_id || kwh === undefined) {
      return res.status(400).json({ success: false, message: "inverter_id and kwh are required" });
    }

    const ownerCheck = await pool.query(
      "SELECT id FROM inverters WHERE id = $1 AND user_id = $2",
      [inverter_id, req.user.id],
    );
    if (ownerCheck.rows.length === 0) {
      return res.status(403).json({ success: false, message: "Inverter not found or does not belong to you" });
    }

    const result = await pool.query(
      "INSERT INTO energy_readings (inverter_id, kwh) VALUES ($1, $2) RETURNING *",
      [inverter_id, kwh],
    );

    return res.status(201).json({ success: true, message: "Reading recorded", data: result.rows[0] });
  } catch (error) {
    console.error("Reading error:", error.message);
    return res.status(500).json({ success: false, message: "Error recording reading" });
  }
});

// Latest reading per inverter — drives the live dials on the dashboard
app.get("/api/readings/latest", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        i.id             AS inverter_id,
        i.name           AS inverter_name,
        i.type,
        i.profile,
        rr.power_w,
        rr.dc_voltage,
        rr.dc_current,
        rr.ac_voltage,
        rr.ac_current,
        rr.frequency,
        rr.temperature   AS inverter_temp,
        rr.energy_kwh,
        rr.wind_speed,
        rr.rotor_rpm,
        rr.pitch_angle,
        br.state_of_charge,
        br.voltage       AS battery_voltage,
        br.current       AS battery_current,
        br.temperature   AS battery_temp,
        br.power_w       AS battery_power,
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
        WHERE battery_id = (SELECT id FROM batteries WHERE user_id = u.id ORDER BY id ASC LIMIT 1)
        ORDER BY recorded_at DESC
        LIMIT 1
      ) br ON true
      WHERE u.id = $1
      ORDER BY i.type, i.name
      `,
      [req.user.id],
    );

    const solar      = result.rows.filter((r) => r.type === "solar");
    const wind       = result.rows.filter((r) => r.type === "wind");
    const totalPower = result.rows.reduce((sum, r) => sum + (parseFloat(r.power_w) || 0), 0);

    return res.status(200).json({
      success: true,
      data: {
        all:          result.rows,
        solar,
        wind,
        totalPower:   Math.round(totalPower),
        totalPowerMW: (totalPower / 1000).toFixed(2),
        lastUpdated:  new Date(),
      },
    });
  } catch (error) {
    console.error("Dashboard readings error:", error.message);
    return res.status(500).json({ success: false, message: "Error fetching live readings" });
  }
});

// Historical readings per inverter — pre-populates the power chart on page load
app.get("/api/readings/history", authenticateToken, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 5000);

    const result = await pool.query(
      `
      SELECT
        i.id         AS inverter_id,
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
    const wind  = result.rows.filter((r) => r.type === "wind");

    return res.status(200).json({ success: true, data: { solar, wind } });
  } catch (error) {
    console.error("History error:", error.message);
    return res.status(500).json({ success: false, message: "Error fetching history" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// CO2 & Analytics Routes
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/co2
// CO2 savings and rand savings for the logged-in user.
//
// Returns:
//   lifetimeKwh   — total kWh ever generated
//   lifetimeCo2Kg — lifetime CO2 offset (kWh × 0.928)
//   lifetimeRands — lifetime money saved (kWh × 2.50)
//   todayKwh      — kWh generated so far today (live from raw_readings)
//   todayCo2Kg    — CO2 offset today
//   todayRands    — money saved today
//   history       — last 30 days of daily kWh / CO2 / savings for the chart
//   constants     — the emission factor and tariff used (for frontend labels)
//
// "Today" uses DISTINCT ON to get the latest energy_kwh reading per inverter
// (the simulator publishes a running daily total), then sums across inverters.
app.get("/api/co2", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    // Today's kWh — latest running total per inverter, summed
    const todayResult = await pool.query(
      `
      SELECT COALESCE(SUM(latest_kwh), 0) AS today_kwh
      FROM (
        SELECT DISTINCT ON (inverter_id)
          inverter_id,
          energy_kwh AS latest_kwh
        FROM raw_readings
        WHERE inverter_id IN (SELECT id FROM inverters WHERE user_id = $1)
          AND recorded_at >= DATE_TRUNC('day', NOW())
        ORDER BY inverter_id, recorded_at DESC
      ) AS latest_per_inverter
      `,
      [userId],
    );

    const todayKwh = parseFloat(todayResult.rows[0].today_kwh) || 0;

    // Lifetime kWh — MAX(energy_kwh) per inverter per day (avoids double-counting
    // the running total), then summed across all days and inverters
    const lifetimeResult = await pool.query(
      `
      SELECT COALESCE(SUM(daily_kwh), 0) AS lifetime_kwh
      FROM (
        SELECT
          DATE_TRUNC('day', recorded_at) AS day,
          inverter_id,
          MAX(energy_kwh) AS daily_kwh
        FROM raw_readings
        WHERE inverter_id IN (SELECT id FROM inverters WHERE user_id = $1)
        GROUP BY DATE_TRUNC('day', recorded_at), inverter_id
      ) AS daily_per_inverter
      `,
      [userId],
    );

    const lifetimeKwh = parseFloat(lifetimeResult.rows[0].lifetime_kwh) || 0;

    // 30-day history — one row per day (gaps filled with 0 via generate_series)
    const historyResult = await pool.query(
      `
      SELECT
        gs.day::DATE                              AS date,
        COALESCE(SUM(d.daily_kwh), 0)            AS kwh,
        COALESCE(SUM(d.daily_kwh) * $2, 0)       AS co2_kg,
        COALESCE(SUM(d.daily_kwh) * $3, 0)       AS rands_saved
      FROM generate_series(
        DATE_TRUNC('day', NOW()) - INTERVAL '29 days',
        DATE_TRUNC('day', NOW()),
        INTERVAL '1 day'
      ) AS gs(day)
      LEFT JOIN (
        SELECT
          DATE_TRUNC('day', recorded_at) AS day,
          inverter_id,
          MAX(energy_kwh) AS daily_kwh
        FROM raw_readings
        WHERE inverter_id IN (SELECT id FROM inverters WHERE user_id = $1)
        GROUP BY DATE_TRUNC('day', recorded_at), inverter_id
      ) AS d ON d.day = gs.day
      GROUP BY gs.day
      ORDER BY gs.day ASC
      `,
      [userId, CO2_KG_PER_KWH, RANDS_PER_KWH],
    );

    return res.status(200).json({
      success: true,
      data: {
        lifetimeKwh:   parseFloat(lifetimeKwh.toFixed(3)),
        lifetimeCo2Kg: parseFloat((lifetimeKwh * CO2_KG_PER_KWH).toFixed(3)),
        lifetimeRands: parseFloat((lifetimeKwh * RANDS_PER_KWH).toFixed(2)),
        todayKwh:      parseFloat(todayKwh.toFixed(3)),
        todayCo2Kg:    parseFloat((todayKwh * CO2_KG_PER_KWH).toFixed(3)),
        todayRands:    parseFloat((todayKwh * RANDS_PER_KWH).toFixed(2)),
        history: historyResult.rows.map((row) => ({
          date:       row.date,
          kwh:        parseFloat(parseFloat(row.kwh).toFixed(3)),
          co2Kg:      parseFloat(parseFloat(row.co2_kg).toFixed(3)),
          randsSaved: parseFloat(parseFloat(row.rands_saved).toFixed(2)),
        })),
        constants: {
          co2KgPerKwh: CO2_KG_PER_KWH,
          randsPerKwh: RANDS_PER_KWH,
        },
      },
    });
  } catch (error) {
    console.error("CO2 endpoint error:", error.message);
    return res.status(500).json({ success: false, message: "Error fetching CO2 data" });
  }
});

// GET /api/analytics/summary
// Full generation summary for the dashboard analytics panel.
//
// Returns:
//   today      — kWh generated today, peak W, avg W
//   week       — kWh this calendar week (Mon–today)
//   month      — kWh this calendar month
//   allTime    — kWh ever generated
//   bestDay    — the single best day (most kWh) on record
//   byInverter — lifetime totals split by inverter (solar vs wind)
//   recentDays — last 7 days of daily kWh / CO2 / savings for a sparkline
app.get("/api/analytics/summary", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    // Reusable subquery: MAX(energy_kwh) per inverter per day.
    // MAX avoids double-counting the simulator's running daily total.
    const dailySubquery = `
      SELECT
        DATE_TRUNC('day', recorded_at) AS day,
        inverter_id,
        MAX(energy_kwh) AS daily_kwh,
        MAX(power_w)    AS peak_w,
        AVG(power_w)    AS avg_w,
        COUNT(*)        AS reading_count
      FROM raw_readings
      WHERE inverter_id IN (SELECT id FROM inverters WHERE user_id = $1)
      GROUP BY DATE_TRUNC('day', recorded_at), inverter_id
    `;

    const todayResult = await pool.query(
      `
      SELECT
        COALESCE(SUM(daily_kwh), 0) AS kwh,
        COALESCE(MAX(peak_w), 0)    AS peak_w,
        COALESCE(AVG(avg_w), 0)     AS avg_w
      FROM (${dailySubquery}) AS d
      WHERE d.day = DATE_TRUNC('day', NOW())
      `,
      [userId],
    );

    // DATE_TRUNC('week', NOW()) returns the Monday of the current ISO week
    const weekResult = await pool.query(
      `
      SELECT COALESCE(SUM(daily_kwh), 0) AS kwh
      FROM (${dailySubquery}) AS d
      WHERE d.day >= DATE_TRUNC('week', NOW())
      `,
      [userId],
    );

    const monthResult = await pool.query(
      `
      SELECT COALESCE(SUM(daily_kwh), 0) AS kwh
      FROM (${dailySubquery}) AS d
      WHERE d.day >= DATE_TRUNC('month', NOW())
      `,
      [userId],
    );

    const allTimeResult = await pool.query(
      `
      SELECT COALESCE(SUM(daily_kwh), 0) AS kwh
      FROM (${dailySubquery}) AS d
      `,
      [userId],
    );

    // NULLS LAST prevents a day with all-null energy_kwh from winning the sort
    const bestDayResult = await pool.query(
      `
      SELECT
        day::DATE      AS date,
        SUM(daily_kwh) AS kwh
      FROM (${dailySubquery}) AS d
      GROUP BY day
      ORDER BY kwh DESC NULLS LAST
      LIMIT 1
      `,
      [userId],
    );

    // Per-inverter lifetime totals (solar vs wind breakdown)
    const byInverterResult = await pool.query(
      `
      SELECT
        i.id,
        i.name,
        i.type,
        i.profile,
        COALESCE(SUM(d.daily_kwh), 0) AS total_kwh,
        COALESCE(MAX(d.peak_w), 0)    AS peak_w,
        COALESCE(AVG(d.avg_w), 0)     AS avg_w
      FROM inverters i
      LEFT JOIN (${dailySubquery}) AS d ON d.inverter_id = i.id
      WHERE i.user_id = $1
      GROUP BY i.id, i.name, i.type, i.profile
      ORDER BY i.type, i.name
      `,
      [userId],
    );

    // Last 7 days — generate_series guarantees all 7 rows even on zero-data days
    const recentDaysResult = await pool.query(
      `
      SELECT
        gs.day::DATE                        AS date,
        COALESCE(SUM(d.daily_kwh), 0)      AS kwh,
        COALESCE(SUM(d.daily_kwh) * $2, 0) AS co2_kg,
        COALESCE(SUM(d.daily_kwh) * $3, 0) AS rands_saved
      FROM generate_series(
        DATE_TRUNC('day', NOW()) - INTERVAL '6 days',
        DATE_TRUNC('day', NOW()),
        INTERVAL '1 day'
      ) AS gs(day)
      LEFT JOIN (${dailySubquery}) AS d ON d.day = gs.day
      GROUP BY gs.day
      ORDER BY gs.day ASC
      `,
      [userId, CO2_KG_PER_KWH, RANDS_PER_KWH],
    );

    const today   = todayResult.rows[0];
    const bestDay = bestDayResult.rows[0] || null;

    return res.status(200).json({
      success: true,
      data: {
        today: {
          kwh:   parseFloat(parseFloat(today.kwh).toFixed(3)),
          peakW: parseFloat(parseFloat(today.peak_w).toFixed(1)),
          avgW:  parseFloat(parseFloat(today.avg_w).toFixed(1)),
          co2Kg: parseFloat((parseFloat(today.kwh) * CO2_KG_PER_KWH).toFixed(3)),
          rands: parseFloat((parseFloat(today.kwh) * RANDS_PER_KWH).toFixed(2)),
        },
        week: {
          kwh:   parseFloat(parseFloat(weekResult.rows[0].kwh).toFixed(3)),
          co2Kg: parseFloat((parseFloat(weekResult.rows[0].kwh) * CO2_KG_PER_KWH).toFixed(3)),
          rands: parseFloat((parseFloat(weekResult.rows[0].kwh) * RANDS_PER_KWH).toFixed(2)),
        },
        month: {
          kwh:   parseFloat(parseFloat(monthResult.rows[0].kwh).toFixed(3)),
          co2Kg: parseFloat((parseFloat(monthResult.rows[0].kwh) * CO2_KG_PER_KWH).toFixed(3)),
          rands: parseFloat((parseFloat(monthResult.rows[0].kwh) * RANDS_PER_KWH).toFixed(2)),
        },
        allTime: {
          kwh:   parseFloat(parseFloat(allTimeResult.rows[0].kwh).toFixed(3)),
          co2Kg: parseFloat((parseFloat(allTimeResult.rows[0].kwh) * CO2_KG_PER_KWH).toFixed(3)),
          rands: parseFloat((parseFloat(allTimeResult.rows[0].kwh) * RANDS_PER_KWH).toFixed(2)),
        },
        bestDay: bestDay
          ? {
              date:  bestDay.date,
              kwh:   parseFloat(parseFloat(bestDay.kwh).toFixed(3)),
              co2Kg: parseFloat((parseFloat(bestDay.kwh) * CO2_KG_PER_KWH).toFixed(3)),
              rands: parseFloat((parseFloat(bestDay.kwh) * RANDS_PER_KWH).toFixed(2)),
            }
          : null,
        byInverter: byInverterResult.rows.map((inv) => ({
          id:       inv.id,
          name:     inv.name,
          type:     inv.type,
          profile:  inv.profile,
          totalKwh: parseFloat(parseFloat(inv.total_kwh).toFixed(3)),
          peakW:    parseFloat(parseFloat(inv.peak_w).toFixed(1)),
          avgW:     parseFloat(parseFloat(inv.avg_w).toFixed(1)),
        })),
        recentDays: recentDaysResult.rows.map((row) => ({
          date:       row.date,
          kwh:        parseFloat(parseFloat(row.kwh).toFixed(3)),
          co2Kg:      parseFloat(parseFloat(row.co2_kg).toFixed(3)),
          randsSaved: parseFloat(parseFloat(row.rands_saved).toFixed(2)),
        })),
      },
    });
  } catch (error) {
    console.error("Analytics summary error:", error.message);
    return res.status(500).json({ success: false, message: "Error fetching analytics summary" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Inverter Routes
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/inverter/summary — live totals + per-inverter detail cards
app.get("/api/inverter/summary", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    // Per-inverter: name, type, profile, serial, firmware, today's totals, live reading
    const inverterResult = await pool.query(
      `SELECT
         i.id, i.name, i.type, i.profile, i.capacity,
         i.serial_number, i.firmware_version,
         COALESCE(SUM(rr.power_w) FILTER (WHERE rr.recorded_at >= CURRENT_DATE), 0)           AS today_sum_power,
         COUNT(rr.id)            FILTER (WHERE rr.recorded_at >= CURRENT_DATE)                AS today_count,
         COALESCE(MAX(rr.energy_kwh) FILTER (WHERE rr.recorded_at >= CURRENT_DATE), 0)        AS today_kwh,
         COALESCE(MAX(rr.load_kwh)   FILTER (WHERE rr.recorded_at >= CURRENT_DATE), 0)        AS today_load_kwh,
         COALESCE(MAX(rr.grid_kwh)   FILTER (WHERE rr.recorded_at >= CURRENT_DATE), 0)        AS today_grid_kwh,
         COALESCE(MAX(rr.power_w)    FILTER (WHERE rr.recorded_at >= CURRENT_DATE), 0)        AS today_peak_w,
         (SELECT rr2.power_w    FROM raw_readings rr2 WHERE rr2.inverter_id = i.id ORDER BY rr2.recorded_at DESC LIMIT 1) AS live_power_w,
         (SELECT rr2.temperature FROM raw_readings rr2 WHERE rr2.inverter_id = i.id ORDER BY rr2.recorded_at DESC LIMIT 1) AS live_temp,
         (SELECT rr2.wind_speed  FROM raw_readings rr2 WHERE rr2.inverter_id = i.id ORDER BY rr2.recorded_at DESC LIMIT 1) AS live_wind_speed,
         (SELECT rr2.rotor_rpm   FROM raw_readings rr2 WHERE rr2.inverter_id = i.id ORDER BY rr2.recorded_at DESC LIMIT 1) AS live_rotor_rpm,
         (SELECT rr2.pitch_angle FROM raw_readings rr2 WHERE rr2.inverter_id = i.id ORDER BY rr2.recorded_at DESC LIMIT 1) AS live_pitch_angle,
         (SELECT rr2.recorded_at FROM raw_readings rr2 WHERE rr2.inverter_id = i.id ORDER BY rr2.recorded_at DESC LIMIT 1) AS last_seen
       FROM inverters i
       LEFT JOIN raw_readings rr ON rr.inverter_id = i.id
       WHERE i.user_id = $1
       GROUP BY i.id`,
      [userId],
    );

    // Battery
    const batteryResult = await pool.query(
      `SELECT br.state_of_charge, br.voltage, br.current, br.temperature, br.power_w, br.recorded_at
       FROM battery_readings br
       JOIN batteries b ON b.id = br.battery_id
       WHERE b.user_id = $1
       ORDER BY br.recorded_at DESC LIMIT 1`,
      [userId],
    );

    // Live solar readings
    const liveSolarResult = await pool.query(
      `SELECT rr.power_w, rr.dc_voltage, rr.dc_current, rr.ac_voltage, rr.frequency, rr.load_watts, rr.grid_kwh
       FROM raw_readings rr
       JOIN inverters i ON i.id = rr.inverter_id
       WHERE i.user_id = $1 AND i.type = 'solar'
       ORDER BY rr.recorded_at DESC LIMIT 1`,
      [userId],
    );

    // Today averages for solar PV fields
    const todaySolarAvgResult = await pool.query(
      `SELECT AVG(rr.dc_voltage) AS avg_pv_volts, AVG(rr.dc_current) AS avg_pv_amps
       FROM raw_readings rr
       JOIN inverters i ON i.id = rr.inverter_id
       WHERE i.user_id = $1 AND i.type = 'solar' AND rr.recorded_at >= CURRENT_DATE`,
      [userId],
    );

    // Live wind readings
    const liveWindResult = await pool.query(
      `SELECT rr.power_w, rr.wind_speed, rr.rotor_rpm, rr.pitch_angle, rr.ac_voltage, rr.frequency, rr.load_watts, rr.grid_kwh
       FROM raw_readings rr
       JOIN inverters i ON i.id = rr.inverter_id
       WHERE i.user_id = $1 AND i.type = 'wind'
       ORDER BY rr.recorded_at DESC LIMIT 1`,
      [userId],
    );

    // Keep a combined live reading for shared grid/inverter fields (prefer solar, fall back to wind)
    const liveElecResult = liveSolarResult.rows.length > 0 ? liveSolarResult : liveWindResult;

    // Overall totals across all inverters
    // all_time_kwh: SUM of each inverter's MAX energy_kwh per day (correct — avoids snapshot overcounting)
    const totalsResult = await pool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN rr.recorded_at >= CURRENT_DATE THEN rr.power_w ELSE 0 END), 0)
           / NULLIF(COUNT(CASE WHEN rr.recorded_at >= CURRENT_DATE THEN 1 END), 0)          AS today_avg_w,
         COALESCE(MAX(CASE WHEN rr.recorded_at >= CURRENT_DATE THEN rr.energy_kwh END), 0)  AS today_kwh,
         COALESCE(MAX(CASE WHEN rr.recorded_at >= CURRENT_DATE THEN rr.load_kwh END), 0)    AS today_load_kwh,
         COALESCE(MAX(CASE WHEN rr.recorded_at >= CURRENT_DATE THEN rr.grid_kwh END), 0)    AS today_grid_kwh,
         COALESCE(MAX(rr.power_w), 0)                                                        AS all_time_peak_w,
         COALESCE((
           SELECT SUM(daily_max)
           FROM (
             SELECT inverter_id, recorded_at::date AS day, MAX(energy_kwh) AS daily_max
             FROM raw_readings
             WHERE inverter_id IN (SELECT id FROM inverters WHERE user_id = $1)
             GROUP BY inverter_id, recorded_at::date
           ) sub
         ), 0)                                                                               AS all_time_kwh
       FROM inverters i
       LEFT JOIN raw_readings rr ON rr.inverter_id = i.id
       WHERE i.user_id = $1`,
      [userId],
    );

    const t     = totalsResult.rows[0];
    const elec  = liveElecResult.rows[0] || {};
    const solar = liveSolarResult.rows[0] || {};
    const wind  = liveWindResult.rows[0] || {};
    const avg   = todaySolarAvgResult.rows[0] || {};

    const todayKwh     = parseFloat(t.today_kwh     || 0);
    const todayLoadKwh = parseFloat(t.today_load_kwh || 0);
    const todayGridKwh = parseFloat(t.today_grid_kwh || 0);
    const allTimeKwh   = parseFloat(t.all_time_kwh   || 0);

    return res.json({
      success: true,
      data: {
        totals: {
          todayKwh:        parseFloat(todayKwh.toFixed(3)),
          todayLoadKwh:    parseFloat(todayLoadKwh.toFixed(3)),
          todayGridKwh:    parseFloat(todayGridKwh.toFixed(3)),
          todayCo2Kg:      parseFloat((todayKwh * CO2_KG_PER_KWH).toFixed(3)),
          todayRandsSaved: parseFloat((todayKwh * RANDS_PER_KWH).toFixed(2)),
          allTimeKwh:      parseFloat(allTimeKwh.toFixed(3)),
          allTimeCo2Kg:    parseFloat((allTimeKwh * CO2_KG_PER_KWH).toFixed(3)),
          allTimeRands:    parseFloat((allTimeKwh * RANDS_PER_KWH).toFixed(2)),
          todayAvgW:       parseFloat(parseFloat(t.today_avg_w || 0).toFixed(1)),
          allTimePeakW:    parseFloat(parseFloat(t.all_time_peak_w || 0).toFixed(1)),
        },
        electrical: {
          // Solar
          solarWatts:    solar.power_w    != null ? parseFloat(parseFloat(solar.power_w).toFixed(1))    : null,
          avgPvVolts:    avg.avg_pv_volts != null ? parseFloat(parseFloat(avg.avg_pv_volts).toFixed(1)) : null,
          avgPvAmps:     avg.avg_pv_amps  != null ? parseFloat(parseFloat(avg.avg_pv_amps).toFixed(3))  : null,
          // Wind
          windWatts:     wind.power_w     != null ? parseFloat(parseFloat(wind.power_w).toFixed(1))     : null,
          windSpeed:     wind.wind_speed  != null ? parseFloat(parseFloat(wind.wind_speed).toFixed(2))  : null,
          rotorRpm:      wind.rotor_rpm   != null ? parseFloat(parseFloat(wind.rotor_rpm).toFixed(1))   : null,
          // Grid & inverter (shared)
          gridVoltage:   elec.ac_voltage  != null ? parseFloat(parseFloat(elec.ac_voltage).toFixed(1))  : null,
          gridFrequency: elec.frequency   != null ? parseFloat(parseFloat(elec.frequency).toFixed(2))   : null,
          gridKwhUsed:   elec.grid_kwh    != null ? parseFloat(parseFloat(elec.grid_kwh).toFixed(3))    : null,
          invVoltage:    elec.dc_voltage  != null ? parseFloat(parseFloat(elec.dc_voltage).toFixed(1))  : null,
          invLoadWatts:  elec.load_watts  != null ? parseFloat(parseFloat(elec.load_watts).toFixed(1))  : null,
          invFrequency:  elec.frequency   != null ? parseFloat(parseFloat(elec.frequency).toFixed(2))   : null,
        },
        inverters: inverterResult.rows.map((inv) => ({
          id:              inv.id,
          name:            inv.name,
          type:            inv.type,
          profile:         inv.profile,
          capacity:        parseFloat(inv.capacity || 0),
          serialNumber:    inv.serial_number,
          firmwareVersion: inv.firmware_version,
          todayKwh:        parseFloat(parseFloat(inv.today_kwh || 0).toFixed(3)),
          todayLoadKwh:    parseFloat(parseFloat(inv.today_load_kwh || 0).toFixed(3)),
          todayGridKwh:    parseFloat(parseFloat(inv.today_grid_kwh || 0).toFixed(3)),
          todayPeakW:      parseFloat(parseFloat(inv.today_peak_w || 0).toFixed(1)),
          livePowerW:      inv.live_power_w  != null ? parseFloat(parseFloat(inv.live_power_w).toFixed(1))  : null,
          liveTemp:        inv.live_temp     != null ? parseFloat(parseFloat(inv.live_temp).toFixed(1))     : null,
          liveWindSpeed:   inv.live_wind_speed  != null ? parseFloat(parseFloat(inv.live_wind_speed).toFixed(2))  : null,
          liveRotorRpm:    inv.live_rotor_rpm   != null ? parseFloat(parseFloat(inv.live_rotor_rpm).toFixed(1))   : null,
          livePitchAngle:  inv.live_pitch_angle != null ? parseFloat(parseFloat(inv.live_pitch_angle).toFixed(1)) : null,
          lastSeen:        inv.last_seen || null,
        })),
        battery: batteryResult.rows.length > 0 ? {
          soc:         parseFloat(parseFloat(batteryResult.rows[0].state_of_charge || 0).toFixed(1)),
          voltage:     parseFloat(parseFloat(batteryResult.rows[0].voltage || 0).toFixed(2)),
          current:     parseFloat(parseFloat(batteryResult.rows[0].current || 0).toFixed(3)),
          temperature: parseFloat(parseFloat(batteryResult.rows[0].temperature || 0).toFixed(1)),
          powerW:      parseFloat(parseFloat(batteryResult.rows[0].power_w || 0).toFixed(1)),
          lastSeen:    batteryResult.rows[0].recorded_at,
        } : null,
      },
    });
  } catch (error) {
    console.error("Inverter summary error:", error.message);
    return res.status(500).json({ success: false, message: "Error fetching inverter summary" });
  }
});

// GET /api/inverter/analytics?source=solar|wind&date=YYYY-MM-DD&detail=min|moderate|max
app.get("/api/inverter/analytics", authenticateToken, async (req, res) => {
  try {
    const userId  = req.user.id;
    const source  = req.query.source  || "solar";
    const date    = req.query.date    || new Date().toISOString().slice(0, 10);
    const detail  = req.query.detail  || "moderate";

    // Bucket size per detail level
    const bucketMap = { min: "10 minutes", moderate: "30 minutes", max: "1 hour" };
    const bucket    = bucketMap[detail] || "30 minutes";

    // Fetch inverter IDs matching the source type for this user
    const invResult = await pool.query(
      "SELECT id FROM inverters WHERE user_id = $1 AND type = $2",
      [userId, source],
    );
    if (invResult.rows.length === 0) {
      return res.json({ success: true, data: [] });
    }
    const inverterIds = invResult.rows.map((r) => r.id);

    const result = await pool.query(
      `SELECT
         DATE_TRUNC('minute', recorded_at) - (
           EXTRACT(MINUTE FROM recorded_at)::int % $1 * INTERVAL '1 minute'
         ) AS bucket,
         AVG(power_w)     AS avg_power_w,
         AVG(load_watts)  AS avg_load_watts,
         AVG(grid_watts)  AS avg_grid_watts,
         MAX(power_w)     AS peak_power_w,
         AVG(temperature) AS avg_temp
       FROM raw_readings
       WHERE inverter_id = ANY($2)
         AND recorded_at::date = $3::date
       GROUP BY 1
       ORDER BY 1 ASC`,
      [
        detail === "min" ? 10 : detail === "max" ? 60 : 30,
        inverterIds,
        date,
      ],
    );

    // Battery SOC for dual-axis chart (independent of source filter)
    const batteryResult = await pool.query(
      `SELECT
         DATE_TRUNC('minute', br.recorded_at) - (
           EXTRACT(MINUTE FROM br.recorded_at)::int % $1 * INTERVAL '1 minute'
         ) AS bucket,
         AVG(br.state_of_charge) AS avg_soc,
         AVG(br.voltage)         AS avg_voltage
       FROM battery_readings br
       JOIN batteries b ON b.id = br.battery_id
       WHERE b.user_id = $2
         AND br.recorded_at::date = $3::date
       GROUP BY 1
       ORDER BY 1 ASC`,
      [
        detail === "min" ? 10 : detail === "max" ? 60 : 30,
        userId,
        date,
      ],
    );

    return res.json({
      success: true,
      data: {
        power: result.rows.map((r) => ({
          time:       r.bucket,
          avgPowerW:  parseFloat(parseFloat(r.avg_power_w  || 0).toFixed(1)),
          avgLoadW:   parseFloat(parseFloat(r.avg_load_watts || 0).toFixed(1)),
          avgGridW:   parseFloat(parseFloat(r.avg_grid_watts || 0).toFixed(1)),
          peakPowerW: parseFloat(parseFloat(r.peak_power_w || 0).toFixed(1)),
          avgTemp:    parseFloat(parseFloat(r.avg_temp || 0).toFixed(1)),
        })),
        battery: batteryResult.rows.map((r) => ({
          time:    r.bucket,
          avgSoc:  parseFloat(parseFloat(r.avg_soc     || 0).toFixed(2)),
          avgVolt: parseFloat(parseFloat(r.avg_voltage || 0).toFixed(2)),
        })),
      },
    });
  } catch (error) {
    console.error("Inverter analytics error:", error.message);
    return res.status(500).json({ success: false, message: "Error fetching inverter analytics" });
  }
});

// GET /api/inverter/analytics/export — CSV download of same data
app.get("/api/inverter/analytics/export", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const source = req.query.source || "solar";
    const date   = req.query.date   || new Date().toISOString().slice(0, 10);
    const detail = req.query.detail || "moderate";

    const invResult = await pool.query(
      "SELECT id FROM inverters WHERE user_id = $1 AND type = $2",
      [userId, source],
    );
    if (invResult.rows.length === 0) {
      const safeSource = (source || "solar").replace(/[^a-z0-9-]/gi, "");
      const safeDate   = (date   || "").replace(/[^0-9-]/g, "");
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="inverter-${safeSource}-${safeDate}.csv"`);
      return res.send("time,avg_power_w,avg_load_w,avg_grid_w,peak_power_w,avg_temp\n");
    }
    const inverterIds = invResult.rows.map((r) => r.id);

    const result = await pool.query(
      `SELECT
         DATE_TRUNC('minute', recorded_at) - (
           EXTRACT(MINUTE FROM recorded_at)::int % $1 * INTERVAL '1 minute'
         ) AS bucket,
         AVG(power_w)     AS avg_power_w,
         AVG(load_watts)  AS avg_load_watts,
         AVG(grid_watts)  AS avg_grid_watts,
         MAX(power_w)     AS peak_power_w,
         AVG(temperature) AS avg_temp
       FROM raw_readings
       WHERE inverter_id = ANY($2)
         AND recorded_at::date = $3::date
       GROUP BY 1
       ORDER BY 1 ASC`,
      [
        detail === "min" ? 10 : detail === "max" ? 60 : 30,
        inverterIds,
        date,
      ],
    );

    const lines = [
      "time,avg_power_w,avg_load_w,avg_grid_w,peak_power_w,avg_temp",
      ...result.rows.map((r) =>
        [
          r.bucket,
          parseFloat(r.avg_power_w   || 0).toFixed(1),
          parseFloat(r.avg_load_watts || 0).toFixed(1),
          parseFloat(r.avg_grid_watts || 0).toFixed(1),
          parseFloat(r.peak_power_w   || 0).toFixed(1),
          parseFloat(r.avg_temp       || 0).toFixed(1),
        ].join(","),
      ),
    ];

    const safeSource = (source || "solar").replace(/[^a-z0-9-]/gi, "");
    const safeDate   = (date   || "").replace(/[^0-9-]/g, "");
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="inverter-${safeSource}-${safeDate}.csv"`);
    return res.send(lines.join("\n"));
  } catch (error) {
    console.error("Inverter export error:", error.message);
    return res.status(500).json({ success: false, message: "Error exporting inverter data" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Error Handlers
// ═══════════════════════════════════════════════════════════════════════════

app.use((req, res) => {
  res.status(404).json({ success: false, message: "Route not found" });
});

app.use((error, req, res, next) => {
  console.error("Server error:", error.message);
  res.status(500).json({ success: false, message: "Internal server error" });
});

// ═══════════════════════════════════════════════════════════════════════════
// Server Start
// ═══════════════════════════════════════════════════════════════════════════

app.listen(PORT, "0.0.0.0", async () => {
  console.log(`Server running on port ${PORT}`);

  // Backfill serial_number and firmware_version for any inverters that were
  // created before these columns existed (they would be NULL after the migration).
  try {
    const missing = await pool.query(
      "SELECT id, profile, type FROM inverters WHERE serial_number IS NULL",
    );
    if (missing.rows.length > 0) {
      const firmwareMap = {
        "solar-small": "FW-2.1.4",
        "solar-large": "FW-2.3.1",
        "wind-small":  "FW-3.0.2",
        "wind-large":  "FW-3.2.0",
      };
      for (const inv of missing.rows) {
        const prefix  = inv.type === "solar" ? "VE-SOL" : "VE-WND";
        const serial  = `${prefix}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
        const fw      = firmwareMap[inv.profile] || "FW-1.0.0";
        await pool.query(
          "UPDATE inverters SET serial_number = $1, firmware_version = $2 WHERE id = $3",
          [serial, fw, inv.id],
        );
      }
      console.log(`[startup] Backfilled serial/firmware for ${missing.rows.length} inverter(s).`);
    }
  } catch (err) {
    console.error("[startup] Serial backfill failed:", err.message);
  }

  // Give the DB a 3-second head start before launching simulators
  setTimeout(() => launcher.startAllSimulators(), 3000);
});
