const express = require("express");
const router = express.Router();
const pool = require("../db");
const fetch = require("node-fetch");
const { authenticateToken } = require("../helpers/auth");
const { CO2_KG_PER_KWH, RANDS_PER_KWH } = require("../helpers/constants");

// Physics constants
const SYSTEM_EFFICIENCY = 0.85;   // inverter + wiring + soiling losses
const TEMP_COEFF        = 0.004;  // -0.4% per °C above 25
const TEMP_BASE         = 25;
const WIND_CUT_IN       = 3;     // m/s
const WIND_RATED        = 12;    // m/s

// Cache: 1 hour TTL
const forecastCache = {};
const CACHE_TTL = 60 * 60 * 1000;
setInterval(() => {
  for (const [key, val] of Object.entries(forecastCache)) {
    if (Date.now() - val.fetchedAt > CACHE_TTL * 2) delete forecastCache[key];
  }
}, 30 * 60 * 1000);

// GET /generation?days=7
router.get("/generation", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const days = Math.min(parseInt(req.query.days) || 7, 14);

    // Get user location
    const userResult = await pool.query("SELECT lat, lng, location FROM users WHERE id = $1", [userId]);
    const user = userResult.rows[0];
    if (!user?.lat || !user?.lng) {
      return res.status(400).json({ success: false, message: "Location not set. Update your location in profile settings." });
    }

    // Get inverters
    const invResult = await pool.query("SELECT id, type, capacity FROM inverters WHERE user_id = $1", [userId]);
    if (invResult.rows.length === 0) {
      return res.json({ success: true, data: { daily: [], hourly: [], summary: null, message: "No inverters — add solar or wind to get generation forecasts." } });
    }

    const solarCapacity = invResult.rows.filter(i => i.type === "solar").reduce((sum, i) => sum + (parseFloat(i.capacity) || 0), 0);
    const windCapacity = invResult.rows.filter(i => i.type === "wind").reduce((sum, i) => sum + (parseFloat(i.capacity) || 0), 0);

    // Check cache
    const cacheKey = `gen:${user.lat},${user.lng}:${days}`;
    const cached = forecastCache[cacheKey];
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
      return res.json({ success: true, data: cached.data, cached: true });
    }

    // Fetch from Open-Meteo
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${user.lat}&longitude=${user.lng}&hourly=shortwave_radiation,temperature_2m,wind_speed_10m,cloud_cover&forecast_days=${days}&timezone=auto`;
    const weatherRes = await fetch(url);
    if (!weatherRes.ok) throw new Error(`Open-Meteo error: ${weatherRes.status}`);
    const weather = await weatherRes.json();

    const times = weather.hourly.time;
    const ghi = weather.hourly.shortwave_radiation;
    const temps = weather.hourly.temperature_2m;
    const winds = weather.hourly.wind_speed_10m;
    const clouds = weather.hourly.cloud_cover;

    // Calculate hourly predictions
    const hourly = [];
    for (let i = 0; i < times.length; i++) {
      const tempCoeff = 1 - Math.max(0, (temps[i] - TEMP_BASE) * TEMP_COEFF);

      // Solar: GHI-based
      let solarKwh = 0;
      if (solarCapacity > 0 && ghi[i] > 0) {
        solarKwh = (ghi[i] * solarCapacity * tempCoeff * SYSTEM_EFFICIENCY) / 1000;
      }

      // Wind: cube law
      let windKwh = 0;
      if (windCapacity > 0 && winds[i] >= WIND_CUT_IN) {
        const normalized = Math.min(1, (winds[i] - WIND_CUT_IN) / (WIND_RATED - WIND_CUT_IN));
        windKwh = windCapacity * Math.pow(normalized, 3);
      }

      hourly.push({
        time: times[i],
        ghi: ghi[i],
        temp: temps[i],
        windSpeed: winds[i],
        cloudCover: clouds[i],
        solarKwh: parseFloat(solarKwh.toFixed(3)),
        windKwh: parseFloat(windKwh.toFixed(3)),
        totalKwh: parseFloat((solarKwh + windKwh).toFixed(3)),
      });
    }

    // Aggregate daily
    const dailyMap = {};
    const today = new Date().toISOString().slice(0, 10);
    hourly.forEach((h, i) => {
      const date = h.time.slice(0, 10);
      if (!dailyMap[date]) {
        dailyMap[date] = { date, solarKwh: 0, windKwh: 0, totalKwh: 0, temps: [], winds: [], clouds: [], peakKwh: 0, dayIndex: 0 };
      }
      dailyMap[date].solarKwh += h.solarKwh;
      dailyMap[date].windKwh += h.windKwh;
      dailyMap[date].totalKwh += h.totalKwh;
      dailyMap[date].temps.push(h.temp);
      dailyMap[date].winds.push(h.windSpeed);
      dailyMap[date].clouds.push(h.cloudCover);
      if (h.totalKwh > dailyMap[date].peakKwh) dailyMap[date].peakKwh = h.totalKwh;
    });

    const daily = Object.values(dailyMap).map((d, idx) => ({
      date: d.date,
      predictedKwh: parseFloat(d.totalKwh.toFixed(2)),
      solarKwh: parseFloat(d.solarKwh.toFixed(2)),
      windKwh: parseFloat(d.windKwh.toFixed(2)),
      avgTemp: parseFloat((d.temps.reduce((a, b) => a + b, 0) / d.temps.length).toFixed(1)),
      avgWindSpeed: parseFloat((d.winds.reduce((a, b) => a + b, 0) / d.winds.length).toFixed(1)),
      avgCloudCover: parseFloat((d.clouds.reduce((a, b) => a + b, 0) / d.clouds.length).toFixed(0)),
      peakHourKwh: parseFloat(d.peakKwh.toFixed(3)),
      confidence: idx <= 1 ? "high" : idx <= 4 ? "medium" : "low",
    }));

    // Summary
    const totalKwh = daily.reduce((s, d) => s + d.predictedKwh, 0);
    const bestDay = daily.reduce((best, d) => d.predictedKwh > best.predictedKwh ? d : best, daily[0]);
    const worstDay = daily.reduce((worst, d) => d.predictedKwh < worst.predictedKwh ? d : worst, daily[0]);

    const data = {
      generatedAt: new Date().toISOString(),
      location: user.location || `${user.lat}, ${user.lng}`,
      inverters: invResult.rows.map(i => ({ id: i.id, type: i.type, capacityKw: parseFloat(i.capacity) || 0 })),
      daily,
      hourly,
      summary: {
        totalPredictedKwh: parseFloat(totalKwh.toFixed(2)),
        estimatedSavingsRands: parseFloat((totalKwh * RANDS_PER_KWH).toFixed(2)),
        estimatedCo2OffsetKg: parseFloat((totalKwh * CO2_KG_PER_KWH).toFixed(2)),
        avgDailyKwh: parseFloat((totalKwh / daily.length).toFixed(2)),
        bestDay: { date: bestDay.date, kwh: bestDay.predictedKwh },
        worstDay: { date: worstDay.date, kwh: worstDay.predictedKwh },
      },
    };

    forecastCache[cacheKey] = { fetchedAt: Date.now(), data };
    return res.json({ success: true, data, cached: false });
  } catch (err) {
    console.error("Forecast generation error:", err.message);
    return res.status(500).json({ success: false, message: "Error generating forecast" });
  }
});

module.exports = router;
