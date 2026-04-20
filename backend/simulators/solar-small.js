require("dotenv").config();
const mqtt  = require("mqtt");
const fetch = require("node-fetch");

const DEVICE_ID  = process.env.SIM_DEVICE_ID;
const MQTT_BROKER = process.env.MQTT_BROKER || "mqtt://mqtt:1883";
const API_KEY    = process.env.SIM_API_KEY;
const LAT        = parseFloat(process.env.SIM_LAT);
const LNG        = parseFloat(process.env.SIM_LNG);
const INTERVAL_MS = 30000;

if (!API_KEY || isNaN(LAT) || isNaN(LNG)) {
  console.error("[solar-small] Missing SIM_API_KEY, SIM_LAT or SIM_LNG.");
  process.exit(1);
}

const client       = mqtt.connect(MQTT_BROKER);
const TOPIC_SOLAR  = `voltequilibrium/${API_KEY}/${DEVICE_ID}/solar`;
const TOPIC_BATTERY = `voltequilibrium/${API_KEY}/${DEVICE_ID}/battery`;

client.on("connect", () => {
  console.log(`[solar-small] Connected → ${MQTT_BROKER}`);
  runSimulation();
  setInterval(runSimulation, INTERVAL_MS);
});
client.on("error", (err) => console.error("[solar-small] MQTT error:", err.message));

// ── Weather cache ─────────────────────────────────────────────────────────────
let cachedWeather   = null;
let weatherFetchedAt = 0;
const WEATHER_TTL_MS = 10 * 60 * 1000;

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
    console.log(`[solar-small] Weather → cloud:${cachedWeather.cloudCover}% wind:${cachedWeather.windSpeed}m/s temp:${cachedWeather.temperature}°C`);
  } catch (err) {
    console.warn("[solar-small] Weather fetch failed:", err.message);
    cachedWeather = cachedWeather || { cloudCover: 20, windSpeed: 3, temperature: 22 };
  }
  return cachedWeather;
}

// ── Physical constants ────────────────────────────────────────────────────────
// Small rooftop array: 1–3 kW peak
const PEAK_POWER_W  = 3000;
const PANEL_VOLTAGE = 36;      // typical panel Voc
const BATTERY_CAP_WH = 5000;   // 5 kWh
const HOUSE_LOAD_W   = 300;    // average household draw

// ── State ─────────────────────────────────────────────────────────────────────
let batterySOC    = 60;
let energyToday   = 0;   // kWh generated
let loadKwhToday  = 0;   // kWh consumed by house
let gridKwhToday  = 0;   // kWh imported from grid
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

  // Reset daily counters at midnight
  if (hour < lastHour) {
    energyToday  = 0;
    loadKwhToday = 0;
    gridKwhToday = 0;
  }
  lastHour = hour;

  // ── PV output ─────────────────────────────────────────────────────────────
  const timeMultiplier  = getSolarMultiplier(hour);
  const cloudMultiplier = 1 - (weather.cloudCover / 100) * 0.8;
  const tempMultiplier  = 1 - Math.max(0, (weather.temperature - 25) * 0.004);
  const power_w         = Math.max(0, jitter(PEAK_POWER_W * timeMultiplier * cloudMultiplier * tempMultiplier, 0.06));

  const dc_voltage    = power_w > 0 ? jitter(PANEL_VOLTAGE, 0.02) : 0;
  const dc_current    = power_w > 0 ? jitter(power_w / PANEL_VOLTAGE, 0.03) : 0;
  const ac_voltage    = power_w > 0 ? jitter(230, 0.01) : 0;
  const ac_current    = power_w > 0 ? jitter((power_w * 0.96) / 230, 0.03) : 0;
  const frequency     = power_w > 0 ? jitter(50, 0.005) : 0;
  const inverter_temp = jitter(weather.temperature + (power_w / PEAK_POWER_W) * 15, 0.02);

  const intervalHours = INTERVAL_MS / 1000 / 3600;
  energyToday += (power_w / 1000) * intervalHours;

  // ── Load (house consumption) ──────────────────────────────────────────────
  const load_watts = Math.max(50, jitter(HOUSE_LOAD_W, 0.1));
  loadKwhToday    += (load_watts / 1000) * intervalHours;

  // ── Battery & grid model ──────────────────────────────────────────────────
  // net = what solar generates above/below house load
  const netPower = power_w - load_watts;

  let grid_watts      = 0;
  let batteryNetPower = netPower; // what actually flows into/out of battery

  if (netPower >= 0) {
    // Solar covers load and has surplus
    if (batterySOC >= 99.9) {
      // Battery full → export surplus to grid
      grid_watts      = -netPower; // negative = export
      batteryNetPower = 0;
    }
    // else: charge battery, no grid interaction
  } else {
    // Solar can't cover load, draw from battery
    if (batterySOC <= 0.1) {
      // Battery empty → import from grid
      grid_watts      = -netPower; // positive = import
      batteryNetPower = 0;
    }
    // else: discharge battery, no grid interaction
  }

  const socDelta = ((batteryNetPower * intervalHours) / (BATTERY_CAP_WH / 1000)) * 100;
  batterySOC = Math.min(100, Math.max(0, batterySOC + socDelta));

  if (grid_watts > 0) gridKwhToday += (grid_watts / 1000) * intervalHours;

  const battery_voltage = 48 + (batterySOC / 100) * 6; // 48–54 V LiFePO4
  const battery_current = battery_voltage > 0 ? batteryNetPower / battery_voltage : 0;
  const battery_temp    = jitter(weather.temperature + 3, 0.02);

  // ── Publish ───────────────────────────────────────────────────────────────
  client.publish(TOPIC_SOLAR, JSON.stringify({
    power_w:      parseFloat(power_w.toFixed(2)),
    dc_voltage:   parseFloat(dc_voltage.toFixed(2)),
    dc_current:   parseFloat(dc_current.toFixed(3)),
    ac_voltage:   parseFloat(ac_voltage.toFixed(2)),
    ac_current:   parseFloat(ac_current.toFixed(3)),
    frequency:    parseFloat(frequency.toFixed(2)),
    temperature:  parseFloat(inverter_temp.toFixed(1)),
    energy_kwh:   parseFloat(energyToday.toFixed(4)),
    load_watts:   parseFloat(load_watts.toFixed(2)),
    load_kwh:     parseFloat(loadKwhToday.toFixed(4)),
    grid_watts:   parseFloat(grid_watts.toFixed(2)),
    grid_kwh:     parseFloat(gridKwhToday.toFixed(4)),
    wind_speed: null, rotor_rpm: null, pitch_angle: null,
    profile: "solar-small", cloud_cover: weather.cloudCover,
    timestamp: now.toISOString(),
  }), { qos: 1 });

  client.publish(TOPIC_BATTERY, JSON.stringify({
    state_of_charge: parseFloat(batterySOC.toFixed(2)),
    voltage:         parseFloat(battery_voltage.toFixed(2)),
    current:         parseFloat(battery_current.toFixed(3)),
    temperature:     parseFloat(battery_temp.toFixed(1)),
    power_w:         parseFloat(batteryNetPower.toFixed(2)), // + charging, - discharging
    timestamp: now.toISOString(),
  }), { qos: 1 });

  console.log(
    `[solar-small] ${now.toLocaleTimeString()} | ` +
    `☀️  ${power_w.toFixed(0)}W | 🏠 ${load_watts.toFixed(0)}W | ` +
    `⚡ grid:${grid_watts.toFixed(0)}W | 🔋 SOC:${batterySOC.toFixed(1)}% | ` +
    `📦 ${energyToday.toFixed(3)} kWh`,
  );
}
