require("dotenv").config();
const mqtt = require("mqtt");
const fetch = require("node-fetch");
const DEVICE_ID = process.env.SIM_DEVICE_ID; // inverter DB id to fetch config from database

// ── Config ────────────────────────────────────────────────────────────────────
const MQTT_BROKER = process.env.MQTT_BROKER || "mqtt://mqtt:1883";
const API_KEY = process.env.SIM_API_KEY;
const LAT = parseFloat(process.env.SIM_LAT);
const LNG = parseFloat(process.env.SIM_LNG);
const INTERVAL_MS = 30000; // publish every 30 seconds

if (!API_KEY || isNaN(LAT) || isNaN(LNG)) {
  console.error(
    "[wind-small] Missing SIM_API_KEY, SIM_LAT or SIM_LNG in environment.",
  );
  process.exit(1);
}

// ── MQTT ──────────────────────────────────────────────────────────────────────
const client = mqtt.connect(MQTT_BROKER);
const TOPIC_WIND = `voltequilibrium/${API_KEY}/${DEVICE_ID}/wind`;
const TOPIC_BATTERY = `voltequilibrium/${API_KEY}/${DEVICE_ID}/battery`;

client.on("connect", () => {
  console.log(`[wind-small] Connected to MQTT broker → ${MQTT_BROKER}`);
  console.log(`[wind-small] Publishing to ${TOPIC_WIND}`);
  runSimulation();
  setInterval(runSimulation, INTERVAL_MS);
});

client.on("error", (err) => {
  console.error("[wind-small] MQTT error:", err.message);
});

// ── Weather ───────────────────────────────────────────────────────────────────
let cachedWeather = null;
let weatherFetchedAt = 0;
const WEATHER_TTL_MS = 10 * 60 * 1000;

async function getWeather() {
  const now = Date.now();
  if (cachedWeather && now - weatherFetchedAt < WEATHER_TTL_MS) {
    return cachedWeather;
  }
  try {
    const res = await fetch(
      `http://localhost:3000/api/weather?lat=${LAT}&lng=${LNG}`,
      {
        headers: { Authorization: `Bearer ${process.env.SIM_TOKEN}` },
      },
    );
    const data = await res.json();
    cachedWeather = data.data;
    weatherFetchedAt = now;
    console.log(
      `[wind-small] Weather → wind: ${cachedWeather.windSpeed} m/s | temp: ${cachedWeather.temperature}°C`,
    );
  } catch (err) {
    console.warn(
      "[wind-small] Weather fetch failed, using defaults:",
      err.message,
    );
    cachedWeather = cachedWeather || {
      cloudCover: 30,
      windSpeed: 5,
      temperature: 20,
    };
  }
  return cachedWeather;
}

// ── Wind turbine physics ──────────────────────────────────────────────────────
// Small domestic turbine: rated at ~2 kW at 12 m/s (cut-in 3 m/s, cut-out 20 m/s)
//
// THE WIND POWER CUBE LAW (important concept!):
// Wind power is proportional to the CUBE of wind speed:
//   P = 0.5 × ρ × A × Cp × v³
// where:
//   ρ  = air density (~1.225 kg/m³)
//   A  = swept area of rotor blades (m²)
//   Cp = power coefficient (max ~0.45 for a good turbine — Betz limit is 0.593)
//   v  = wind speed (m/s)
//
// What this means practically: double the wind speed → 8× the power!
// This is why wind turbines have cut-out speeds — too much wind = too much power.
//
// For our simulator we use a simplified "power curve" approach:
// - Below cut-in (3 m/s): turbine is stationary, 0 W output
// - 3–12 m/s: power scales as v³ (cube law), reaching rated power at 12 m/s
// - 12–20 m/s: turbine holds at rated power (pitch control limits output)
// - Above 20 m/s: turbine shuts down (cut-out, safety)

const RATED_POWER_W = 2000; // watts at rated wind speed
const RATED_WIND_SPEED = 12; // m/s at which rated power is reached
const CUT_IN_SPEED = 3; // m/s — minimum wind to start generating
const CUT_OUT_SPEED = 20; // m/s — shut down above this for safety
const GENERATOR_VOLTAGE = 48; // DC output from the generator
const BATTERY_CAP_WH = 5000; // 5 kWh battery

let batterySOC = 60;
let energyToday = 0;
let lastHour = new Date().getHours();

// Simulate realistic rotor RPM from wind speed.
// Small turbines spin ~100–600 RPM depending on wind.
function getRotorRPM(windSpeed) {
  if (windSpeed < CUT_IN_SPEED) return 0;
  // RPM scales roughly linearly with wind speed up to rated
  const cappedWind = Math.min(windSpeed, RATED_WIND_SPEED);
  return jitter((cappedWind / RATED_WIND_SPEED) * 550, 0.05);
}

// Pitch angle: small domestic turbines use passive stall control (fixed blades)
// rather than active pitch control. We model a fixed 5-degree pitch with slight noise.
// On cut-out, blades feather to ~90° (side-on to wind) to stop the rotor.
function getPitchAngle(windSpeed) {
  if (windSpeed >= CUT_OUT_SPEED) return 90; // feathered for safety
  return jitter(5, 0.1); // fixed-pitch ~5° with small noise
}

// Apply the wind power cube law to get output power in watts
function getWindPower(windSpeed) {
  if (windSpeed < CUT_IN_SPEED || windSpeed >= CUT_OUT_SPEED) return 0;
  if (windSpeed >= RATED_WIND_SPEED) return RATED_POWER_W; // pitch holds power flat

  // Cube-law scaling between cut-in and rated speed
  // (windSpeed / RATED_WIND_SPEED)³ gives a 0–1 fraction of rated power
  const cubeFraction = Math.pow(windSpeed / RATED_WIND_SPEED, 3);
  return RATED_POWER_W * cubeFraction;
}

function jitter(value, pct = 0.05) {
  return value * (1 + (Math.random() - 0.5) * 2 * pct);
}

async function runSimulation() {
  const weather = await getWeather();
  // Use the location's local time, not the server's time.
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

  // ── Wind is gusty — add realistic short-term variation ───────────────────
  // Open-Meteo gives a 10-minute average. Real wind gusts ±30% around that.
  // We simulate this with a larger jitter than solar uses.
  const instantWindSpeed = Math.max(
    0,
    jitter(weather.windSpeed, 0.2), // ±20% gust factor
  );

  // ── Power output from wind ────────────────────────────────────────────────
  const rawPower = getWindPower(instantWindSpeed);
  const power_w = Math.max(0, jitter(rawPower, 0.04));

  // Rotor and blade state
  const rotor_rpm = getRotorRPM(instantWindSpeed);
  const pitch_angle = getPitchAngle(instantWindSpeed);

  // DC side — permanent-magnet generators output DC directly (or via rectifier)
  const dc_current =
    power_w > 0 ? jitter(power_w / GENERATOR_VOLTAGE, 0.03) : 0;
  const dc_voltage = power_w > 0 ? jitter(GENERATOR_VOLTAGE, 0.02) : 0;

  // AC side — most small turbines use a grid-tie inverter or charge controller
  const ac_voltage = power_w > 0 ? jitter(230, 0.01) : 0;
  const ac_current = power_w > 0 ? jitter((power_w * 0.94) / 230, 0.03) : 0;
  const frequency = power_w > 0 ? jitter(50, 0.005) : 0;

  // Inverter/controller temperature
  const inverter_temp = jitter(
    weather.temperature + (power_w / RATED_POWER_W) * 18,
    0.02,
  );

  // Energy accumulated this interval
  const intervalHours = INTERVAL_MS / 1000 / 3600;
  energyToday += (power_w / 1000) * intervalHours;

  // ── Battery simulation ────────────────────────────────────────────────────
  const HOUSE_LOAD_W = 300;
  const netPower = power_w - HOUSE_LOAD_W;
  const socDelta = ((netPower * intervalHours) / (BATTERY_CAP_WH / 1000)) * 100;
  batterySOC = Math.min(100, Math.max(0, batterySOC + socDelta));

  const battery_voltage = 48 + (batterySOC / 100) * 6;
  const battery_current = netPower / battery_voltage;
  const battery_power = netPower;
  const battery_temp = jitter(weather.temperature + 3, 0.02);

  // ── Build payloads ────────────────────────────────────────────────────────
  const windPayload = {
    power_w: parseFloat(power_w.toFixed(2)),
    dc_voltage: parseFloat(dc_voltage.toFixed(2)),
    dc_current: parseFloat(dc_current.toFixed(3)),
    ac_voltage: parseFloat(ac_voltage.toFixed(2)),
    ac_current: parseFloat(ac_current.toFixed(3)),
    frequency: parseFloat(frequency.toFixed(2)),
    temperature: parseFloat(inverter_temp.toFixed(1)),
    energy_kwh: parseFloat(energyToday.toFixed(4)),
    wind_speed: parseFloat(instantWindSpeed.toFixed(2)),
    rotor_rpm: parseFloat(rotor_rpm.toFixed(1)),
    pitch_angle: parseFloat(pitch_angle.toFixed(1)),
    profile: "wind-small",
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
  client.publish(TOPIC_WIND, JSON.stringify(windPayload), { qos: 1 });
  client.publish(TOPIC_BATTERY, JSON.stringify(batteryPayload), { qos: 1 });

  console.log(
    `[wind-small] ${now.toLocaleTimeString()} | ` +
      `💨 wind:${instantWindSpeed.toFixed(1)}m/s | ` +
      `⚙️  ${rotor_rpm.toFixed(0)}rpm | ` +
      `⚡ ${power_w.toFixed(0)}W | ` +
      `🔋 SOC:${batterySOC.toFixed(1)}% | ` +
      `📦 ${energyToday.toFixed(3)} kWh today`,
  );
}
