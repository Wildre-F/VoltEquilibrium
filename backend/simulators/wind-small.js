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
  console.error("[wind-small] Missing SIM_API_KEY, SIM_LAT or SIM_LNG.");
  process.exit(1);
}

const client        = mqtt.connect(MQTT_BROKER);
const TOPIC_WIND    = `voltequilibrium/${API_KEY}/${DEVICE_ID}/wind`;
const TOPIC_BATTERY = `voltequilibrium/${API_KEY}/${DEVICE_ID}/battery`;

client.on("connect", () => {
  console.log(`[wind-small] Connected → ${MQTT_BROKER}`);
  runSimulation();
  setInterval(runSimulation, INTERVAL_MS);
});
client.on("error", (err) => console.error("[wind-small] MQTT error:", err.message));

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
    console.log(`[wind-small] Weather → wind:${cachedWeather.windSpeed}m/s temp:${cachedWeather.temperature}°C`);
  } catch (err) {
    console.warn("[wind-small] Weather fetch failed:", err.message);
    cachedWeather = cachedWeather || { cloudCover: 30, windSpeed: 5, temperature: 20 };
  }
  return cachedWeather;
}

// ── Wind turbine physics ──────────────────────────────────────────────────────
// Small domestic turbine: rated 2 kW at 12 m/s
// Wind power ∝ v³ (cube law). Cut-in: 3 m/s. Cut-out: 20 m/s.
// Passive stall control (fixed blade pitch, unlike large active-pitch turbines).
const RATED_POWER_W   = 2000;
const RATED_WIND_SPEED = 12;
const CUT_IN_SPEED    = 3;
const CUT_OUT_SPEED   = 20;
const GENERATOR_VOLTAGE = 48;
const BATTERY_CAP_WH  = 5000;
const HOUSE_LOAD_W    = 300;

// ── State ─────────────────────────────────────────────────────────────────────
let batterySOC    = 60;
let energyToday   = 0;
let loadKwhToday  = 0;
let gridKwhToday  = 0;
let lastHour      = new Date().getHours();

function getRotorRPM(windSpeed) {
  if (windSpeed < CUT_IN_SPEED) return 0;
  return jitter((Math.min(windSpeed, RATED_WIND_SPEED) / RATED_WIND_SPEED) * 550, 0.05);
}

// Passive stall: fixed ~5° pitch, feather to 90° at cut-out
function getPitchAngle(windSpeed) {
  if (windSpeed >= CUT_OUT_SPEED) return 90;
  return jitter(5, 0.1);
}

function getWindPower(windSpeed) {
  if (windSpeed < CUT_IN_SPEED || windSpeed >= CUT_OUT_SPEED) return 0;
  if (windSpeed >= RATED_WIND_SPEED) return RATED_POWER_W;
  return RATED_POWER_W * Math.pow(windSpeed / RATED_WIND_SPEED, 3);
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

  // ── Wind & power output ───────────────────────────────────────────────────
  const instantWindSpeed = Math.max(0, jitter(weather.windSpeed, 0.2));
  const power_w          = Math.max(0, jitter(getWindPower(instantWindSpeed), 0.04));
  const rotor_rpm        = getRotorRPM(instantWindSpeed);
  const pitch_angle      = getPitchAngle(instantWindSpeed);

  const dc_voltage    = power_w > 0 ? jitter(GENERATOR_VOLTAGE, 0.02) : 0;
  const dc_current    = power_w > 0 ? jitter(power_w / GENERATOR_VOLTAGE, 0.03) : 0;
  const ac_voltage    = power_w > 0 ? jitter(230, 0.01) : 0;
  const ac_current    = power_w > 0 ? jitter((power_w * 0.94) / 230, 0.03) : 0;
  const frequency     = power_w > 0 ? jitter(50, 0.005) : 0;
  const inverter_temp = jitter(weather.temperature + (power_w / RATED_POWER_W) * 18, 0.02);

  const intervalHours = INTERVAL_MS / 1000 / 3600;
  energyToday += (power_w / 1000) * intervalHours;

  // ── Load ──────────────────────────────────────────────────────────────────
  const load_watts  = Math.max(50, jitter(HOUSE_LOAD_W, 0.1));
  loadKwhToday     += (load_watts / 1000) * intervalHours;

  // ── Battery & grid model ──────────────────────────────────────────────────
  const netPower = power_w - load_watts;

  let grid_watts      = 0;
  let batteryNetPower = netPower;

  if (netPower >= 0) {
    if (batterySOC >= 99.9) {
      grid_watts      = -netPower;
      batteryNetPower = 0;
    }
  } else {
    if (batterySOC <= 0.1) {
      grid_watts      = -netPower;
      batteryNetPower = 0;
    }
  }

  const socDelta = ((batteryNetPower * intervalHours) / (BATTERY_CAP_WH / 1000)) * 100;
  batterySOC = Math.min(100, Math.max(0, batterySOC + socDelta));

  if (grid_watts > 0) gridKwhToday += (grid_watts / 1000) * intervalHours;

  const battery_voltage = 48 + (batterySOC / 100) * 6;
  const battery_current = battery_voltage > 0 ? batteryNetPower / battery_voltage : 0;
  const battery_temp    = jitter(weather.temperature + 3, 0.02);

  // ── Publish ───────────────────────────────────────────────────────────────
  client.publish(TOPIC_WIND, JSON.stringify({
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
    wind_speed:  parseFloat(instantWindSpeed.toFixed(2)),
    rotor_rpm:   parseFloat(rotor_rpm.toFixed(1)),
    pitch_angle: parseFloat(pitch_angle.toFixed(1)),
    profile: "wind-small", cloud_cover: weather.cloudCover,
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
    `[wind-small] ${now.toLocaleTimeString()} | ` +
    `💨 ${instantWindSpeed.toFixed(1)}m/s | ⚙️  ${rotor_rpm.toFixed(0)}rpm | ` +
    `⚡ ${power_w.toFixed(0)}W | 🏠 ${load_watts.toFixed(0)}W | ` +
    `grid:${grid_watts.toFixed(0)}W | 🔋 SOC:${batterySOC.toFixed(1)}%`,
  );
}
