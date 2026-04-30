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
const swaggerUi  = require("swagger-ui-express");
const swaggerDoc = require("./swagger.json");

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

// PayFast sandbox config
const PF_MERCHANT_ID  = process.env.PAYFAST_MERCHANT_ID  || "10000100";
const PF_MERCHANT_KEY = process.env.PAYFAST_MERCHANT_KEY || "46f0cd694581a";
const PF_PASSPHRASE   = process.env.PAYFAST_PASSPHRASE   || "jt7NOE43FZPn";
const PF_SANDBOX      = process.env.PAYFAST_SANDBOX === "true";
const PF_HOST         = PF_SANDBOX ? "https://sandbox.payfast.co.za/eng/process" : "https://www.payfast.co.za/eng/process";
const PF_RETURN_URL   = process.env.PAYFAST_RETURN_URL  || "http://localhost:5500/frontend/Wallet.html?payment=success";
const PF_CANCEL_URL   = process.env.PAYFAST_CANCEL_URL  || "http://localhost:5500/frontend/Wallet.html?payment=cancelled";
const PF_NOTIFY_URL   = process.env.PAYFAST_NOTIFY_URL  || "http://localhost:3000/api/wallet/payfast/notify";

function generatePayfastSignature(data) {
  const pfOutput = [];
  for (const [key, val] of Object.entries(data)) {
    if (val !== undefined && val !== "") {
      pfOutput.push(`${key}=${String(val).trim()}`);
    }
  }
  let pfParamString = pfOutput.join("&");
  if (PF_PASSPHRASE) {
    pfParamString += `&passphrase=${PF_PASSPHRASE.trim()}`;
  }
  console.log("[PayFast] Signature string:", pfParamString);
  return crypto.createHash("md5").update(pfParamString).digest("hex");
}

// ── Create notifications table if it doesn't exist yet ───────────────────────
pool.query(`
  CREATE TABLE IF NOT EXISTS notifications (
    id           SERIAL PRIMARY KEY,
    user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
    type         VARCHAR(50)  NOT NULL,
    title        VARCHAR(255) NOT NULL,
    message      TEXT         NOT NULL,
    is_read      BOOLEAN      DEFAULT FALSE,
    metadata     JSONB,
    created_at   TIMESTAMP WITH TIME ZONE DEFAULT NOW()
  )
`).catch(err => console.error("[startup] notifications table:", err.message));

// ── Create wallet tables if they don't exist yet ─────────────────────────────
pool.query(`
  CREATE TABLE IF NOT EXISTS wallets (
    id         SERIAL PRIMARY KEY,
    user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE UNIQUE,
    balance    DECIMAL(10,2) NOT NULL DEFAULT 1000.00,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS wallet_transactions (
    id               SERIAL PRIMARY KEY,
    user_id          INTEGER REFERENCES users(id) ON DELETE CASCADE,
    type             VARCHAR(30) NOT NULL,
    direction        VARCHAR(10) NOT NULL,
    amount           DECIMAL(10,2) NOT NULL,
    balance_after    DECIMAL(10,2) NOT NULL,
    description      TEXT,
    counter_party_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at       TIMESTAMP WITH TIME ZONE DEFAULT NOW()
  );
`).catch(err => console.error("[startup] wallet tables:", err.message));

// In-memory cache for Open-Meteo weather responses (current + forecast).
// Keyed by "lat,lng" for current weather and "forecast:lat,lng" for forecasts.
// Each entry: { fetchedAt: <epoch ms>, data: <response object> }
const weatherCache = {};

// ═══════════════════════════════════════════════════════════════════════════
// Middleware
// ═══════════════════════════════════════════════════════════════════════════
app.use(cors({ origin: process.env.FRONTEND_URL }));
app.use(express.json());
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerDoc, { explorer: true }));
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
           load_watts, load_kwh, grid_watts, grid_kwh, cloud_cover)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
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
          data.cloud_cover   ?? null,
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
      "SELECT id, username, email, avatar_color, created_at FROM users WHERE id = $1",
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

app.put("/api/profile/avatar-color", authenticateToken, async (req, res) => {
  try {
    const { color } = req.body;
    if (!color || !/^#[0-9a-fA-F]{6}$/.test(color)) {
      return res.status(400).json({ success: false, message: "Invalid color format" });
    }
    await pool.query("UPDATE users SET avatar_color = $1 WHERE id = $2", [color, req.user.id]);
    return res.json({ success: true });
  } catch (error) {
    console.error("Avatar color error:", error.message);
    return res.status(500).json({ success: false, message: "Error updating avatar color" });
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
    const result        = await pool.query("SELECT * FROM inverters WHERE user_id = $1", [req.user.id]);
    const userResult    = await pool.query("SELECT role, location FROM users WHERE id = $1", [req.user.id]);
    const batteryResult = await pool.query("SELECT id, capacity_kwh FROM batteries WHERE user_id = $1", [req.user.id]);

    return res.status(200).json({
      success:    true,
      hasSetup:   result.rows.length > 0 || batteryResult.rows.length > 0,
      hasBattery: batteryResult.rows.length > 0,
      inverters:  result.rows,
      battery:    batteryResult.rows[0] || null,
      role:       userResult.rows[0].role,
      location:   userResult.rows[0].location,
    });
  } catch (error) {
    console.error("Setup status error:", error.message);
    return res.status(500).json({ success: false, message: "Error checking setup status" });
  }
});

// POST /api/setup/battery-only — setup for consumers with battery but no generation
app.post("/api/setup/battery-only", authenticateToken, async (req, res) => {
  try {
    const { capacity_kwh, location, lat, lng } = req.body;
    const cap = parseFloat(capacity_kwh) || 10;

    // Check if battery already exists
    const existing = await pool.query("SELECT id FROM batteries WHERE user_id = $1", [req.user.id]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ success: false, message: "Battery already set up" });
    }

    // Create battery
    const battResult = await pool.query(
      "INSERT INTO batteries (user_id, name, capacity_kwh) VALUES ($1, $2, $3) RETURNING *",
      [req.user.id, "Home Battery", cap],
    );

    // Update user location (keep role as consumer)
    await pool.query(
      "UPDATE users SET location = $1, lat = $2, lng = $3 WHERE id = $4",
      [location || null, lat, lng, req.user.id],
    );

    // Seed initial battery reading at 50% SOC
    const battId  = battResult.rows[0].id;
    const voltage = 48 + (50 / 100) * 6; // 51V at 50%
    await pool.query(
      `INSERT INTO battery_readings (battery_id, state_of_charge, voltage, current, temperature, power_w, recorded_at)
       VALUES ($1, 50, $2, 0, 25, 0, NOW())`,
      [battId, voltage.toFixed(2)],
    );

    return res.status(201).json({
      success: true,
      message: "Battery setup complete",
      data: battResult.rows[0],
    });
  } catch (error) {
    console.error("Battery-only setup error:", error.message);
    return res.status(500).json({ success: false, message: "Error setting up battery" });
  }
});

// ── Historic data seed for demo ──────────────────────────────────────────────
let seedDataCache = null;
async function seedHistoricData(inverterId, userId) {
  try {
    if (!seedDataCache) {
      const fs   = require("fs");
      const file = require("path").join(__dirname, "seed-solar-large.json");
      if (!fs.existsSync(file)) { console.log("[seed] No seed file found"); return; }
      seedDataCache = JSON.parse(fs.readFileSync(file, "utf8"));
      console.log(`[seed] Loaded ${seedDataCache.rawReadings.length} readings`);
    }

    const battResult = await pool.query(
      "SELECT id FROM batteries WHERE user_id = $1 LIMIT 1", [userId]
    );
    const batteryId = battResult.rows[0]?.id;

    // Insert raw readings in batches of 500
    const raw = seedDataCache.rawReadings;
    const batchSize = 500;
    for (let i = 0; i < raw.length; i += batchSize) {
      const batch = raw.slice(i, i + batchSize);
      const values = [];
      const params = [];
      let p = 1;
      for (const r of batch) {
        values.push(`($${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++})`);
        params.push(inverterId, r.power_w, r.dc_voltage, r.dc_current, r.ac_voltage,
          r.ac_current, r.frequency, r.temperature, r.energy_kwh, r.load_watts,
          r.grid_watts, r.cloud_cover, r.wind_speed || 0, r.recorded_at, 0);
      }
      await pool.query(
        `INSERT INTO raw_readings (inverter_id, power_w, dc_voltage, dc_current, ac_voltage,
          ac_current, frequency, temperature, energy_kwh, load_watts,
          grid_watts, cloud_cover, wind_speed, recorded_at, load_kwh)
         VALUES ${values.join(",")}`,
        params
      );
    }

    // Insert battery readings
    if (batteryId) {
      const bat = seedDataCache.batteryReadings;
      for (let i = 0; i < bat.length; i += batchSize) {
        const batch = bat.slice(i, i + batchSize);
        const values = [];
        const params = [];
        let p = 1;
        for (const r of batch) {
          values.push(`($${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++})`);
          params.push(batteryId, r.state_of_charge, r.voltage, r.current, r.temperature, r.power_w, r.recorded_at);
        }
        await pool.query(
          `INSERT INTO battery_readings (battery_id, state_of_charge, voltage, current, temperature, power_w, recorded_at)
           VALUES ${values.join(",")}`,
          params
        );
      }
    }

    console.log(`[seed] Inserted ${raw.length} raw + ${batteryId ? raw.length : 0} battery readings for inverter ${inverterId}`);
  } catch (err) {
    console.error("[seed] Error seeding historic data:", err.message);
  }
}

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

    // Seed historic data for solar-large demo
    if (profile === "solar-large") {
      seedHistoricData(result.rows[0].id, req.user.id);
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
        rr.load_watts,
        rr.grid_watts,
        rr.cloud_cover,
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

    let rows = result.rows;

    // Battery-only user: no inverters, so query battery directly
    if (rows.length === 0) {
      const battOnly = await pool.query(
        `SELECT
           NULL AS inverter_id, 'battery' AS type, NULL AS profile,
           0 AS power_w, 0 AS dc_voltage, 0 AS dc_current, 0 AS ac_voltage,
           0 AS ac_current, 0 AS frequency, 0 AS inverter_temp, 0 AS energy_kwh,
           0 AS wind_speed, 0 AS rotor_rpm, 0 AS pitch_angle, 0 AS load_watts,
           0 AS grid_watts, 0 AS cloud_cover,
           br.state_of_charge, br.voltage AS battery_voltage,
           br.current AS battery_current, br.temperature AS battery_temp,
           br.power_w AS battery_power, br.recorded_at
         FROM batteries b
         LEFT JOIN LATERAL (
           SELECT * FROM battery_readings WHERE battery_id = b.id ORDER BY recorded_at DESC LIMIT 1
         ) br ON true
         WHERE b.user_id = $1`,
        [req.user.id],
      );
      rows = battOnly.rows;
    }

    const solar      = rows.filter((r) => r.type === "solar");
    const wind       = rows.filter((r) => r.type === "wind");
    const totalPower = rows.reduce((sum, r) => sum + (parseFloat(r.power_w) || 0), 0);

    return res.status(200).json({
      success: true,
      data: {
        all:          rows,
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

// GET /api/battery — battery capacity + latest SOC for the logged-in user
app.get("/api/battery", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT b.capacity_kwh,
              br.state_of_charge
       FROM   batteries b
       LEFT JOIN LATERAL (
         SELECT state_of_charge
         FROM   battery_readings
         WHERE  battery_id = b.id
         ORDER  BY recorded_at DESC
         LIMIT  1
       ) br ON true
       WHERE b.user_id = $1
       LIMIT 1`,
      [req.user.id]
    );
    if (!result.rows[0]) {
      return res.status(404).json({ success: false, message: "No battery found" });
    }
    const { capacity_kwh, state_of_charge } = result.rows[0];
    return res.status(200).json({
      success: true,
      data: {
        capacityKwh: parseFloat(capacity_kwh) || 10,
        soc:         parseFloat(state_of_charge) || 0,
      },
    });
  } catch (error) {
    console.error("Battery endpoint error:", error.message);
    return res.status(500).json({ success: false, message: "Error fetching battery data" });
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

    // Today's kWh — MAX running total per inverter today, summed.
    // Using MAX rather than the latest reading means a simulator restart
    // (which resets energyToday to 0) won't wipe out the day's accumulated value.
    const todayResult = await pool.query(
      `
      SELECT COALESCE(SUM(max_kwh), 0) AS today_kwh
      FROM (
        SELECT inverter_id, MAX(energy_kwh) AS max_kwh
        FROM raw_readings
        WHERE inverter_id IN (SELECT id FROM inverters WHERE user_id = $1)
          AND recorded_at >= DATE_TRUNC('day', NOW())
        GROUP BY inverter_id
      ) AS max_per_inverter
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

// GET /api/inverter/efficiency?source=solar|wind&days=30
app.get("/api/inverter/efficiency", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const source = req.query.source || "solar";
    const days   = Math.min(parseInt(req.query.days) || 30, 90);

    const invResult = await pool.query(
      "SELECT id, type, capacity, created_at FROM inverters WHERE user_id = $1 AND type = $2",
      [userId, source],
    );
    if (invResult.rows.length === 0) {
      return res.json({ success: true, data: { inverters: [], totalCapacity: 0, daily: [] } });
    }

    const inverters   = invResult.rows;
    const inverterIds = inverters.map((r) => r.id);
    const totalCapacity = inverters.reduce((sum, r) => sum + (parseFloat(r.capacity) || 0), 0);

    const daily = await pool.query(
      `SELECT
         recorded_at::date        AS date,
         AVG(power_w)             AS avg_power_w,
         MAX(power_w)             AS peak_power_w,
         MAX(energy_kwh)          AS daily_kwh,
         AVG(temperature)         AS avg_temp,
         AVG(cloud_cover)         AS avg_cloud_cover,
         AVG(wind_speed)          AS avg_wind_speed
       FROM raw_readings
       WHERE inverter_id = ANY($1)
         AND recorded_at >= CURRENT_DATE - ($2 || ' days')::interval
       GROUP BY recorded_at::date
       ORDER BY date ASC`,
      [inverterIds, String(days)],
    );

    return res.json({
      success: true,
      data: {
        inverters: inverters.map((r) => ({
          id: r.id,
          type: r.type,
          capacity: parseFloat(r.capacity) || 0,
          createdAt: r.created_at,
        })),
        totalCapacity,
        daily: daily.rows.map((r) => ({
          date:          r.date,
          avgPowerW:     parseFloat(parseFloat(r.avg_power_w     || 0).toFixed(1)),
          peakPowerW:    parseFloat(parseFloat(r.peak_power_w    || 0).toFixed(1)),
          dailyKwh:      parseFloat(parseFloat(r.daily_kwh       || 0).toFixed(3)),
          avgTemp:       parseFloat(parseFloat(r.avg_temp        || 0).toFixed(1)),
          avgCloudCover: parseFloat(parseFloat(r.avg_cloud_cover || 0).toFixed(1)),
          avgWindSpeed:  parseFloat(parseFloat(r.avg_wind_speed  || 0).toFixed(1)),
        })),
      },
    });
  } catch (error) {
    console.error("Inverter efficiency error:", error.message);
    return res.status(500).json({ success: false, message: "Error fetching efficiency data" });
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
// Community Energy Sharing
// ═══════════════════════════════════════════════════════════════════════════

// ── Notification helper ───────────────────────────────────────────────────────
async function createNotification(userId, type, title, message, metadata = {}) {
  try {
    await pool.query(
      `INSERT INTO notifications (user_id, type, title, message, metadata)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, type, title, message, JSON.stringify(metadata)]
    );
  } catch (err) {
    console.error("[notification] create error:", err.message);
  }
}

// ── Energy transfer: adjusts SOC for both parties & records grid export ───────
// sellerUserId — the user sending energy
// buyerUserId  — the user receiving energy
// amountKwh    — kWh being transferred
async function applyEnergyTransfer(sellerUserId, buyerUserId, amountKwh) {
  const INTERVAL_HOURS = 30 / 3600; // simulators run every 30 s

  // Helper to adjust a user's battery SOC
  async function adjustSoc(userId, deltaKwh) {
    const r = await pool.query(
      `SELECT b.id, b.capacity_kwh, br.state_of_charge, br.voltage, br.current, br.temperature, br.power_w
       FROM batteries b
       LEFT JOIN LATERAL (
         SELECT state_of_charge, voltage, current, temperature, power_w
         FROM battery_readings WHERE battery_id = b.id ORDER BY recorded_at DESC LIMIT 1
       ) br ON true
       WHERE b.user_id = $1 LIMIT 1`,
      [userId]
    );
    if (!r.rows[0]) return;
    const { id: battId, capacity_kwh, state_of_charge, voltage, current, temperature, power_w } = r.rows[0];
    const cap    = parseFloat(capacity_kwh) || 10;
    const soc    = parseFloat(state_of_charge) || 0;
    const newSoc = Math.min(100, Math.max(0, soc + (deltaKwh / cap) * 100));
    await pool.query(
      `INSERT INTO battery_readings (battery_id, state_of_charge, voltage, current, temperature, power_w, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [battId, newSoc.toFixed(2), voltage, current, temperature, power_w]
    );
  }

  // Seller loses energy, buyer gains it
  await adjustSoc(sellerUserId, -amountKwh);
  await adjustSoc(buyerUserId,  +amountKwh);

  // Insert a grid export reading for the seller (negative = exporting)
  const exportWatts = -(amountKwh / INTERVAL_HOURS);
  try {
    const inv = await pool.query(
      `SELECT id FROM inverters WHERE user_id = $1 ORDER BY id LIMIT 1`,
      [sellerUserId]
    );
    if (inv.rows[0]) {
      const invId = inv.rows[0].id;
      await pool.query(
        `INSERT INTO raw_readings
           (inverter_id, power_w, dc_voltage, dc_current, ac_voltage, ac_current,
            frequency, temperature, energy_kwh, load_watts, load_kwh, grid_watts, grid_kwh, recorded_at)
         SELECT inverter_id, power_w, dc_voltage, dc_current, ac_voltage, ac_current,
                frequency, temperature, energy_kwh, load_watts, load_kwh,
                $2,
                COALESCE(grid_kwh, 0) + $3,
                NOW()
         FROM raw_readings WHERE inverter_id = $1 ORDER BY recorded_at DESC LIMIT 1`,
        [invId, exportWatts, amountKwh]
      );
    }
  } catch (err) {
    console.error("[transfer] grid reading insert:", err.message);
  }
}

function isSameArea(user1, user2) {
  if (!user1.location || !user2.location) return false;
  return user1.location.trim().toLowerCase() === user2.location.trim().toLowerCase();
}

async function getUserSoc(userId) {
  const result = await pool.query(
    `SELECT br.state_of_charge
     FROM batteries b
     JOIN battery_readings br ON br.battery_id = b.id
     WHERE b.user_id = $1
     ORDER BY br.recorded_at DESC
     LIMIT 1`,
    [userId]
  );
  return result.rows[0]?.state_of_charge ?? null;
}

// Returns { soc, capacityKwh, availableKwh } for sharing validation.
// availableKwh = stored energy minus already-listed (unfilled) sales/donations.
async function getUserShareableKwh(userId) {
  const battResult = await pool.query(
    `SELECT b.capacity_kwh, br.state_of_charge
     FROM batteries b
     LEFT JOIN LATERAL (
       SELECT state_of_charge FROM battery_readings
       WHERE battery_id = b.id ORDER BY recorded_at DESC LIMIT 1
     ) br ON true
     WHERE b.user_id = $1 LIMIT 1`,
    [userId]
  );
  if (!battResult.rows[0]) return null;
  const { capacity_kwh, state_of_charge } = battResult.rows[0];
  const soc          = parseFloat(state_of_charge) || 0;
  const capacityKwh  = parseFloat(capacity_kwh)    || 10;
  const storedKwh    = capacityKwh * (soc / 100);

  // Sum all unfilled outgoing listings (sales) already posted by this user
  const listedResult = await pool.query(
    `SELECT COALESCE(SUM(amount_kwh), 0) AS total
     FROM energy_sales
     WHERE user_id = $1 AND is_filled = FALSE`,
    [userId]
  );
  const alreadyListed = parseFloat(listedResult.rows[0].total) || 0;
  const availableKwh  = Math.max(0, storedKwh - alreadyListed);
  return { soc, capacityKwh, availableKwh };
}

// Returns available space for requests: battery empty space minus already-posted unfilled requests.
// For users with no battery, returns { noBattery: true, remaining } where remaining = 10 - already requested.
const NO_BATTERY_MAX_PER_REQUEST  = 2;   // kWh cap per single request
const NO_BATTERY_MAX_OUTSTANDING  = 10;  // kWh cap on total unfilled requests

async function getUserRequestableKwh(userId) {
  const battResult = await pool.query(
    `SELECT b.capacity_kwh, br.state_of_charge
     FROM batteries b
     LEFT JOIN LATERAL (
       SELECT state_of_charge FROM battery_readings
       WHERE battery_id = b.id ORDER BY recorded_at DESC LIMIT 1
     ) br ON true
     WHERE b.user_id = $1 LIMIT 1`,
    [userId]
  );

  if (!battResult.rows[0]) {
    // No battery — apply community cap
    const reqResult = await pool.query(
      `SELECT COALESCE(SUM(amount_kwh), 0) AS total
       FROM energy_requests
       WHERE user_id = $1 AND is_filled = FALSE`,
      [userId]
    );
    const alreadyRequested = parseFloat(reqResult.rows[0].total) || 0;
    return { noBattery: true, remaining: Math.max(0, NO_BATTERY_MAX_OUTSTANDING - alreadyRequested) };
  }

  const { capacity_kwh, state_of_charge } = battResult.rows[0];
  const soc         = parseFloat(state_of_charge) || 0;
  const capacityKwh = parseFloat(capacity_kwh)    || 10;
  const emptyKwh    = capacityKwh * ((100 - soc) / 100);

  const reqResult = await pool.query(
    `SELECT COALESCE(SUM(amount_kwh), 0) AS total
     FROM energy_requests
     WHERE user_id = $1 AND is_filled = FALSE`,
    [userId]
  );
  const alreadyRequested = parseFloat(reqResult.rows[0].total) || 0;
  return Math.max(0, emptyKwh - alreadyRequested);
}

// ── Wallet helpers ────────────────────────────────────────────────────────────

async function getOrCreateWallet(userId) {
  await pool.query(
    `INSERT INTO wallets (user_id, balance) VALUES ($1, 0.00) ON CONFLICT (user_id) DO NOTHING`,
    [userId]
  );
  const result = await pool.query(`SELECT * FROM wallets WHERE user_id = $1`, [userId]);
  return result.rows[0];
}

async function transferWallet(fromUserId, toUserId, amount, description) {
  const from = await getOrCreateWallet(fromUserId);
  if (parseFloat(from.balance) < amount) {
    throw new Error(`Insufficient wallet balance (R${parseFloat(from.balance).toFixed(2)} available, R${amount.toFixed(2)} required)`);
  }
  const newFromBal = parseFloat(from.balance) - amount;
  await pool.query(`UPDATE wallets SET balance = $1 WHERE user_id = $2`, [newFromBal.toFixed(2), fromUserId]);
  await pool.query(
    `INSERT INTO wallet_transactions (user_id, type, direction, amount, balance_after, description, counter_party_id)
     VALUES ($1,'transfer','debit',$2,$3,$4,$5)`,
    [fromUserId, amount.toFixed(2), newFromBal.toFixed(2), description, toUserId]
  );

  const to = await getOrCreateWallet(toUserId);
  const newToBal = parseFloat(to.balance) + amount;
  await pool.query(`UPDATE wallets SET balance = $1 WHERE user_id = $2`, [newToBal.toFixed(2), toUserId]);
  await pool.query(
    `INSERT INTO wallet_transactions (user_id, type, direction, amount, balance_after, description, counter_party_id)
     VALUES ($1,'transfer','credit',$2,$3,$4,$5)`,
    [toUserId, amount.toFixed(2), newToBal.toFixed(2), description, fromUserId]
  );
}

// ── Wallet endpoints ──────────────────────────────────────────────────────────

app.get("/api/wallet", authenticateToken, async (req, res) => {
  try {
    const wallet = await getOrCreateWallet(req.user.id);
    return res.status(200).json({ success: true, data: wallet });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Error fetching wallet" });
  }
});

app.get("/api/wallet/transactions", authenticateToken, async (req, res) => {
  try {
    await getOrCreateWallet(req.user.id);
    const result = await pool.query(
      `SELECT wt.*, u.username AS counter_party_name
       FROM wallet_transactions wt
       LEFT JOIN users u ON u.id = wt.counter_party_id
       WHERE wt.user_id = $1
       ORDER BY wt.created_at DESC
       LIMIT 50`,
      [req.user.id]
    );
    return res.status(200).json({ success: true, data: result.rows });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Error fetching transactions" });
  }
});

// POST /api/wallet/payfast/initiate — create pending payment + return form fields for redirect
app.post("/api/wallet/payfast/initiate", authenticateToken, async (req, res) => {
  try {
    const amount = parseFloat(req.body.amount);
    if (!amount || amount < 1 || amount > 10000) {
      return res.status(400).json({ success: false, message: "Amount must be between R1 and R10,000" });
    }
    const mPaymentId = `VE-${req.user.id}-${Date.now()}`;

    await pool.query(
      `INSERT INTO payfast_payments (user_id, m_payment_id, amount) VALUES ($1, $2, $3)`,
      [req.user.id, mPaymentId, amount.toFixed(2)],
    );

    // Form fields for PayFast — no signature needed for sandbox
    const formFields = {
      merchant_id:  PF_MERCHANT_ID,
      merchant_key: PF_MERCHANT_KEY,
      return_url:   PF_RETURN_URL,
      cancel_url:   PF_CANCEL_URL,
      m_payment_id: mPaymentId,
      amount:       amount.toFixed(2),
      item_name:    "VoltEquilibrium Wallet Top-Up",
    };

    return res.json({
      success: true,
      data: { payfast_url: PF_HOST, form_fields: formFields },
    });
  } catch (err) {
    console.error("PayFast initiate error:", err.message);
    return res.status(500).json({ success: false, message: "Error initiating payment" });
  }
});

// POST /api/wallet/payfast/notify — ITN callback from PayFast (server-to-server)
app.post("/api/wallet/payfast/notify", express.urlencoded({ extended: false }), async (req, res) => {
  try {
    const { m_payment_id, pf_payment_id, payment_status, amount_gross } = req.body;
    if (payment_status !== "COMPLETE") return res.status(200).send("OK");

    const payment = await pool.query(
      `SELECT * FROM payfast_payments WHERE m_payment_id = $1 AND status = 'pending'`,
      [m_payment_id],
    );
    if (payment.rows.length === 0) return res.status(200).send("OK");

    const row    = payment.rows[0];
    const amount = parseFloat(amount_gross || row.amount);

    await pool.query(`UPDATE payfast_payments SET status = 'complete', pf_payment_id = $1 WHERE id = $2`, [pf_payment_id, row.id]);

    const wallet = await getOrCreateWallet(row.user_id);
    const newBal = parseFloat(wallet.balance) + amount;
    await pool.query(`UPDATE wallets SET balance = $1 WHERE user_id = $2`, [newBal.toFixed(2), row.user_id]);
    await pool.query(
      `INSERT INTO wallet_transactions (user_id, type, direction, amount, balance_after, description)
       VALUES ($1,'top_up','credit',$2,$3,$4)`,
      [row.user_id, amount.toFixed(2), newBal.toFixed(2), `PayFast payment ${m_payment_id}`],
    );

    return res.status(200).send("OK");
  } catch (err) {
    console.error("PayFast ITN error:", err.message);
    return res.status(200).send("OK");
  }
});

// GET /api/wallet/payfast/status/:id — check payment status (+ sandbox auto-confirm)
app.get("/api/wallet/payfast/status/:id", authenticateToken, async (req, res) => {
  try {
    const payment = await pool.query(
      `SELECT * FROM payfast_payments WHERE m_payment_id = $1 AND user_id = $2`,
      [req.params.id, req.user.id],
    );
    if (payment.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Payment not found" });
    }

    const row = payment.rows[0];

    // Sandbox auto-confirm: if still pending and sandbox mode, credit the wallet automatically
    if (row.status === "pending" && PF_SANDBOX) {
      const amount = parseFloat(row.amount);
      await pool.query(`UPDATE payfast_payments SET status = 'complete' WHERE id = $1`, [row.id]);

      const wallet = await getOrCreateWallet(row.user_id);
      const newBal = parseFloat(wallet.balance) + amount;
      await pool.query(`UPDATE wallets SET balance = $1 WHERE user_id = $2`, [newBal.toFixed(2), row.user_id]);
      await pool.query(
        `INSERT INTO wallet_transactions (user_id, type, direction, amount, balance_after, description)
         VALUES ($1,'top_up','credit',$2,$3,$4)`,
        [row.user_id, amount.toFixed(2), newBal.toFixed(2), `PayFast payment ${row.m_payment_id}`],
      );

      return res.json({ success: true, data: { status: "complete", amount: amount.toFixed(2) } });
    }

    return res.json({ success: true, data: { status: row.status, amount: parseFloat(row.amount).toFixed(2) } });
  } catch (err) {
    console.error("PayFast status error:", err.message);
    return res.status(500).json({ success: false, message: "Error checking payment status" });
  }
});

app.post("/api/wallet/withdraw", authenticateToken, async (req, res) => {
  try {
    const amount = parseFloat(req.body.amount);
    if (!amount || amount <= 0 || amount > 10000) {
      return res.status(400).json({ success: false, message: "Amount must be between R0.01 and R10,000" });
    }
    const wallet = await getOrCreateWallet(req.user.id);
    const currentBal = parseFloat(wallet.balance);
    if (currentBal < amount) {
      return res.status(400).json({ success: false, message: `Insufficient balance (R${currentBal.toFixed(2)} available)` });
    }
    const newBal = currentBal - amount;
    await pool.query(`UPDATE wallets SET balance = $1 WHERE user_id = $2`, [newBal.toFixed(2), req.user.id]);
    await pool.query(
      `INSERT INTO wallet_transactions (user_id, type, direction, amount, balance_after, description)
       VALUES ($1,'withdraw','debit',$2,$3,'Funds withdrawn')`,
      [req.user.id, amount.toFixed(2), newBal.toFixed(2)]
    );
    return res.status(200).json({ success: true, data: { balance: newBal.toFixed(2) } });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Error withdrawing funds" });
  }
});

// ── Notifications endpoints ───────────────────────────────────────────────────

app.get("/api/notifications", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [req.user.id]
    );
    return res.status(200).json({ success: true, data: result.rows });
  } catch (err) {
    console.error("Get notifications error:", err.message);
    return res.status(500).json({ success: false, message: "Error fetching notifications" });
  }
});

app.post("/api/notifications/:id/read", authenticateToken, async (req, res) => {
  try {
    await pool.query(
      `UPDATE notifications SET is_read = TRUE WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    );
    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Error marking notification read" });
  }
});

app.post("/api/notifications/read-all", authenticateToken, async (req, res) => {
  try {
    await pool.query(
      `UPDATE notifications SET is_read = TRUE WHERE user_id = $1`,
      [req.user.id]
    );
    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Error marking all notifications read" });
  }
});

// ── Donations ─────────────────────────────────────────────────────────────────

app.get("/api/community/donations", authenticateToken, async (req, res) => {
  try {
    const meResult = await pool.query(
      "SELECT location FROM users WHERE id = $1",
      [req.user.id]
    );
    const me = meResult.rows[0];

    const result = await pool.query(
      `SELECT d.*, u.username, u.location
       FROM donations d
       JOIN users u ON d.user_id = u.id
       WHERE d.is_filled = FALSE
       ORDER BY d.created_at DESC`,
      []
    );

    return res.status(200).json({ success: true, data: result.rows.filter((row) => row.user_id === req.user.id || isSameArea(me, row)) });
  } catch (error) {
    console.error("Get donations error:", error.message);
    return res.status(500).json({ success: false, message: "Error fetching donations" });
  }
});

app.post("/api/community/donations", authenticateToken, async (req, res) => {
  try {
    const { amount_kwh } = req.body;
    if (!amount_kwh || amount_kwh <= 0) {
      return res.status(400).json({ success: false, message: "amount_kwh must be greater than 0" });
    }

    const soc = await getUserSoc(req.user.id);
    if (soc === null) {
      return res.status(400).json({ success: false, message: "No battery data found. Please set up an inverter first." });
    }
    if (soc <= 30) {
      return res.status(400).json({ success: false, message: `Insufficient battery charge (${soc}% SOC). Minimum 30% required.` });
    }

    const result = await pool.query(
      `INSERT INTO donations (user_id, amount_kwh) VALUES ($1, $2) RETURNING *`,
      [req.user.id, amount_kwh]
    );
    return res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error("Create donation error:", error.message);
    return res.status(500).json({ success: false, message: "Error creating donation" });
  }
});

app.delete("/api/community/donations/:id", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM donations WHERE id = $1 AND user_id = $2",
      [req.params.id, req.user.id]
    );
    if (!result.rows[0]) {
      return res.status(404).json({ success: false, message: "Donation not found or not yours" });
    }
    if (result.rows[0].is_filled) {
      return res.status(400).json({ success: false, message: "Cannot delete a filled donation" });
    }

    await pool.query("DELETE FROM donations WHERE id = $1", [req.params.id]);
    return res.status(200).json({ success: true, message: "Donation deleted" });
  } catch (error) {
    console.error("Delete donation error:", error.message);
    return res.status(500).json({ success: false, message: "Error deleting donation" });
  }
});

app.post("/api/community/donations/:id/fill", authenticateToken, async (req, res) => {
  try {
    const donationResult = await pool.query(
      `SELECT d.*, u.lat, u.lng, u.location
       FROM donations d
       JOIN users u ON d.user_id = u.id
       WHERE d.id = $1`,
      [req.params.id]
    );

    if (!donationResult.rows[0]) {
      return res.status(404).json({ success: false, message: "Donation not found" });
    }
    const donation = donationResult.rows[0];

    if (donation.user_id === req.user.id) {
      return res.status(400).json({ success: false, message: "Cannot accept your own donation" });
    }
    if (donation.is_filled) {
      return res.status(400).json({ success: false, message: "Donation already filled" });
    }

    const meResult = await pool.query(
      "SELECT lat, lng, location FROM users WHERE id = $1",
      [req.user.id]
    );
    if (!isSameArea(meResult.rows[0], donation)) {
      return res.status(403).json({ success: false, message: "Transfers only permitted within the same geographic area" });
    }

    const donorSoc = await getUserSoc(donation.user_id);
    if (donorSoc === null || donorSoc <= 30) {
      return res.status(400).json({ success: false, message: `Donor's battery is insufficient (${donorSoc}% SOC). Minimum 30% required.` });
    }

    const result = await pool.query(
      `UPDATE donations SET is_filled = TRUE, filled_by_user_id = $1 WHERE id = $2 RETURNING *`,
      [req.user.id, req.params.id]
    );
    return res.status(200).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error("Fill donation error:", error.message);
    return res.status(500).json({ success: false, message: "Error filling donation" });
  }
});

// ── Energy Sales ──────────────────────────────────────────────────────────────

app.get("/api/community/sales", authenticateToken, async (req, res) => {
  try {
    const meResult = await pool.query(
      "SELECT location FROM users WHERE id = $1",
      [req.user.id]
    );
    const me = meResult.rows[0];

    const result = await pool.query(
      `SELECT s.*, u.username, u.location
       FROM energy_sales s
       JOIN users u ON s.user_id = u.id
       WHERE s.is_filled = FALSE
       ORDER BY s.created_at DESC`,
      []
    );

    return res.status(200).json({ success: true, data: result.rows.filter((row) => row.user_id === req.user.id || isSameArea(me, row)) });
  } catch (error) {
    console.error("Get sales error:", error.message);
    return res.status(500).json({ success: false, message: "Error fetching sales" });
  }
});

app.post("/api/community/sales", authenticateToken, async (req, res) => {
  try {
    const { amount_kwh, price_per_kwh } = req.body;
    if (!amount_kwh || amount_kwh <= 0) {
      return res.status(400).json({ success: false, message: "amount_kwh must be greater than 0" });
    }
    if (!price_per_kwh || price_per_kwh <= 0) {
      return res.status(400).json({ success: false, message: "price_per_kwh must be greater than 0" });
    }

    const battery = await getUserShareableKwh(req.user.id);
    if (!battery) {
      return res.status(400).json({ success: false, message: "No battery data found. Please set up an inverter first." });
    }
    if (battery.soc <= 30) {
      return res.status(400).json({ success: false, message: `Insufficient battery charge (${battery.soc.toFixed(1)}% SOC). Minimum 30% required.` });
    }
    if (amount_kwh > battery.availableKwh) {
      return res.status(400).json({ success: false, message: `Cannot list ${amount_kwh} kWh — only ${battery.availableKwh.toFixed(2)} kWh available after existing listings.` });
    }

    const { comment } = req.body;
    const result = await pool.query(
      `INSERT INTO energy_sales (user_id, amount_kwh, price_per_kwh, comment) VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.user.id, amount_kwh, price_per_kwh, comment || null]
    );
    return res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error("Create sale error:", error.message);
    return res.status(500).json({ success: false, message: "Error creating sale" });
  }
});

app.delete("/api/community/sales/:id", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM energy_sales WHERE id = $1 AND user_id = $2",
      [req.params.id, req.user.id]
    );
    if (!result.rows[0]) {
      return res.status(404).json({ success: false, message: "Sale not found or not yours" });
    }
    if (result.rows[0].is_filled) {
      return res.status(400).json({ success: false, message: "Cannot delete a completed sale" });
    }

    await pool.query("DELETE FROM energy_sales WHERE id = $1", [req.params.id]);
    return res.status(200).json({ success: true, message: "Sale listing deleted" });
  } catch (error) {
    console.error("Delete sale error:", error.message);
    return res.status(500).json({ success: false, message: "Error deleting sale" });
  }
});

app.post("/api/community/sales/:id/fill", authenticateToken, async (req, res) => {
  try {
    const saleResult = await pool.query(
      `SELECT s.*, u.lat, u.lng, u.location
       FROM energy_sales s
       JOIN users u ON s.user_id = u.id
       WHERE s.id = $1`,
      [req.params.id]
    );

    if (!saleResult.rows[0]) {
      return res.status(404).json({ success: false, message: "Sale not found" });
    }
    const sale = saleResult.rows[0];

    if (sale.user_id === req.user.id) {
      return res.status(400).json({ success: false, message: "Cannot buy your own sale listing" });
    }
    if (sale.is_filled) {
      return res.status(400).json({ success: false, message: "Sale already completed" });
    }

    const meResult = await pool.query(
      "SELECT lat, lng, location FROM users WHERE id = $1",
      [req.user.id]
    );
    if (!isSameArea(meResult.rows[0], sale)) {
      return res.status(403).json({ success: false, message: "Transfers only permitted within the same geographic area" });
    }

    const sellerSoc = await getUserSoc(sale.user_id);
    if (sellerSoc === null || sellerSoc <= 30) {
      return res.status(400).json({ success: false, message: `Seller's battery is insufficient (${sellerSoc}% SOC). Minimum 30% required.` });
    }

    // Check buyer has enough empty battery space to receive the energy
    const buyerSpace = await getUserRequestableKwh(req.user.id);
    if (buyerSpace === null) {
      return res.status(400).json({ success: false, message: "No battery data found for your account. Please set up an inverter first." });
    }
    if (parseFloat(sale.amount_kwh) > buyerSpace) {
      return res.status(400).json({ success: false, message: `Not enough battery space to receive ${sale.amount_kwh} kWh — you only have ${buyerSpace.toFixed(2)} kWh of free capacity.` });
    }

    const result = await pool.query(
      `UPDATE energy_sales SET is_filled = TRUE, filled_by_user_id = $1 WHERE id = $2 RETURNING *`,
      [req.user.id, req.params.id]
    );

    // Wallet transfer: buyer pays seller
    const total = (parseFloat(sale.amount_kwh) * parseFloat(sale.price_per_kwh)).toFixed(2);
    await transferWallet(req.user.id, sale.user_id, parseFloat(total),
      `Energy purchase: ${sale.amount_kwh} kWh @ R${parseFloat(sale.price_per_kwh).toFixed(2)}/kWh`);

    // Adjust battery SOC for both parties and record grid export for seller
    await applyEnergyTransfer(sale.user_id, req.user.id, parseFloat(sale.amount_kwh));

    // Notify the seller
    const buyerRow = await pool.query("SELECT username FROM users WHERE id = $1", [req.user.id]);
    const buyerName  = buyerRow.rows[0]?.username || "Someone";
    await createNotification(
      sale.user_id,
      "sale_completed",
      "Energy Sale Completed",
      `${buyerName} purchased ${sale.amount_kwh} kWh for R${total}.`,
      { sale_id: sale.id, buyer_id: req.user.id, amount_kwh: sale.amount_kwh, total_rands: total }
    );
    // Notify the buyer
    const sellerRow = await pool.query("SELECT username FROM users WHERE id = $1", [sale.user_id]);
    const sellerName = sellerRow.rows[0]?.username || "Someone";
    await createNotification(
      req.user.id,
      "purchase_completed",
      "Energy Purchase Confirmed",
      `You bought ${sale.amount_kwh} kWh from ${sellerName} for R${total}. Your battery has been updated.`,
      { sale_id: sale.id, seller_id: sale.user_id, amount_kwh: sale.amount_kwh, total_rands: total }
    );

    return res.status(200).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error("Fill sale error:", error.message);
    return res.status(500).json({ success: false, message: "Error completing sale" });
  }
});

// ── Energy Requests ───────────────────────────────────────────────────────────

app.get("/api/community/requests", authenticateToken, async (req, res) => {
  try {
    const meResult = await pool.query(
      "SELECT location FROM users WHERE id = $1",
      [req.user.id]
    );
    const me = meResult.rows[0];

    const result = await pool.query(
      `SELECT r.*, u.username, u.location
       FROM energy_requests r
       JOIN users u ON r.user_id = u.id
       WHERE r.is_filled = FALSE
       ORDER BY r.created_at DESC`,
      []
    );

    return res.status(200).json({ success: true, data: result.rows.filter((row) => row.user_id === req.user.id || isSameArea(me, row)) });
  } catch (error) {
    console.error("Get requests error:", error.message);
    return res.status(500).json({ success: false, message: "Error fetching requests" });
  }
});

app.post("/api/community/requests", authenticateToken, async (req, res) => {
  try {
    const { amount_kwh } = req.body;
    if (!amount_kwh || amount_kwh <= 0) {
      return res.status(400).json({ success: false, message: "amount_kwh must be greater than 0" });
    }

    const requestable = await getUserRequestableKwh(req.user.id);
    if (requestable !== null && typeof requestable === "object" && requestable.noBattery) {
      // No-battery user: apply community caps
      if (amount_kwh > NO_BATTERY_MAX_PER_REQUEST) {
        return res.status(400).json({ success: false, message: `Users without a battery can request at most ${NO_BATTERY_MAX_PER_REQUEST} kWh per request.` });
      }
      if (amount_kwh > requestable.remaining) {
        return res.status(400).json({ success: false, message: `You have ${requestable.remaining.toFixed(2)} kWh of your ${NO_BATTERY_MAX_OUTSTANDING} kWh community allowance remaining.` });
      }
    } else {
      if (amount_kwh > requestable) {
        return res.status(400).json({ success: false, message: `Cannot request ${amount_kwh} kWh — only ${requestable.toFixed(2)} kWh of battery space available after existing requests.` });
      }
    }

    const { comment } = req.body;
    const result = await pool.query(
      `INSERT INTO energy_requests (user_id, amount_kwh, comment) VALUES ($1, $2, $3) RETURNING *`,
      [req.user.id, amount_kwh, comment || null]
    );
    return res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error("Create request error:", error.message);
    return res.status(500).json({ success: false, message: "Error creating request" });
  }
});

app.delete("/api/community/requests/:id", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM energy_requests WHERE id = $1 AND user_id = $2",
      [req.params.id, req.user.id]
    );
    if (!result.rows[0]) {
      return res.status(404).json({ success: false, message: "Request not found or not yours" });
    }
    if (result.rows[0].is_filled) {
      return res.status(400).json({ success: false, message: "Cannot delete a filled request" });
    }

    await pool.query("DELETE FROM energy_requests WHERE id = $1", [req.params.id]);
    return res.status(200).json({ success: true, message: "Request deleted" });
  } catch (error) {
    console.error("Delete request error:", error.message);
    return res.status(500).json({ success: false, message: "Error deleting request" });
  }
});

app.post("/api/community/requests/:id/fill", authenticateToken, async (req, res) => {
  try {
    const requestResult = await pool.query(
      `SELECT r.*, u.lat, u.lng, u.location
       FROM energy_requests r
       JOIN users u ON r.user_id = u.id
       WHERE r.id = $1`,
      [req.params.id]
    );

    if (!requestResult.rows[0]) {
      return res.status(404).json({ success: false, message: "Request not found" });
    }
    const request = requestResult.rows[0];

    if (request.user_id === req.user.id) {
      return res.status(400).json({ success: false, message: "Cannot fill your own request" });
    }
    if (request.is_filled) {
      return res.status(400).json({ success: false, message: "Request already filled" });
    }

    const meResult = await pool.query(
      "SELECT lat, lng, location FROM users WHERE id = $1",
      [req.user.id]
    );
    if (!isSameArea(meResult.rows[0], request)) {
      return res.status(403).json({ success: false, message: "Transfers only permitted within the same geographic area" });
    }

    const fillerSoc = await getUserSoc(req.user.id);
    if (fillerSoc === null) {
      return res.status(400).json({ success: false, message: "No battery data found. Please set up an inverter first." });
    }
    if (fillerSoc <= 30) {
      return res.status(400).json({ success: false, message: `Insufficient battery charge (${fillerSoc}% SOC). Minimum 30% required to fulfill a request.` });
    }

    // Check that the requester actually has space to receive it (skip for no-battery users)
    const requesterSpace = await getUserRequestableKwh(request.user_id);
    if (requesterSpace !== null && typeof requesterSpace === "number" && parseFloat(request.amount_kwh) > requesterSpace) {
      return res.status(400).json({ success: false, message: `The requester's battery no longer has enough space for ${request.amount_kwh} kWh (only ${requesterSpace.toFixed(2)} kWh free).` });
    }

    const donorComment = req.body?.comment?.trim() || null;
    const result = await pool.query(
      `UPDATE energy_requests SET is_filled = TRUE, filled_by_user_id = $1, donor_comment = $2 WHERE id = $3 RETURNING *`,
      [req.user.id, donorComment, req.params.id]
    );

    // Adjust SOC: filler (donor) sends energy to requester
    await applyEnergyTransfer(req.user.id, request.user_id, parseFloat(request.amount_kwh));

    // Notify the requester
    const fillerRow = await pool.query("SELECT username FROM users WHERE id = $1", [req.user.id]);
    const fillerName = fillerRow.rows[0]?.username || "Someone";
    const fulfilledMsg = donorComment
      ? `${fillerName} donated ${request.amount_kwh} kWh to your request: "${donorComment}"`
      : `${fillerName} donated ${request.amount_kwh} kWh to your request. Your battery has been updated.`;
    await createNotification(
      request.user_id,
      "request_fulfilled",
      "Energy Request Fulfilled",
      fulfilledMsg,
      { request_id: request.id, filler_id: req.user.id, amount_kwh: request.amount_kwh }
    );
    // Notify the donor
    const requesterRow = await pool.query("SELECT username FROM users WHERE id = $1", [request.user_id]);
    const requesterName = requesterRow.rows[0]?.username || "Someone";
    await createNotification(
      req.user.id,
      "donation_sent",
      "Donation Sent",
      `You donated ${request.amount_kwh} kWh to ${requesterName}'s request. Thank you!`,
      { request_id: request.id, recipient_id: request.user_id, amount_kwh: request.amount_kwh }
    );

    return res.status(200).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error("Fill request error:", error.message);
    return res.status(500).json({ success: false, message: "Error filling request" });
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
