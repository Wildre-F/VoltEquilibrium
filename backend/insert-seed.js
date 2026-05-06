#!/usr/bin/env node
const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");

const pool = new Pool({
  host: "localhost",
  port: 5432,
  database: "green_energy",
  user: "postgres",
  password: "postgres",
});

const INVERTER_ID = parseInt(process.argv[2]) || 1;
const BATTERY_ID  = parseInt(process.argv[3]) || 1;

async function run() {
  const file = path.join(__dirname, "seed-solar-large.json");
  const seed = JSON.parse(fs.readFileSync(file, "utf8"));
  console.log(`Inserting ${seed.rawReadings.length} raw + ${seed.batteryReadings.length} battery readings...`);
  console.log(`Inverter ID: ${INVERTER_ID}, Battery ID: ${BATTERY_ID}`);

  const BATCH = 500;

  // Raw readings
  for (let i = 0; i < seed.rawReadings.length; i += BATCH) {
    const batch = seed.rawReadings.slice(i, i + BATCH);
    const values = [];
    const params = [];
    let p = 1;
    for (const r of batch) {
      values.push(`($${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++})`);
      params.push(INVERTER_ID, r.power_w, r.dc_voltage, r.dc_current, r.ac_voltage,
        r.ac_current, r.frequency, r.temperature, r.energy_kwh, r.load_watts,
        r.grid_watts, r.cloud_cover, r.wind_speed || 0, r.recorded_at, 0);
    }
    await pool.query(
      `INSERT INTO raw_readings (inverter_id, power_w, dc_voltage, dc_current, ac_voltage,
        ac_current, frequency, temperature, energy_kwh, load_watts,
        grid_watts, cloud_cover, wind_speed, recorded_at, load_kwh)
       VALUES ${values.join(",")}`,
      params
    );
    if (i % 5000 === 0) process.stdout.write(`  raw: ${i}/${seed.rawReadings.length}\r`);
  }
  console.log(`  raw: ${seed.rawReadings.length}/${seed.rawReadings.length} done`);

  // Battery readings
  for (let i = 0; i < seed.batteryReadings.length; i += BATCH) {
    const batch = seed.batteryReadings.slice(i, i + BATCH);
    const values = [];
    const params = [];
    let p = 1;
    for (const r of batch) {
      values.push(`($${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++})`);
      params.push(BATTERY_ID, r.state_of_charge, r.voltage, r.current, r.temperature, r.power_w, r.recorded_at);
    }
    await pool.query(
      `INSERT INTO battery_readings (battery_id, state_of_charge, voltage, current, temperature, power_w, recorded_at)
       VALUES ${values.join(",")}`,
      params
    );
    if (i % 5000 === 0) process.stdout.write(`  battery: ${i}/${seed.batteryReadings.length}\r`);
  }
  console.log(`  battery: ${seed.batteryReadings.length}/${seed.batteryReadings.length} done`);

  console.log("Seeding complete!");
  await pool.end();
}

run().catch(err => { console.error(err); process.exit(1); });
