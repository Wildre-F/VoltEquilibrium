const express  = require("express");
const router   = express.Router();
const crypto   = require("crypto");
const jwt      = require("jsonwebtoken");
const pool     = require("../db");
const launcher = require("../launcher");
const { authenticateToken } = require("../helpers/auth");
const { JWT_SECRET }        = require("../helpers/constants");

// ── Historic data seed for demo ──────────────────────────────────────────────
let seedDataCache = null;
async function seedHistoricData(inverterId, userId) {
  try {
    if (!seedDataCache) {
      const fs   = require("fs");
      const file = require("path").join(__dirname, "..", "seed-solar-large.json");
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

router.get("/status", authenticateToken, async (req, res) => {
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
router.post("/battery-only", authenticateToken, async (req, res) => {
  try {
    const { capacity_kwh, name, location, lat, lng } = req.body;
    const cap = parseFloat(capacity_kwh) || 10;
    const battName = (name && name.trim()) || "Home Inverter";

    // Check if battery already exists
    const existing = await pool.query("SELECT id FROM batteries WHERE user_id = $1", [req.user.id]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ success: false, message: "Battery already set up" });
    }

    // Create battery
    const battResult = await pool.query(
      "INSERT INTO batteries (user_id, name, capacity_kwh) VALUES ($1, $2, $3) RETURNING *",
      [req.user.id, battName, cap],
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

router.post("/inverter", authenticateToken, async (req, res) => {
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

router.delete("/inverter/:id", authenticateToken, async (req, res) => {
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

module.exports = router;
