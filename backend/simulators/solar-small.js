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
    "[solar-small] Missing SIM_API_KEY, SIM_LAT or SIM_LNG in environment.",
  );
  process.exit(1);
}

// ── MQTT ──────────────────────────────────────────────────────────────────────
const client = mqtt.connect(MQTT_BROKER);
const TOPIC_SOLAR = `voltequilibrium/${API_KEY}/${DEVICE_ID}/solar`;
const TOPIC_BATTERY = `voltequilibrium/${API_KEY}/${DEVICE_ID}/battery`;

client.on("connect", () => {
  console.log(`[solar-small] Connected to MQTT broker → ${MQTT_BROKER}`);
  console.log(`[solar-small] Publishing to ${TOPIC_SOLAR}`);
  // Run immediately, then on interval
  runSimulation();
  setInterval(runSimulation, INTERVAL_MS);
});

client.on("error", (err) => {
  console.error("[solar-small] MQTT error:", err.message);
});

// ── Weather ───────────────────────────────────────────────────────────────────
let cachedWeather = null;
let weatherFetchedAt = 0;
const WEATHER_TTL_MS = 10 * 60 * 1000; // re-fetch every 10 minutes

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
      `[solar-small] Weather → cloud: ${cachedWeather.cloudCover}% | wind: ${cachedWeather.windSpeed} m/s | temp: ${cachedWeather.temperature}°C`,
    );
  } catch (err) {
    console.warn(
      "[solar-small] Weather fetch failed, using defaults:",
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
// Small household: 1–3 kW peak capacity
const PEAK_POWER_W = 3000; // watts at perfect midday, clear sky
const PANEL_VOLTAGE = 36; // typical panel Voc (volts)
const BATTERY_CAP_WH = 5000; // 5 kWh battery for small household

let batterySOC = 60; // start at 60 % state of charge
let energyToday = 0; // kWh accumulated today
let lastHour = new Date().getHours();

function getSolarMultiplier(hour) {
  // Bell curve: 0 before sunrise (6), peaks at 13:00, 0 after sunset (19)
  if (hour < 6 || hour > 19) return 0;
  return Math.sin(((hour - 6) * Math.PI) / 13);
}

function jitter(value, pct = 0.05) {
  // Add ±pct random noise to simulate real-world fluctuation
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

  // ── Solar power calculation ───────────────────────────────────────────────
  const timeMultiplier = getSolarMultiplier(hour);
  // Cloud cover reduces output: 0% cloud = full, 100% cloud = 20% remaining
  const cloudMultiplier = 1 - (weather.cloudCover / 100) * 0.8;
  // Temperature coefficient: panels lose ~0.4% efficiency per °C above 25°C
  const tempMultiplier = 1 - Math.max(0, (weather.temperature - 25) * 0.004);

  const rawPower =
    PEAK_POWER_W * timeMultiplier * cloudMultiplier * tempMultiplier;
  const power_w = Math.max(0, jitter(rawPower, 0.06));

  // DC side (panels → inverter input)
  const dc_current = power_w > 0 ? jitter(power_w / PANEL_VOLTAGE, 0.03) : 0;
  const dc_voltage = power_w > 0 ? jitter(PANEL_VOLTAGE, 0.02) : 0;

  // AC side (inverter output) — ~96% efficiency
  const ac_voltage = power_w > 0 ? jitter(230, 0.01) : 0; // SA mains 230V
  const ac_current = power_w > 0 ? jitter((power_w * 0.96) / 230, 0.03) : 0;
  const frequency = power_w > 0 ? jitter(50, 0.005) : 0; // SA grid 50Hz
  const inverter_temp = jitter(
    weather.temperature + (power_w / PEAK_POWER_W) * 15,
    0.02,
  );

  // Energy accumulated (kWh) — add slice for this 30-second interval
  const intervalHours = INTERVAL_MS / 1000 / 3600;
  energyToday += (power_w / 1000) * intervalHours;

  // ── Battery simulation ────────────────────────────────────────────────────
  // Solar charges battery; at night battery slowly discharges (house load ~300W)
  const HOUSE_LOAD_W = 300;
  const netPower = power_w - HOUSE_LOAD_W; // + = charging, - = discharging
  const socDelta = ((netPower * intervalHours) / (BATTERY_CAP_WH / 1000)) * 100;
  batterySOC = Math.min(100, Math.max(0, batterySOC + socDelta));

  const battery_voltage = 48 + (batterySOC / 100) * 6; // 48–54V typical LiFePO4
  const battery_current = netPower / battery_voltage; // + charging, - discharging
  const battery_power = netPower;
  const battery_temp = jitter(weather.temperature + 3, 0.02);

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
    // Solar-specific (null for solar — only used by wind scripts)
    wind_speed: null,
    rotor_rpm: null,
    pitch_angle: null,
    // Metadata
    profile: "solar-small",
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
    `[solar-small] ${now.toLocaleTimeString()} | ` +
      `☀️  ${power_w.toFixed(0)}W | ` +
      `🌥  cloud:${weather.cloudCover}% | ` +
      `🔋 SOC:${batterySOC.toFixed(1)}% | ` +
      `⚡ ${energyToday.toFixed(3)} kWh today`,
  );
}
