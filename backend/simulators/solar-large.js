require("dotenv").config();
const mqtt = require("mqtt");
const fetch = require("node-fetch");
const DEVICE_ID = process.env.SIM_DEVICE_ID; // inverter DB id to fetch config from database

// ── Config ────────────────────────────────────────────────────────────────────
const MQTT_BROKER = process.env.MQTT_BROKER || "mqtt://mqtt:1883";
const API_KEY = process.env.SIM_API_KEY; // VE-xxxxxxxxxxxxxxxx
const LAT = parseFloat(process.env.SIM_LAT);
const LNG = parseFloat(process.env.SIM_LNG);
const INTERVAL_MS = 30000; // publish every 30 seconds

if (!API_KEY || isNaN(LAT) || isNaN(LNG)) {
  console.error(
    "[solar-large] Missing SIM_API_KEY, SIM_LAT or SIM_LNG in environment.",
  );
  process.exit(1);
}

// ── MQTT ──────────────────────────────────────────────────────────────────────
const client = mqtt.connect(MQTT_BROKER);
const TOPIC_SOLAR = `voltequilibrium/${API_KEY}/${DEVICE_ID}/solar`;
const TOPIC_BATTERY = `voltequilibrium/${API_KEY}/${DEVICE_ID}/battery`;

client.on("connect", () => {
  console.log(`[solar-large] Connected to MQTT broker → ${MQTT_BROKER}`);
  console.log(`[solar-large] Publishing to ${TOPIC_SOLAR}`);
  runSimulation();
  setInterval(runSimulation, INTERVAL_MS);
});

client.on("error", (err) => {
  console.error("[solar-large] MQTT error:", err.message);
});

// ── Weather ───────────────────────────────────────────────────────────────────
// Each simulator has its own local cache to avoid hammering the backend.
// The backend /api/weather route also caches for 15 min, so this is a
// secondary safety net.
let cachedWeather = null;
let weatherFetchedAt = 0;
const WEATHER_TTL_MS = 10 * 60 * 1000; // re-fetch locally every 10 minutes

async function getWeather() {
  const now = Date.now();
  if (cachedWeather && now - weatherFetchedAt < WEATHER_TTL_MS) {
    return cachedWeather;
  }
  try {
    const res = await fetch(
      `${process.env.BACKEND_URL || "http://localhost:3000"}/api/weather?lat=${LAT}&lng=${LNG}`,
      {
        headers: { Authorization: `Bearer ${process.env.SIM_TOKEN}` },
      },
    );
    const data = await res.json();
    cachedWeather = data.data;
    weatherFetchedAt = now;
    console.log(
      `[solar-large] Weather → cloud: ${cachedWeather.cloudCover}% | wind: ${cachedWeather.windSpeed} m/s | temp: ${cachedWeather.temperature}°C`,
    );
  } catch (err) {
    console.warn(
      "[solar-large] Weather fetch failed, using defaults:",
      err.message,
    );
    cachedWeather = cachedWeather || {
      cloudCover: 20,
      windSpeed: 3,
      temperature: 22,
    };
  }
  return cachedWeather;
}

// ── Solar output model ────────────────────────────────────────────────────────
// Large commercial/farm array: 5–10 kW peak capacity.
//
// Key differences from solar-small:
//   • Higher peak power (10 kW vs 3 kW)
//   • Higher panel string voltage (string of 3 panels in series = 108 V)
//   • Larger battery bank (20 kWh vs 5 kWh)
//   • Higher house/building load (1 kW vs 300 W)
//   • Inverter runs slightly hotter under load
const PEAK_POWER_W = 10000; // watts at perfect midday, clear sky
const PANEL_VOLTAGE = 108; // ~3 panels in series (3 × 36 V)
const BATTERY_CAP_WH = 20000; // 20 kWh battery bank

let batterySOC = 60; // start at 60% state of charge
let energyToday = 0; // kWh accumulated since midnight
let lastHour = new Date().getHours();

// Bell-curve multiplier: 0 before sunrise (6 AM), peak at 13:00, 0 after sunset (19)
// This is the same formula as solar-small — the physics of the sun don't change!
function getSolarMultiplier(hour) {
  if (hour < 6 || hour > 19) return 0;
  return Math.sin(((hour - 6) * Math.PI) / 13);
}

// Add small random noise to a value to simulate real-world sensor readings.
// pct = fraction of the value used as the ± range, e.g. 0.05 = ±5%
function jitter(value, pct = 0.05) {
  return value * (1 + (Math.random() - 0.5) * 2 * pct);
}

async function runSimulation() {
  const weather = await getWeather();

  // Intl.DateTimeFormat converts the current UTC time to the correct
  // local hour for wherever the inverter is physically located.

  const localHour = parseInt(
    new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      hour12: false,
      timeZone: weather.timezone || "UTC",
    }).format(new Date()),
  );
  const now = new Date();
  const hour = localHour;

  // Reset daily energy counter at midnight
  if (hour < lastHour) energyToday = 0;
  lastHour = hour;

  // ── Solar power calculation ───────────────────────────────────────────────
  const timeMultiplier = getSolarMultiplier(hour);

  // Cloud cover: heavier impact on large arrays because they rely on direct
  // irradiance more than diffuse light (no micro-inverter tricks).
  // 100% cloud cover → only ~15% of rated power (vs 20% for small rooftop).
  const cloudMultiplier = 1 - (weather.cloudCover / 100) * 0.85;

  // Temperature coefficient: panels lose ~0.4% efficiency per °C above 25°C.
  // Large arrays in open fields often run hotter (+5°C vs ambient).
  const panelTemp = weather.temperature + 5;
  const tempMultiplier = 1 - Math.max(0, (panelTemp - 25) * 0.004);

  const rawPower =
    PEAK_POWER_W * timeMultiplier * cloudMultiplier * tempMultiplier;
  const power_w = Math.max(0, jitter(rawPower, 0.05));

  // DC side — higher voltage string, lower current for the same power
  // (this is actually an advantage of large arrays: less resistive loss)
  const dc_current = power_w > 0 ? jitter(power_w / PANEL_VOLTAGE, 0.03) : 0;
  const dc_voltage = power_w > 0 ? jitter(PANEL_VOLTAGE, 0.02) : 0;

  // AC side — 3-phase output is common on large inverters, but we model
  // single-phase equivalent here for simplicity. ~96.5% efficiency.
  const ac_voltage = power_w > 0 ? jitter(230, 0.01) : 0;
  const ac_current = power_w > 0 ? jitter((power_w * 0.965) / 230, 0.03) : 0;
  const frequency = power_w > 0 ? jitter(50, 0.005) : 0;

  // Large inverters run hotter under load; ambient + up to 25°C rise at full power
  const inverter_temp = jitter(
    weather.temperature + (power_w / PEAK_POWER_W) * 25,
    0.02,
  );

  // Energy accumulated (kWh) for this 30-second interval
  // Formula: Energy = Power × Time  →  kWh = (W / 1000) × hours
  const intervalHours = INTERVAL_MS / 1000 / 3600;
  energyToday += (power_w / 1000) * intervalHours;

  // ── Battery simulation ────────────────────────────────────────────────────
  // Excess solar charges the battery; deficit draws from it.
  const BUILDING_LOAD_W = 1000; // larger building draws more than a household
  const netPower = power_w - BUILDING_LOAD_W;

  // SOC change: socDelta = (net energy this interval) / (total battery capacity) × 100
  const socDelta = ((netPower * intervalHours) / (BATTERY_CAP_WH / 1000)) * 100;
  batterySOC = Math.min(100, Math.max(0, batterySOC + socDelta));

  // LiFePO4 voltage range: 48 V (empty) → 58 V (full) for a 48 V nominal bank
  const battery_voltage = 48 + (batterySOC / 100) * 10;
  const battery_current = netPower / battery_voltage;
  const battery_power = netPower;
  const battery_temp = jitter(weather.temperature + 4, 0.02);

  // ── Build payloads ────────────────────────────────────────────────────────
  const solarPayload = {
    power_w: parseFloat(power_w.toFixed(2)),
    dc_voltage: parseFloat(dc_voltage.toFixed(2)),
    dc_current: parseFloat(dc_current.toFixed(3)),
    ac_voltage: parseFloat(ac_voltage.toFixed(2)),
    ac_current: parseFloat(ac_current.toFixed(3)),
    frequency: parseFloat(frequency.toFixed(2)),
    temperature: parseFloat(inverter_temp.toFixed(1)),
    energy_kwh: parseFloat(energyToday.toFixed(4)),
    wind_speed: null,
    rotor_rpm: null,
    pitch_angle: null,
    profile: "solar-large",
    cloud_cover: weather.cloudCover,
    timestamp: now.toISOString(),
  };

  const batteryPayload = {
    state_of_charge: parseFloat(batterySOC.toFixed(2)),
    voltage: parseFloat(battery_voltage.toFixed(2)),
    current: parseFloat(battery_current.toFixed(3)),
    temperature: parseFloat(battery_temp.toFixed(1)),
    power_w: parseFloat(battery_power.toFixed(2)),
    timestamp: now.toISOString(),
  };

  // ── Publish ───────────────────────────────────────────────────────────────
  client.publish(TOPIC_SOLAR, JSON.stringify(solarPayload), { qos: 1 });
  client.publish(TOPIC_BATTERY, JSON.stringify(batteryPayload), { qos: 1 });

  console.log(
    `[solar-large] ${now.toLocaleTimeString()} | ` +
      `☀️  ${power_w.toFixed(0)}W | ` +
      `🌥  cloud:${weather.cloudCover}% | ` +
      `🔋 SOC:${batterySOC.toFixed(1)}% | ` +
      `⚡ ${energyToday.toFixed(3)} kWh today`,
  );
}
