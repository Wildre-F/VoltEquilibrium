const express = require("express");
const router  = express.Router();
const pool    = require("../db");
const { authenticateToken }          = require("../helpers/auth");
const { CO2_KG_PER_KWH, RANDS_PER_KWH } = require("../helpers/constants");

// GET /api/inverter/summary — live totals + per-inverter detail cards
router.get("/summary", authenticateToken, async (req, res) => {
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
      `SELECT br.state_of_charge, br.voltage, br.current, br.temperature, br.power_w, br.recorded_at, b.capacity_kwh, b.name AS battery_name
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

    // Keep a combined live reading for shared grid/inverter fields (prefer solar, fall back to wind, then battery-only defaults)
    let liveElecResult = liveSolarResult.rows.length > 0 ? liveSolarResult : liveWindResult;

    // Battery-only fallback: provide grid defaults since they still draw from Eskom
    if (liveElecResult.rows.length === 0) {
      const hour = new Date().getHours();
      let baseLoad = 300;
      if (hour >= 6 && hour < 9) baseLoad = 500;
      else if (hour >= 9 && hour < 17) baseLoad = 350;
      else if (hour >= 17 && hour < 22) baseLoad = 800;
      else baseLoad = 200;
      baseLoad = Math.round(baseLoad + (Math.random() - 0.5) * 60);
      // Get battery voltage for inverter DC voltage
      const battVolt = batteryResult.rows.length > 0 ? parseFloat(batteryResult.rows[0].voltage || 48) : 48;
      liveElecResult = { rows: [{
        ac_voltage: 230, frequency: 50, dc_voltage: battVolt,
        load_watts: baseLoad, grid_kwh: 0, power_w: 0,
      }] };
    }

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
        inverters: inverterResult.rows.length > 0
          ? inverterResult.rows.map((inv) => ({
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
            }))
          : (batteryResult.rows.length > 0 ? [{
              id:              0,
              name:            batteryResult.rows[0].battery_name || "Battery Inverter",
              type:            "battery",
              profile:         "battery-only",
              capacity:        parseFloat(batteryResult.rows[0].capacity_kwh || 10),
              serialNumber:    "VE-BAT-ONLY",
              firmwareVersion: "FW-1.0.0",
              todayKwh:        0,
              todayLoadKwh:    0,
              todayGridKwh:    0,
              todayPeakW:      0,
              livePowerW:      parseFloat(parseFloat(batteryResult.rows[0].power_w || 0).toFixed(1)),
              liveTemp:        parseFloat(parseFloat(batteryResult.rows[0].temperature || 25).toFixed(1)),
              liveWindSpeed:   null,
              liveRotorRpm:    null,
              livePitchAngle:  null,
              lastSeen:        batteryResult.rows[0].recorded_at || null,
            }] : []),
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
router.get("/analytics", authenticateToken, async (req, res) => {
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
router.get("/efficiency", authenticateToken, async (req, res) => {
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
router.get("/analytics/export", authenticateToken, async (req, res) => {
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

module.exports = router;
