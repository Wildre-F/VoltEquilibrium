// Shared energy helper functions for VoltEquilibrium
const pool = require("../db");
const { NO_BATTERY_MAX_PER_REQUEST, NO_BATTERY_MAX_OUTSTANDING } = require("./constants");

async function applyEnergyTransfer(sellerUserId, buyerUserId, amountKwh) {
  const INTERVAL_HOURS = 30 / 3600;

  async function adjustSoc(userId, deltaKwh) {
    const r = await pool.query(
      `SELECT b.id, b.capacity_kwh, br.state_of_charge, br.voltage, br.current, br.temperature, br.power_w
       FROM batteries b
       LEFT JOIN LATERAL (
         SELECT state_of_charge, voltage, current, temperature, power_w
         FROM battery_readings WHERE battery_id = b.id ORDER BY recorded_at DESC LIMIT 1
       ) br ON true
       WHERE b.user_id = $1 LIMIT 1`,
      [userId]
    );
    if (!r.rows[0]) return;
    const { id: battId, capacity_kwh, state_of_charge, voltage, current, temperature, power_w } = r.rows[0];
    const cap    = parseFloat(capacity_kwh) || 10;
    const soc    = parseFloat(state_of_charge) || 0;
    const newSoc = Math.min(100, Math.max(0, soc + (deltaKwh / cap) * 100));
    await pool.query(
      `INSERT INTO battery_readings (battery_id, state_of_charge, voltage, current, temperature, power_w, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [battId, newSoc.toFixed(2), voltage, current, temperature, power_w]
    );
  }

  await adjustSoc(sellerUserId, -amountKwh);
  await adjustSoc(buyerUserId,  +amountKwh);

  const exportWatts = -(amountKwh / INTERVAL_HOURS);
  try {
    const inv = await pool.query(
      `SELECT id FROM inverters WHERE user_id = $1 ORDER BY id LIMIT 1`,
      [sellerUserId]
    );
    if (inv.rows[0]) {
      const invId = inv.rows[0].id;
      await pool.query(
        `INSERT INTO raw_readings
           (inverter_id, power_w, dc_voltage, dc_current, ac_voltage, ac_current,
            frequency, temperature, energy_kwh, load_watts, load_kwh, grid_watts, grid_kwh, recorded_at)
         SELECT inverter_id, power_w, dc_voltage, dc_current, ac_voltage, ac_current,
                frequency, temperature, energy_kwh, load_watts, load_kwh,
                $2,
                COALESCE(grid_kwh, 0) + $3,
                NOW()
         FROM raw_readings WHERE inverter_id = $1 ORDER BY recorded_at DESC LIMIT 1`,
        [invId, exportWatts, amountKwh]
      );
    }
  } catch (err) {
    console.error("[transfer] grid reading insert:", err.message);
  }
}

function isSameArea(user1, user2) {
  if (!user1.location || !user2.location) return false;
  const loc1 = user1.location.trim().toLowerCase();
  const loc2 = user2.location.trim().toLowerCase();
  if (loc1 === loc2) return true;
  const words1 = loc1.split(/[,\s]+/).filter(w => w.length > 3);
  const words2 = loc2.split(/[,\s]+/).filter(w => w.length > 3);
  if (words1.some(w => words2.includes(w))) return true;
  if (user1.lat != null && user2.lat != null && user1.lng != null && user2.lng != null) {
    const dlat = Math.abs(parseFloat(user1.lat) - parseFloat(user2.lat));
    const dlng = Math.abs(parseFloat(user1.lng) - parseFloat(user2.lng));
    if (dlat < 0.45 && dlng < 0.45) return true;
  }
  return false;
}

async function getUserSoc(userId) {
  const result = await pool.query(
    `SELECT br.state_of_charge
     FROM batteries b
     JOIN battery_readings br ON br.battery_id = b.id
     WHERE b.user_id = $1
     ORDER BY br.recorded_at DESC LIMIT 1`,
    [userId]
  );
  return result.rows[0]?.state_of_charge ?? null;
}

async function getUserShareableKwh(userId) {
  const battResult = await pool.query(
    `SELECT b.capacity_kwh, br.state_of_charge
     FROM batteries b
     LEFT JOIN LATERAL (
       SELECT state_of_charge FROM battery_readings
       WHERE battery_id = b.id ORDER BY recorded_at DESC LIMIT 1
     ) br ON true
     WHERE b.user_id = $1 LIMIT 1`,
    [userId]
  );
  if (!battResult.rows[0]) return null;
  const { capacity_kwh, state_of_charge } = battResult.rows[0];
  const soc         = parseFloat(state_of_charge) || 0;
  const capacityKwh = parseFloat(capacity_kwh)    || 10;
  const storedKwh   = capacityKwh * (soc / 100);
  const listedResult = await pool.query(
    `SELECT COALESCE(SUM(amount_kwh), 0) AS total
     FROM energy_sales WHERE user_id = $1 AND is_filled = FALSE`,
    [userId]
  );
  const alreadyListed = parseFloat(listedResult.rows[0].total) || 0;
  return { soc, capacityKwh, availableKwh: Math.max(0, storedKwh - alreadyListed) };
}

async function getUserRequestableKwh(userId) {
  const battResult = await pool.query(
    `SELECT b.capacity_kwh, br.state_of_charge
     FROM batteries b
     LEFT JOIN LATERAL (
       SELECT state_of_charge FROM battery_readings
       WHERE battery_id = b.id ORDER BY recorded_at DESC LIMIT 1
     ) br ON true
     WHERE b.user_id = $1 LIMIT 1`,
    [userId]
  );
  if (!battResult.rows[0]) {
    const reqResult = await pool.query(
      `SELECT COALESCE(SUM(amount_kwh), 0) AS total
       FROM energy_requests WHERE user_id = $1 AND is_filled = FALSE`,
      [userId]
    );
    const alreadyRequested = parseFloat(reqResult.rows[0].total) || 0;
    return { noBattery: true, remaining: Math.max(0, NO_BATTERY_MAX_OUTSTANDING - alreadyRequested) };
  }
  const { capacity_kwh, state_of_charge } = battResult.rows[0];
  const soc         = parseFloat(state_of_charge) || 0;
  const capacityKwh = parseFloat(capacity_kwh)    || 10;
  const emptyKwh    = capacityKwh * ((100 - soc) / 100);
  const reqResult = await pool.query(
    `SELECT COALESCE(SUM(amount_kwh), 0) AS total
     FROM energy_requests WHERE user_id = $1 AND is_filled = FALSE`,
    [userId]
  );
  const alreadyRequested = parseFloat(reqResult.rows[0].total) || 0;
  return Math.max(0, emptyKwh - alreadyRequested);
}

async function getUserLocation(userId) {
  const result = await pool.query(
    "SELECT location, lat, lng FROM users WHERE id = $1",
    [userId]
  );
  return result.rows[0] || {};
}

module.exports = {
  applyEnergyTransfer,
  isSameArea,
  getUserSoc,
  getUserShareableKwh,
  getUserRequestableKwh,
  getUserLocation,
};
