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
    "[wind-large] Missing SIM_API_KEY, SIM_LAT or SIM_LNG in environment.",
  );
  process.exit(1);
}

// ── MQTT ──────────────────────────────────────────────────────────────────────
const client = mqtt.connect(MQTT_BROKER);
const TOPIC_WIND = `voltequilibrium/${API_KEY}/${DEVICE_ID}/wind`;
const TOPIC_BATTERY = `voltequilibrium/${API_KEY}/${DEVICE_ID}/battery`;

client.on("connect", () => {
  console.log(`[wind-large] Connected to MQTT broker → ${MQTT_BROKER}`);
  console.log(`[wind-large] Publishing to ${TOPIC_WIND}`);
  runSimulation();
  setInterval(runSimulation, INTERVAL_MS);
});

client.on("error", (err) => {
  console.error("[wind-large] MQTT error:", err.message);
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
      `${process.env.BACKEND_URL || "http://localhost:3000"}/api/weather?lat=${LAT}&lng=${LNG}`,
      {
        headers: { Authorization: `Bearer ${process.env.SIM_TOKEN}` },
      },
    );
    const data = await res.json();
    cachedWeather = data.data;
    weatherFetchedAt = now;
    console.log(
      `[wind-large] Weather → wind: ${cachedWeather.windSpeed} m/s | temp: ${cachedWeather.temperature}°C`,
    );
  } catch (err) {
    console.warn(
      "[wind-large] Weather fetch failed, using defaults:",
      err.message,
    );
    cachedWeather = cachedWeather || {
      cloudCover: 30,
      windSpeed: 6,
      temperature: 18,
    };
  }
  return cachedWeather;
}

// ── Wind turbine physics ──────────────────────────────────────────────────────
// Large farm/commercial turbine: rated at ~15 kW at 13 m/s
//
// KEY DIFFERENCE FROM wind-small: active pitch control
// Large turbines use ACTIVE PITCH CONTROL — the blade angle is continuously
// adjusted by a computer to:
//   1. Maximise power below rated speed (pitch into the wind for more lift)
//   2. Limit power to rated above rated speed (pitch away to "spill" excess wind)
//   3. Stop the turbine safely above cut-out speed (feather to 90°)
//
// This is more efficient than the passive stall used on small turbines,
// which is why large turbines have higher capacity factors in real life.
//
// We simulate pitch angle changing dynamically with wind speed:
//   - 3–8 m/s  (below rated): pitch ~2°, maximising lift coefficient
//   - 8–13 m/s (approaching rated): pitch gradually increases to ~12°
//   - 13–25 m/s (above rated): pitch increases further to ~30°, capping output
//   - >25 m/s  (cut-out): pitch goes to 90° (feathered), rotor stops

const RATED_POWER_W = 15000; // watts at rated wind speed
const RATED_WIND_SPEED = 13; // m/s
const CUT_IN_SPEED = 3.5; // m/s — larger rotor needs slightly more wind to start
const CUT_OUT_SPEED = 25; // m/s — large turbines can handle stronger winds
const GENERATOR_VOLTAGE = 120; // DC bus voltage (higher for larger machines)
const BATTERY_CAP_WH = 20000; // 20 kWh battery bank

let batterySOC = 60;
let energyToday = 0;
let lastHour = new Date().getHours();

// Compute active pitch angle based on current wind speed.
// Returns blade pitch in degrees (0 = edge-on = maximum lift, 90 = flat = feathered)
function getPitchAngle(windSpeed) {
  if (windSpeed >= CUT_OUT_SPEED) return 90; // feathered — rotor stopped
  if (windSpeed < CUT_IN_SPEED) return 90; // also feathered while parked
  if (windSpeed <= 8) return jitter(2, 0.1); // fine pitch — max lift
  if (windSpeed <= RATED_WIND_SPEED) {
    // Linear ramp from 2° to 12° as we approach rated speed
    const fraction = (windSpeed - 8) / (RATED_WIND_SPEED - 8);
    return jitter(2 + fraction * 10, 0.05);
  }
  // Above rated: pitch further to 30° to spill excess wind power
  const fraction = Math.min(
    1,
    (windSpeed - RATED_WIND_SPEED) / (CUT_OUT_SPEED - RATED_WIND_SPEED),
  );
  return jitter(12 + fraction * 18, 0.05);
}

// Rotor RPM: large turbines spin much slower than small ones (bigger blades).
// Typical range: 10–25 RPM. They use a gearbox to step up to generator speed.
function getRotorRPM(windSpeed) {
  if (windSpeed < CUT_IN_SPEED || windSpeed >= CUT_OUT_SPEED) return 0;
  const cappedWind = Math.min(windSpeed, RATED_WIND_SPEED);
  return jitter((cappedWind / RATED_WIND_SPEED) * 25, 0.04);
}

// Power curve using the cube law, with active pitch limiting above rated speed
function getWindPower(windSpeed) {
  if (windSpeed < CUT_IN_SPEED || windSpeed >= CUT_OUT_SPEED) return 0;
  if (windSpeed >= RATED_WIND_SPEED) return RATED_POWER_W; // pitch control holds flat

  // Below rated: cube-law scaling
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

  // ── Wind speed with gust simulation ──────────────────────────────────────
  // Large turbines are typically taller (hub height 30–50 m for this size),
  // and wind speed increases with height (wind shear effect). The Open-Meteo
  // API gives wind at 10 m height, so we apply a shear correction.
  // Simple power-law: v_hub = v_10m × (h_hub / 10)^α  where α ≈ 0.14 (open land)
  const HUB_HEIGHT = 40; // metres
  const SHEAR_EXPONENT = 0.14;
  const windAtHub =
    weather.windSpeed * Math.pow(HUB_HEIGHT / 10, SHEAR_EXPONENT);

  // Add gust variation on top of the height-adjusted speed
  const instantWindSpeed = Math.max(0, jitter(windAtHub, 0.15));

  // ── Power output ──────────────────────────────────────────────────────────
  const rawPower = getWindPower(instantWindSpeed);
  const power_w = Math.max(0, jitter(rawPower, 0.03));

  const rotor_rpm = getRotorRPM(instantWindSpeed);
  const pitch_angle = getPitchAngle(instantWindSpeed);

  // DC side
  const dc_current =
    power_w > 0 ? jitter(power_w / GENERATOR_VOLTAGE, 0.03) : 0;
  const dc_voltage = power_w > 0 ? jitter(GENERATOR_VOLTAGE, 0.015) : 0;

  // AC side — ~95.5% efficiency (slightly lower than solar due to mechanical losses)
  const ac_voltage = power_w > 0 ? jitter(230, 0.01) : 0;
  const ac_current = power_w > 0 ? jitter((power_w * 0.955) / 230, 0.03) : 0;
  const frequency = power_w > 0 ? jitter(50, 0.005) : 0;

  // Generator temperature — larger machine runs hotter under heavy load
  const inverter_temp = jitter(
    weather.temperature + (power_w / RATED_POWER_W) * 30,
    0.02,
  );

  // Energy accumulated this interval
  const intervalHours = INTERVAL_MS / 1000 / 3600;
  energyToday += (power_w / 1000) * intervalHours;

  // ── Battery simulation ────────────────────────────────────────────────────
  const BUILDING_LOAD_W = 1000;
  const netPower = power_w - BUILDING_LOAD_W;
  const socDelta = ((netPower * intervalHours) / (BATTERY_CAP_WH / 1000)) * 100;
  batterySOC = Math.min(100, Math.max(0, batterySOC + socDelta));

  const battery_voltage = 48 + (batterySOC / 100) * 10;
  const battery_current = netPower / battery_voltage;
  const battery_power = netPower;
  const battery_temp = jitter(weather.temperature + 4, 0.02);

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
    profile: "wind-large",
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
    `[wind-large] ${now.toLocaleTimeString()} | ` +
      `💨 wind:${instantWindSpeed.toFixed(1)}m/s (hub) | ` +
      `⚙️  ${rotor_rpm.toFixed(1)}rpm | ` +
      `🎯 pitch:${pitch_angle.toFixed(1)}° | ` +
      `⚡ ${power_w.toFixed(0)}W | ` +
      `🔋 SOC:${batterySOC.toFixed(1)}% | ` +
      `📦 ${energyToday.toFixed(3)} kWh today`,
  );
}
