require("dotenv").config();
const mqtt  = require("mqtt");
const fetch = require("node-fetch");

const DEVICE_ID   = process.env.SIM_DEVICE_ID;
const MQTT_BROKER  = process.env.MQTT_BROKER || "mqtt://mqtt:1883";
const API_KEY     = process.env.SIM_API_KEY;
const LAT         = parseFloat(process.env.SIM_LAT);
const LNG         = parseFloat(process.env.SIM_LNG);
const INTERVAL_MS  = 30000;

if (!API_KEY || isNaN(LAT) || isNaN(LNG)) {
  console.error("[solar-large] Missing SIM_API_KEY, SIM_LAT or SIM_LNG.");
  process.exit(1);
}

const client        = mqtt.connect(MQTT_BROKER);
const TOPIC_SOLAR   = `voltequilibrium/${API_KEY}/${DEVICE_ID}/solar`;
const TOPIC_BATTERY = `voltequilibrium/${API_KEY}/${DEVICE_ID}/battery`;

client.on("connect", () => {
  console.log(`[solar-large] Connected → ${MQTT_BROKER}`);
  runSimulation();
  setInterval(runSimulation, INTERVAL_MS);
});
client.on("error", (err) => console.error("[solar-large] MQTT error:", err.message));

// ── Weather cache ─────────────────────────────────────────────────────────────
let cachedWeather    = null;
let weatherFetchedAt = 0;
const WEATHER_TTL_MS  = 10 * 60 * 1000;

async function getWeather() {
  const now = Date.now();
  if (cachedWeather && now - weatherFetchedAt < WEATHER_TTL_MS) return cachedWeather;
  try {
    const res  = await fetch(
      `${process.env.BACKEND_URL || "http://localhost:3000"}/api/weather?lat=${LAT}&lng=${LNG}`,
      { headers: { Authorization: `Bearer ${process.env.SIM_TOKEN}` } },
    );
    const data = await res.json();
    cachedWeather    = data.data;
    weatherFetchedAt = now;
    console.log(`[solar-large] Weather → cloud:${cachedWeather.cloudCover}% wind:${cachedWeather.windSpeed}m/s temp:${cachedWeather.temperature}°C`);
  } catch (err) {
    console.warn("[solar-large] Weather fetch failed:", err.message);
    cachedWeather = cachedWeather || { cloudCover: 20, windSpeed: 3, temperature: 22 };
  }
  return cachedWeather;
}

// ── Physical constants ────────────────────────────────────────────────────────
// Large commercial array: 5–10 kW peak
const PEAK_POWER_W   = 10000;
const PANEL_VOLTAGE  = 108;     // string of 3 panels in series (3 × 36 V)
const BATTERY_CAP_WH = 20000;   // 20 kWh bank
const BUILDING_LOAD_W = 1000;   // larger building load

// ── State ─────────────────────────────────────────────────────────────────────
let batterySOC    = 60;
let energyToday   = 0;
let loadKwhToday  = 0;
let gridKwhToday  = 0;
let lastHour      = new Date().getHours();

function getSolarMultiplier(hour) {
  if (hour < 6 || hour > 19) return 0;
  return Math.sin(((hour - 6) * Math.PI) / 13);
}

function jitter(value, pct = 0.05) {
  return value * (1 + (Math.random() - 0.5) * 2 * pct);
}

async function runSimulation() {
  const weather = await getWeather();
  const localHour = parseInt(
    new Intl.DateTimeFormat("en-US", {
      hour: "numeric", hour12: false, timeZone: weather.timezone || "UTC",
    }).format(new Date()),
  );
  const now  = new Date();
  const hour = localHour;

  if (hour < lastHour) {
    energyToday  = 0;
    loadKwhToday = 0;
    gridKwhToday = 0;
  }
  lastHour = hour;

  // ── PV output ─────────────────────────────────────────────────────────────
  const timeMultiplier  = getSolarMultiplier(hour);
  // Large arrays rely more on direct irradiance, so cloud hits harder
  const cloudMultiplier = 1 - (weather.cloudCover / 100) * 0.85;
  const panelTemp       = weather.temperature + 5; // open-field arrays run hotter
  const tempMultiplier  = 1 - Math.max(0, (panelTemp - 25) * 0.004);
  const power_w         = Math.max(0, jitter(PEAK_POWER_W * timeMultiplier * cloudMultiplier * tempMultiplier, 0.05));

  const dc_voltage    = power_w > 0 ? jitter(PANEL_VOLTAGE, 0.02) : 0;
  const dc_current    = power_w > 0 ? jitter(power_w / PANEL_VOLTAGE, 0.03) : 0;
  const ac_voltage    = power_w > 0 ? jitter(230, 0.01) : 0;
  const ac_current    = power_w > 0 ? jitter((power_w * 0.965) / 230, 0.03) : 0;
  const frequency     = power_w > 0 ? jitter(50, 0.005) : 0;
  const inverter_temp = jitter(weather.temperature + (power_w / PEAK_POWER_W) * 25, 0.02);

  const intervalHours = INTERVAL_MS / 1000 / 3600;
  energyToday += (power_w / 1000) * intervalHours;

  // ── Load ──────────────────────────────────────────────────────────────────
  const load_watts  = Math.max(100, jitter(BUILDING_LOAD_W, 0.1));
  loadKwhToday     += (load_watts / 1000) * intervalHours;

  // ── Battery & grid model ──────────────────────────────────────────────────
  const netPower = power_w - load_watts;

  let grid_watts      = 0;
  let batteryNetPower = netPower;

  if (netPower >= 0) {
    if (batterySOC >= 99.9) {
      // Battery full — curtail excess, no grid export
      grid_watts      = 0;
      batteryNetPower = 0;
    }
  } else {
    if (batterySOC <= 0.1) {
      // Battery empty — import from grid (positive = import)
      grid_watts      = -netPower;
      batteryNetPower = 0;
    }
  }

  const socDelta = ((batteryNetPower * intervalHours) / (BATTERY_CAP_WH / 1000)) * 100;
  batterySOC = Math.min(100, Math.max(0, batterySOC + socDelta));

  if (grid_watts > 0) gridKwhToday += (grid_watts / 1000) * intervalHours;

  // LiFePO4 48 V nominal: 48 V (empty) → 58 V (full)
  const battery_voltage = 48 + (batterySOC / 100) * 10;
  const battery_current = battery_voltage > 0 ? batteryNetPower / battery_voltage : 0;
  const battery_temp    = jitter(weather.temperature + 4, 0.02);

  // ── Publish ───────────────────────────────────────────────────────────────
  client.publish(TOPIC_SOLAR, JSON.stringify({
    power_w:     parseFloat(power_w.toFixed(2)),
    dc_voltage:  parseFloat(dc_voltage.toFixed(2)),
    dc_current:  parseFloat(dc_current.toFixed(3)),
    ac_voltage:  parseFloat(ac_voltage.toFixed(2)),
    ac_current:  parseFloat(ac_current.toFixed(3)),
    frequency:   parseFloat(frequency.toFixed(2)),
    temperature: parseFloat(inverter_temp.toFixed(1)),
    energy_kwh:  parseFloat(energyToday.toFixed(4)),
    load_watts:  parseFloat(load_watts.toFixed(2)),
    load_kwh:    parseFloat(loadKwhToday.toFixed(4)),
    grid_watts:  parseFloat(grid_watts.toFixed(2)),
    grid_kwh:    parseFloat(gridKwhToday.toFixed(4)),
    wind_speed: null, rotor_rpm: null, pitch_angle: null,
    profile: "solar-large", cloud_cover: weather.cloudCover,
    timestamp: now.toISOString(),
  }), { qos: 1 });

  client.publish(TOPIC_BATTERY, JSON.stringify({
    state_of_charge: parseFloat(batterySOC.toFixed(2)),
    voltage:         parseFloat(battery_voltage.toFixed(2)),
    current:         parseFloat(battery_current.toFixed(3)),
    temperature:     parseFloat(battery_temp.toFixed(1)),
    power_w:         parseFloat(batteryNetPower.toFixed(2)),
    timestamp: now.toISOString(),
  }), { qos: 1 });

  console.log(
    `[solar-large] ${now.toLocaleTimeString()} | ` +
    `☀️  ${power_w.toFixed(0)}W | 🏠 ${load_watts.toFixed(0)}W | ` +
    `⚡ grid:${grid_watts.toFixed(0)}W | 🔋 SOC:${batterySOC.toFixed(1)}% | ` +
    `📦 ${energyToday.toFixed(3)} kWh`,
  );
}
