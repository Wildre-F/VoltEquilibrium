// ═══════════════════════════════════════════════════════════════════════════
// Dependencies
// ═══════════════════════════════════════════════════════════════════════════
require("dotenv").config();
const crypto     = require("crypto");
const express    = require("express");
const cors       = require("cors");
const jwt        = require("jsonwebtoken");
const fetch      = require("node-fetch");
const mqtt       = require("mqtt");
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

// Constants (CO2, tariffs, PayFast) are in helpers/constants.js

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
// MQTT — Ingest telemetry from simulators/inverters
// ═══════════════════════════════════════════════════════════════════════════
const mqttClient = mqtt.connect("mqtt://mqtt:1883");

mqttClient.on("connect", () => {
  console.log("Connected to MQTT broker");
  mqttClient.subscribe("voltequilibrium/#", (err) => {
    if (!err) console.log("Subscribed to voltequilibrium/#");
  });
});

// ── Debug: MQTT message buffer + SSE clients ────────────────────────────────
const mqttBuffer = [];
const MQTT_BUFFER_MAX = 200;
const sseClients = new Map(); // Map<res, { userId, apiKey }>

mqttClient.on("message", async (topic, message) => {
  // Push to debug buffer
  const entry = { topic, payload: message.toString(), ts: new Date().toISOString() };
  mqttBuffer.push(entry);
  if (mqttBuffer.length > MQTT_BUFFER_MAX) mqttBuffer.shift();
  // Broadcast to SSE clients — only send messages matching the user's API key
  const topicApiKey = topic.split("/")[1] || "";
  for (const [res, client] of sseClients) {
    if (client.apiKey && topicApiKey === client.apiKey) {
      try { res.write(`data: ${JSON.stringify(entry)}\n\n`); } catch (err) { console.error("[sse] write error:", err.message); sseClients.delete(res); }
    }
  }

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
      // Only accept battery data from the primary inverter (lowest ID) to prevent
      // multiple simulators writing conflicting SOC values to the same battery
      if (deviceId) {
        const primaryInv = await pool.query(
          "SELECT id FROM inverters WHERE user_id = $1 ORDER BY id ASC LIMIT 1",
          [userId],
        );
        if (primaryInv.rows.length > 0 && primaryInv.rows[0].id !== deviceId) return;
      }

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
  } catch (err) {
    console.error("[auth] token verification failed:", err.message);
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

// ── Debug: MQTT stream endpoints ─────────────────────────────────────────────
// GET /api/debug/mqtt/buffer — recent MQTT messages filtered to current user
app.get("/api/debug/mqtt/buffer", authenticateToken, async (req, res) => {
  const userRow = await pool.query("SELECT api_key FROM users WHERE id = $1", [req.user.id]);
  const apiKey = userRow.rows[0]?.api_key;
  const filtered = apiKey
    ? mqttBuffer.filter(m => m.topic.split("/")[1] === apiKey)
    : [];
  res.json({ success: true, data: filtered });
});

// GET /api/debug/mqtt/stream — SSE live stream (token via query param since EventSource can't send headers)
app.get("/api/debug/mqtt/stream", async (req, res) => {
  const tkn = req.query.token;
  if (!tkn) return res.status(401).json({ message: "Token required" });
  try {
    const decoded = jwt.verify(tkn, JWT_SECRET);
    req.user = decoded;
  } catch (err) { console.error("[sse] token verification failed:", err.message); return res.status(401).json({ message: "Invalid token" }); }
  // Look up user's API key to filter MQTT messages
  const userRow = await pool.query("SELECT api_key FROM users WHERE id = $1", [req.user.id]);
  const userApiKey = userRow.rows[0]?.api_key || null;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  res.write(`data: ${JSON.stringify({ connected: true, apiKey: userApiKey ? "matched" : "none" })}\n\n`);
  sseClients.set(res, { userId: req.user.id, apiKey: userApiKey });
  req.on("close", () => sseClients.delete(res));
});

// Loadshedding status proxy (Eskom)
app.get("/api/loadshedding", async (req, res) => {
  try {
    const response = await fetch("https://loadshedding.eskom.co.za/LoadShedding/GetStatus");
    const status   = await response.json();
    return res.status(200).json({ success: true, stage: status - 1 });
  } catch (err) {
    console.error("[loadshedding] Eskom API fetch error:", err.message);
    return res.status(500).json({ success: false, message: "Could not fetch loadshedding status" });
  }
});

// ── Auth routes (routes/auth.js) ─────────────────────────────────────────────
app.use("/", require("./routes/auth"));

// ── Profile & Account routes (routes/profile.js) ────────────────────────────
app.use("/api", require("./routes/profile"));

// ── Setup routes (routes/setup.js) ──────────────────────────────────────────
app.use("/api/setup", require("./routes/setup"));

// ── Weather endpoints (routes/weather.js) ────────────────────────────────────
app.use("/api/weather", require("./routes/weather"));
app.use("/api/forecast", require("./routes/forecast"));

// ── Readings & Battery endpoints (routes/readings.js) ────────────────────────
app.use("/api", require("./routes/readings"));

// ── CO2 & Analytics routes (routes/analytics.js) ───────────────────────────
app.use("/api", require("./routes/analytics"));

// ── Inverter routes (routes/inverter.js) ────────────────────────────────────
app.use("/api/inverter", require("./routes/inverter"));

// ── Wallet endpoints ──────────────────────────────────────────────────────────
app.use("/api/wallet", require("./routes/wallet"));

// ── AI Chatbot endpoints ─────────────────────────────────────────────────────
app.use("/api/chat", require("./routes/chat"));

// ── Notifications (routes/notifications.js) ──────────────────────────────────
const { router: notificationsRouter } = require("./routes/notifications");
app.use("/api", notificationsRouter);

// ── Community Energy Sharing (routes/community.js) ───────────────────────────
app.use("/api/community", require("./routes/community"));

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
