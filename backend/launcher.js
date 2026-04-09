/**
 * VoltEquilibrium — Simulator Launcher
 * ─────────────────────────────────────────────────────────────────────────────
 * This script is started once by app.js on backend boot.
 *
 * What it does:
 *  1. Queries the database for every user who has inverters (role = 'generator')
 *  2. For each inverter, spawns the matching simulator script as a child process,
 *     passing the user's API key, lat, and lng as environment variables
 *  3. Keeps a registry of running processes so it never double-starts one
 *  4. Auto-restarts a simulator if it crashes unexpectedly
 *  5. Exports startSimulator() and stopSimulator() so app.js can trigger them
 *     immediately when a user completes setup (without a server restart)
 *
 * Child process concept:
 *   Node.js can spawn other scripts as separate OS processes using child_process.
 *   Each simulator runs independently — if one crashes, it doesn't affect others.
 *   We use spawn() (not exec/fork) because simulators run indefinitely.
 */

const { spawn } = require("child_process");
const path = require("path");
const pool = require("./db");

// ── Process registry ──────────────────────────────────────────────────────────
// Maps a unique key → the running child process.
// Key format: "{apiKey}:{profile}"  e.g. "VE-abc123:solar-small"
// This prevents starting two copies of the same simulator for the same user.
const running = new Map();

// ── Script paths ──────────────────────────────────────────────────────────────
// Maps a profile name (stored in the inverters table) to the simulator file.
const SIMULATOR_SCRIPTS = {
  "solar-small": path.join(__dirname, "simulators", "solar-small.js"),
  "solar-large": path.join(__dirname, "simulators", "solar-large.js"),
  "wind-small": path.join(__dirname, "simulators", "wind-small.js"),
  "wind-large": path.join(__dirname, "simulators", "wind-large.js"),
};

// ── Start a single simulator ──────────────────────────────────────────────────
/**
 * Spawns the simulator for a given inverter.
 *
 * @param {object} opts
 * @param {string} opts.apiKey   - The user's VE-xxxx API key
 * @param {string} opts.profile  - e.g. "solar-small"
 * @param {number} opts.lat      - Latitude for weather lookups
 * @param {number} opts.lng      - Longitude for weather lookups
 * @param {string} opts.token    - A valid JWT so the simulator can call /api/weather
 * @param {number} opts.deviceId - The inverter's DB id so the simulator can fetch config
 */
function startSimulator({ apiKey, profile, lat, lng, token, deviceId }) {
  const key = `${apiKey}:${profile}`;

  // Don't start if already running
  if (running.has(key)) {
    console.log(`[launcher] Already running: ${key}`);
    return;
  }

  const scriptPath = SIMULATOR_SCRIPTS[profile];
  if (!scriptPath) {
    console.warn(`[launcher] Unknown profile "${profile}" — no script mapped.`);
    return;
  }

  console.log(`[launcher] Starting ${profile} for API key ${apiKey}`);

  // spawn() takes: the command, its arguments, and options.
  // We pass "node" as the command and the script path as the argument.
  // The env option merges our custom variables into the existing environment
  // (process.env) so Node.js itself still works correctly.
  const child = spawn("node", [scriptPath], {
    env: {
      ...process.env, // inherit PATH, NODE_PATH, etc.
      SIM_API_KEY: apiKey,
      SIM_DEVICE_ID: String(deviceId),
      SIM_LAT: String(lat),
      SIM_LNG: String(lng),
      SIM_TOKEN: token || "",
      MQTT_BROKER: process.env.MQTT_BROKER || "mqtt://mqtt:1883",
    },
    // "pipe" means we capture stdout/stderr ourselves (so we can prefix log lines)
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Forward simulator stdout to our main process log with a prefix
  child.stdout.on("data", (data) => {
    process.stdout.write(`[sim:${profile}] ${data}`);
  });

  child.stderr.on("data", (data) => {
    process.stderr.write(`[sim:${profile}:ERR] ${data}`);
  });

  // Auto-restart on unexpected exit
  child.on("close", (code) => {
    running.delete(key);

    // code === 0 means clean shutdown (we called stopSimulator),
    // any other code means the process crashed → restart after a short delay.
    if (code !== 0 && code !== null) {
      console.warn(
        `[launcher] ${profile} exited with code ${code}. Restarting in 5s...`,
      );
      setTimeout(
        () => startSimulator({ apiKey, profile, lat, lng, token, deviceId }),
        5000,
      );
    } else {
      console.log(`[launcher] ${profile} for ${apiKey} stopped cleanly.`);
    }
  });

  child.on("error", (err) => {
    console.error(`[launcher] Failed to spawn ${profile}:`, err.message);
    running.delete(key);
  });

  running.set(key, child);
}

// ── Stop a single simulator ───────────────────────────────────────────────────
/**
 * Gracefully stops a running simulator.
 * Called when a user deletes their inverter or account.
 *
 * @param {string} apiKey
 * @param {string} profile
 */
function stopSimulator(apiKey, profile) {
  const key = `${apiKey}:${profile}`;
  const child = running.get(key);

  if (!child) {
    console.log(`[launcher] No running process for ${key}`);
    return;
  }

  console.log(`[launcher] Stopping ${key}`);
  // SIGTERM asks the process to shut down cleanly.
  // The "close" handler above will fire with code null, so no restart happens.
  child.kill("SIGTERM");
  running.delete(key);
}

// ── Stop all simulators for a user ───────────────────────────────────────────
/**
 * Stops every simulator belonging to a given API key.
 * Useful when a user deletes their account.
 *
 * @param {string} apiKey
 */
function stopAllForUser(apiKey) {
  for (const [key, child] of running.entries()) {
    if (key.startsWith(`${apiKey}:`)) {
      console.log(`[launcher] Stopping ${key} (user cleanup)`);
      child.kill("SIGTERM");
      running.delete(key);
    }
  }
}

// ── Boot: start simulators for all existing generator users ──────────────────
/**
 * Called once on app.js startup.
 * Queries the DB for all users with inverters and starts their simulators.
 *
 * We need a token so simulators can call /api/weather. We generate a
 * long-lived internal token using the same JWT_SECRET as the rest of the app.
 */
async function startAllSimulators() {
  console.log("[launcher] Booting — querying DB for generator users...");

  // Retry up to 10 times with a 3-second gap.
  // This handles the race condition where the backend starts before
  // PostgreSQL has finished initialising and applying the schema.
  const MAX_RETRIES = 10;
  const RETRY_DELAY_MS = 3000;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await pool.query(`
        SELECT
          u.api_key,
          u.lat,
          u.lng,
          i.profile,
          i.type,
          i.id as device_id
        FROM users u
        JOIN inverters i ON i.user_id = u.id
        WHERE u.api_key IS NOT NULL
          AND u.lat IS NOT NULL
          AND u.lng IS NOT NULL
          AND i.profile IS NOT NULL
      `);

      if (result.rows.length === 0) {
        console.log("[launcher] No generator users found — nothing to start.");
        return;
      }

      const jwt = require("jsonwebtoken");
      const INTERNAL_TOKEN = jwt.sign(
        { id: 0, role: "internal", purpose: "simulator-weather" },
        process.env.JWT_SECRET || "mysecretkey",
        { expiresIn: "30d" },
      );

      for (const row of result.rows) {
        startSimulator({
          apiKey: row.api_key,
          profile: row.profile,
          lat: row.lat,
          lng: row.lng,
          token: INTERNAL_TOKEN,
          deviceId: row.device_id,
        });
      }

      console.log(`[launcher] Started ${result.rows.length} simulator(s).`);
      return; // success — exit the retry loop
    } catch (err) {
      console.warn(
        `[launcher] DB not ready (attempt ${attempt}/${MAX_RETRIES}): ${err.message}`,
      );
      if (attempt < MAX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      } else {
        console.error("[launcher] Giving up after max retries.");
      }
    }
  }
}

// ── Exports ───────────────────────────────────────────────────────────────────
module.exports = {
  startAllSimulators, // call on app.js boot
  startSimulator, // call when a user adds an inverter
  stopSimulator, // call when a user removes an inverter
  stopAllForUser, // call when a user deletes their account
};
