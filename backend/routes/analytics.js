const express = require("express");
const router  = express.Router();
const pool    = require("../db");
const { authenticateToken }          = require("../helpers/auth");
const { CO2_KG_PER_KWH, RANDS_PER_KWH } = require("../helpers/constants");

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
router.get("/co2", authenticateToken, async (req, res) => {
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
router.get("/analytics/summary", authenticateToken, async (req, res) => {
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

module.exports = router;
