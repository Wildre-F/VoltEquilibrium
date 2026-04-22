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
  console.error("[wind-large] Missing SIM_API_KEY, SIM_LAT or SIM_LNG.");
  process.exit(1);
}

const client        = mqtt.connect(MQTT_BROKER);
const TOPIC_WIND    = `voltequilibrium/${API_KEY}/${DEVICE_ID}/wind`;
const TOPIC_BATTERY = `voltequilibrium/${API_KEY}/${DEVICE_ID}/battery`;

client.on("connect", () => {
  console.log(`[wind-large] Connected → ${MQTT_BROKER}`);
  runSimulation();
  setInterval(runSimulation, INTERVAL_MS);
});
client.on("error", (err) => console.error("[wind-large] MQTT error:", err.message));

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
    console.log(`[wind-large] Weather → wind:${cachedWeather.windSpeed}m/s temp:${cachedWeather.temperature}°C`);
  } catch (err) {
    console.warn("[wind-large] Weather fetch failed:", err.message);
    cachedWeather = cachedWeather || { cloudCover: 30, windSpeed: 6, temperature: 18 };
  }
  return cachedWeather;
}

// ── Wind turbine physics ──────────────────────────────────────────────────────
// Large farm turbine: rated 15 kW at 13 m/s.
// Active pitch control adjusts blade angle to maximise output below rated speed
// and limit output above it, unlike small turbines that use passive stall.
// Hub height correction: wind speed increases with height (power-law shear model).
const RATED_POWER_W    = 15000;
const RATED_WIND_SPEED = 13;
const CUT_IN_SPEED     = 3.5;
const CUT_OUT_SPEED    = 25;
const GENERATOR_VOLTAGE = 120; // higher DC bus for large machines
const BATTERY_CAP_WH   = 20000;
const BUILDING_LOAD_W  = 1000;
const HUB_HEIGHT       = 40;   // metres
const SHEAR_EXPONENT   = 0.14; // power-law wind shear (open land)

// ── State ─────────────────────────────────────────────────────────────────────
let batterySOC    = 60;
let energyToday   = 0;
let loadKwhToday  = 0;
let gridKwhToday  = 0;
let lastHour      = new Date().getHours();

// Active pitch control: fine pitch at low wind for max lift, increase toward
// rated speed to begin limiting, >rated increase further to spill excess energy
function getPitchAngle(windSpeed) {
  if (windSpeed >= CUT_OUT_SPEED || windSpeed < CUT_IN_SPEED) return 90;
  if (windSpeed <= 8) return jitter(2, 0.1);
  if (windSpeed <= RATED_WIND_SPEED) {
    const frac = (windSpeed - 8) / (RATED_WIND_SPEED - 8);
    return jitter(2 + frac * 10, 0.05);
  }
  const frac = Math.min(1, (windSpeed - RATED_WIND_SPEED) / (CUT_OUT_SPEED - RATED_WIND_SPEED));
  return jitter(12 + frac * 18, 0.05);
}

// Large turbines spin 10–25 RPM (slow rotor, gearbox steps up to generator)
function getRotorRPM(windSpeed) {
  if (windSpeed < CUT_IN_SPEED || windSpeed >= CUT_OUT_SPEED) return 0;
  return jitter((Math.min(windSpeed, RATED_WIND_SPEED) / RATED_WIND_SPEED) * 25, 0.04);
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

  // ── Wind at hub height (power-law wind shear correction) ──────────────────
  const windAtHub        = weather.windSpeed * Math.pow(HUB_HEIGHT / 10, SHEAR_EXPONENT);
  const instantWindSpeed = Math.max(0, jitter(windAtHub, 0.15));

  const power_w      = Math.max(0, jitter(getWindPower(instantWindSpeed), 0.03));
  const rotor_rpm    = getRotorRPM(instantWindSpeed);
  const pitch_angle  = getPitchAngle(instantWindSpeed);

  const dc_voltage    = power_w > 0 ? jitter(GENERATOR_VOLTAGE, 0.015) : 0;
  const dc_current    = power_w > 0 ? jitter(power_w / GENERATOR_VOLTAGE, 0.03) : 0;
  const ac_voltage    = power_w > 0 ? jitter(230, 0.01) : 0;
  const ac_current    = power_w > 0 ? jitter((power_w * 0.955) / 230, 0.03) : 0;
  const frequency     = power_w > 0 ? jitter(50, 0.005) : 0;
  const inverter_temp = jitter(weather.temperature + (power_w / RATED_POWER_W) * 30, 0.02);

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
      grid_watts      = 0;
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

  // LiFePO4 48 V nominal: 48 V (empty) → 58 V (full)
  const battery_voltage = 48 + (batterySOC / 100) * 10;
  const battery_current = battery_voltage > 0 ? batteryNetPower / battery_voltage : 0;
  const battery_temp    = jitter(weather.temperature + 4, 0.02);

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
    profile: "wind-large", cloud_cover: weather.cloudCover,
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
    `[wind-large] ${now.toLocaleTimeString()} | ` +
    `💨 ${instantWindSpeed.toFixed(1)}m/s hub | ⚙️  ${rotor_rpm.toFixed(1)}rpm | ` +
    `🎯 pitch:${pitch_angle.toFixed(1)}° | ⚡ ${power_w.toFixed(0)}W | ` +
    `🏠 ${load_watts.toFixed(0)}W | grid:${grid_watts.toFixed(0)}W | 🔋 SOC:${batterySOC.toFixed(1)}%`,
  );
}
