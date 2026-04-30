#!/usr/bin/env node
/**
 * Transforms the real solar SQL dump into a seed JSON file for demo purposes.
 * - Scales PV watts down to fit a 10 kW system
 * - Samples to one reading per 5 minutes
 * - Shifts dates so the data ends yesterday
 * - Outputs backend/seed-solar-large.json
 */

const fs = require("fs");
const path = require("path");

const INPUT  = path.resolve(__dirname, "../../DB scripts/total_minute_values_dump_100.sql");
const OUTPUT = path.resolve(__dirname, "seed-solar-large.json");

const SCALE_FACTOR = 3.5; // divide PV watts by this to get ~10kW max
const SAMPLE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

const raw = fs.readFileSync(INPUT, "utf8");
const lines = raw.split("\n");

// Parse data lines (skip headers, stop at \.)
const readings = [];
let inData = false;

for (const line of lines) {
  if (line.startsWith("COPY public.total_minute_values")) {
    inData = true;
    continue;
  }
  if (line.startsWith("\\.")) break;
  if (!inData) continue;

  const cols = line.split("\t");
  if (cols.length < 20) continue;

  readings.push({
    timestamp:   cols[0],
    load_watts:  parseFloat(cols[2]) || 0,
    pv_watts:    parseFloat(cols[3]) || 0,
    grid_watts:  parseFloat(cols[5]) || 0,
    grid_freq:   parseFloat(cols[6]) || 0,
    grid_volts:  parseFloat(cols[7]) || 0,
    inv_volts:   parseFloat(cols[9]) || 0,
    inv_freq:    parseFloat(cols[10]) || 0,
    inv_amps:    parseFloat(cols[11]) || 0,
    inv_temp:    parseFloat(cols[12]) || 0,
    pv_volts:    parseFloat(cols[13]) || 0,
    pv_amps:     parseFloat(cols[14]) || 0,
    batt_volts:  parseFloat(cols[15]) || 0,
    batt_amps:   parseFloat(cols[16]) || 0,
    batt_watts:  parseFloat(cols[17]) || 0,
    batt_soc:    parseFloat(cols[18]) || 0,
  });
}

console.log(`Parsed ${readings.length} readings`);

// Sample every 5 minutes
const sampled = [];
let lastTs = 0;
for (const r of readings) {
  const ts = new Date(r.timestamp).getTime();
  if (ts - lastTs >= SAMPLE_INTERVAL_MS) {
    sampled.push(r);
    lastTs = ts;
  }
}
console.log(`Sampled to ${sampled.length} readings (every 5 min)`);

// Calculate date shift: make the last reading = yesterday 18:00
const lastOriginal = new Date(sampled[sampled.length - 1].timestamp).getTime();
const yesterday6pm = new Date();
yesterday6pm.setDate(yesterday6pm.getDate() - 1);
yesterday6pm.setHours(18, 0, 0, 0);
const dateShift = yesterday6pm.getTime() - lastOriginal;

// Transform readings
const rawReadings = [];
const batteryReadings = [];
let dailyKwh = 0;
let lastDay = null;

for (const r of sampled) {
  const newTs = new Date(new Date(r.timestamp).getTime() + dateShift).toISOString();
  const day = newTs.slice(0, 10);

  // Reset daily kWh counter on new day
  if (day !== lastDay) {
    dailyKwh = 0;
    lastDay = day;
  }

  // Scale PV watts down
  const scaledPvW = +(r.pv_watts / SCALE_FACTOR).toFixed(1);
  const scaledLoadW = +(r.load_watts / SCALE_FACTOR).toFixed(1);
  const scaledGridW = +(r.grid_watts / SCALE_FACTOR).toFixed(1);

  // Accumulate kWh (5 min intervals = 5/60 hours)
  dailyKwh += (scaledPvW / 1000) * (5 / 60);

  // DC values from PV
  const dcVoltage = r.pv_volts > 0 ? +(r.pv_volts / (SCALE_FACTOR / 1.5)).toFixed(1) : 0;
  const dcCurrent = scaledPvW > 0 && dcVoltage > 0 ? +(scaledPvW / dcVoltage).toFixed(2) : 0;

  rawReadings.push({
    power_w:     scaledPvW,
    dc_voltage:  dcVoltage,
    dc_current:  dcCurrent,
    ac_voltage:  +(r.inv_volts).toFixed(1),
    ac_current:  +(r.inv_amps / SCALE_FACTOR).toFixed(2),
    frequency:   +(r.inv_freq || 50).toFixed(2),
    temperature: +(r.inv_temp || (20 + Math.random() * 15)).toFixed(1),
    energy_kwh:  +dailyKwh.toFixed(4),
    load_watts:  scaledLoadW,
    load_kwh:    0,
    grid_watts:  scaledGridW,
    grid_kwh:    0,
    cloud_cover: scaledPvW > 0 ? +(Math.random() * 40).toFixed(0) : 0,
    wind_speed:  0,
    recorded_at: newTs,
  });

  // Battery readings — scale voltage to 48-54V range (LiFePO4)
  const battVolts = 48 + (r.batt_soc / 100) * 6; // 48V empty, 54V full
  const battAmps = +(r.batt_amps / SCALE_FACTOR).toFixed(2);
  batteryReadings.push({
    state_of_charge: +r.batt_soc.toFixed(1),
    voltage:         +battVolts.toFixed(2),
    current:         battAmps,
    temperature:     +(25 + Math.random() * 10).toFixed(1),
    power_w:         +(battAmps * battVolts).toFixed(1),
    recorded_at:     newTs,
  });
}

const seed = { rawReadings, batteryReadings };
fs.writeFileSync(OUTPUT, JSON.stringify(seed));

const sizeMB = (fs.statSync(OUTPUT).size / 1024 / 1024).toFixed(1);
console.log(`Written ${OUTPUT}`);
console.log(`  ${rawReadings.length} raw readings`);
console.log(`  ${batteryReadings.length} battery readings`);
console.log(`  File size: ${sizeMB} MB`);
console.log(`  Date range: ${rawReadings[0].recorded_at} → ${rawReadings[rawReadings.length - 1].recorded_at}`);
