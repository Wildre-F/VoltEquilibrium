const express = require("express");
const router = express.Router();
const fetch = require("node-fetch");
const pool = require("../db");
const { authenticateToken } = require("../helpers/auth");

// In-memory cache for Open-Meteo weather responses (current + forecast).
// Keyed by "lat,lng" for current weather and "forecast:lat,lng" for forecasts.
// Each entry: { fetchedAt: <epoch ms>, data: <response object> }
const weatherCache = {};
// Prune stale weather cache entries every 10 minutes
setInterval(() => {
  const maxAge = 30 * 60 * 1000;
  for (const [key, val] of Object.entries(weatherCache)) {
    if (Date.now() - val.fetchedAt > maxAge) delete weatherCache[key];
  }
}, 10 * 60 * 1000);

// Current conditions — used by simulators to adjust output based on cloud/wind
router.get("/", authenticateToken, async (req, res) => {
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
  } catch (err) {
    console.error("[weather] current weather fetch error:", err.message);
    return res.status(500).json({ success: false, message: "Weather fetch failed" });
  }
});

// Hourly forecast — drives the weather widget on the dashboard
// Returns current conditions + next 6 hours in the site's local timezone
router.get("/forecast", authenticateToken, async (req, res) => {
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

module.exports = router;
