const express = require("express");
const router = express.Router();
const pool = require("../db");
const { authenticateToken } = require("../helpers/auth");

// Manual kWh submission (used when not going through MQTT)
router.post("/readings", authenticateToken, async (req, res) => {
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
router.get("/readings/latest", authenticateToken, async (req, res) => {
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
      // Simulate realistic household base load by time of day (W)
      // Night: ~200W, Morning: ~500W, Day: ~350W, Evening peak: ~800W
      const hour = new Date().getHours();
      let baseLoad = 300;
      if (hour >= 6 && hour < 9) baseLoad = 500;
      else if (hour >= 9 && hour < 17) baseLoad = 350;
      else if (hour >= 17 && hour < 22) baseLoad = 800;
      else baseLoad = 200;
      // Add slight randomness
      baseLoad = Math.round(baseLoad + (Math.random() - 0.5) * 60);

      const battOnly = await pool.query(
        `SELECT
           NULL AS inverter_id, 'battery' AS type, NULL AS profile,
           0 AS power_w, 0 AS dc_voltage, 0 AS dc_current, 230 AS ac_voltage,
           0 AS ac_current, 50 AS frequency, 0 AS inverter_temp, 0 AS energy_kwh,
           0 AS wind_speed, 0 AS rotor_rpm, 0 AS pitch_angle,
           ${baseLoad} AS load_watts,
           CASE WHEN COALESCE(br.power_w, 0) > 0 THEN COALESCE(br.power_w, 0) ELSE ${baseLoad} END AS grid_watts,
           0 AS cloud_cover,
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
router.get("/readings/history", authenticateToken, async (req, res) => {
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
router.get("/battery", authenticateToken, async (req, res) => {
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

module.exports = router;
