-- VoltEquilibrium Database Schema
-- Full schema file — run to set up database from scratch
-- Command: type backend\schema.sql | docker exec -i green-energy-postgres psql -U postgres -d green_energy

-- ── Users ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    role VARCHAR(50) DEFAULT 'consumer' CHECK (role IN ('consumer', 'generator')),
    location VARCHAR(255),
    lat DECIMAL(10,6),
    lng DECIMAL(10,6),
    api_key VARCHAR(255) UNIQUE,
    reset_token VARCHAR(255),
    reset_token_expiry TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ── Inverters ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS inverters (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    type VARCHAR(50) NOT NULL CHECK (type IN ('solar', 'wind')),
    capacity DECIMAL(10,2),
    profile VARCHAR(50),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (user_id, type)
);

-- ── Energy readings (per-reading kWh snapshot from simulator) ─────────────────
CREATE TABLE IF NOT EXISTS energy_readings (
    id SERIAL PRIMARY KEY,
    inverter_id INTEGER REFERENCES inverters(id) ON DELETE CASCADE,
    kwh DECIMAL(10,2) NOT NULL,
    recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ── Raw readings (full telemetry from inverter every 30s) ─────────────────────
CREATE TABLE IF NOT EXISTS raw_readings (
    id SERIAL PRIMARY KEY,
    inverter_id INTEGER REFERENCES inverters(id) ON DELETE CASCADE,
    power_w DECIMAL(10,2),
    dc_voltage DECIMAL(8,2),
    dc_current DECIMAL(8,2),
    ac_voltage DECIMAL(8,2),
    ac_current DECIMAL(8,2),
    frequency DECIMAL(6,2),
    temperature DECIMAL(6,2),
    energy_kwh DECIMAL(10,4),
    wind_speed DECIMAL(6,2),
    rotor_rpm DECIMAL(8,2),
    pitch_angle DECIMAL(6,2),
    recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ── Batteries ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS batteries (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(255),
    capacity_kwh DECIMAL(8,2) DEFAULT 10.0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (user_id)
);

-- ── Battery readings ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS battery_readings (
    id SERIAL PRIMARY KEY,
    battery_id INTEGER REFERENCES batteries(id) ON DELETE CASCADE,
    state_of_charge DECIMAL(5,2),
    voltage DECIMAL(8,2),
    current DECIMAL(8,2),
    temperature DECIMAL(6,2),
    power_w DECIMAL(10,2),
    recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ── CO2 savings (daily snapshot per user) ─────────────────────────────────────
-- Each row represents one day's CO2 offset and money saved for a user.
-- This is a pre-calculated summary so the frontend can quickly fetch
-- historical CO2 data without summing thousands of raw readings every time.
--
-- How it works:
--   A background job (or the /api/co2 endpoint on first call) calculates
--   total kWh generated in a day, multiplies by 0.928 to get kg CO2 offset,
--   and multiplies by 2.50 to get Rands saved (Eskom rate).
CREATE TABLE IF NOT EXISTS co2_savings (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    date DATE NOT NULL,
    kwh_generated DECIMAL(10,4) NOT NULL DEFAULT 0,  -- total kWh that day
    co2_kg DECIMAL(10,4) NOT NULL DEFAULT 0,          -- kg CO2 offset (kwh * 0.928)
    rands_saved DECIMAL(10,2) NOT NULL DEFAULT 0,     -- money saved (kwh * 2.50)
    recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (user_id, date)  -- one row per user per day
);

-- ── Analytics daily summary (per inverter per day) ────────────────────────────
-- Pre-aggregated daily stats per inverter so analytics queries are fast.
-- Instead of scanning thousands of raw_readings rows each time the dashboard
-- loads, this table stores the already-calculated totals for each past day.
-- Today's data is always calculated live from raw_readings.
CREATE TABLE IF NOT EXISTS analytics_daily (
    id SERIAL PRIMARY KEY,
    inverter_id INTEGER REFERENCES inverters(id) ON DELETE CASCADE,
    date DATE NOT NULL,
    total_kwh DECIMAL(10,4) NOT NULL DEFAULT 0,   -- total energy generated that day
    peak_power_w DECIMAL(10,2) NOT NULL DEFAULT 0, -- highest watt reading that day
    avg_power_w DECIMAL(10,2) NOT NULL DEFAULT 0,  -- average watt reading that day
    reading_count INTEGER NOT NULL DEFAULT 0,       -- how many raw readings existed
    recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (inverter_id, date)  -- one row per inverter per day
);

-- ── Fix foreign key constraints to use ON DELETE CASCADE ──────────────────────
-- energy_readings
ALTER TABLE energy_readings DROP CONSTRAINT IF EXISTS energy_readings_inverter_id_fkey;
ALTER TABLE energy_readings ADD CONSTRAINT energy_readings_inverter_id_fkey
    FOREIGN KEY (inverter_id) REFERENCES inverters(id) ON DELETE CASCADE;

-- raw_readings
ALTER TABLE raw_readings DROP CONSTRAINT IF EXISTS raw_readings_inverter_id_fkey;
ALTER TABLE raw_readings ADD CONSTRAINT raw_readings_inverter_id_fkey
    FOREIGN KEY (inverter_id) REFERENCES inverters(id) ON DELETE CASCADE;

-- co2_savings
ALTER TABLE co2_savings DROP CONSTRAINT IF EXISTS co2_savings_user_id_fkey;
ALTER TABLE co2_savings ADD CONSTRAINT co2_savings_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- analytics_daily
ALTER TABLE analytics_daily DROP CONSTRAINT IF EXISTS analytics_daily_inverter_id_fkey;
ALTER TABLE analytics_daily ADD CONSTRAINT analytics_daily_inverter_id_fkey
    FOREIGN KEY (inverter_id) REFERENCES inverters(id) ON DELETE CASCADE;

-- ── Add columns to existing tables if missing (safe to re-run) ────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS api_key VARCHAR(255) UNIQUE;
ALTER TABLE inverters ADD COLUMN IF NOT EXISTS profile VARCHAR(50);
ALTER TABLE batteries ALTER COLUMN name DROP NOT NULL;
ALTER TABLE batteries ADD CONSTRAINT IF NOT EXISTS batteries_user_id_unique UNIQUE (user_id);

-- ── Inverter page additions ────────────────────────────────────────────────────
ALTER TABLE inverters ADD COLUMN IF NOT EXISTS serial_number VARCHAR(50);
ALTER TABLE inverters ADD COLUMN IF NOT EXISTS firmware_version VARCHAR(20);
ALTER TABLE raw_readings ADD COLUMN IF NOT EXISTS load_watts   DECIMAL(10,2);
ALTER TABLE raw_readings ADD COLUMN IF NOT EXISTS load_kwh    DECIMAL(10,4);
ALTER TABLE raw_readings ADD COLUMN IF NOT EXISTS grid_watts  DECIMAL(10,2);
ALTER TABLE raw_readings ADD COLUMN IF NOT EXISTS grid_kwh    DECIMAL(10,4);
ALTER TABLE raw_readings ADD COLUMN IF NOT EXISTS cloud_cover DECIMAL(5,2);
ALTER TABLE energy_sales    ADD COLUMN IF NOT EXISTS comment        VARCHAR(500);
ALTER TABLE energy_requests ADD COLUMN IF NOT EXISTS comment        VARCHAR(500);
ALTER TABLE energy_requests ADD COLUMN IF NOT EXISTS donor_comment  VARCHAR(500);

-- ── Wallets ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wallets (
    id         SERIAL PRIMARY KEY,
    user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE UNIQUE,
    balance    DECIMAL(10,2) NOT NULL DEFAULT 1000.00,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS wallet_transactions (
    id               SERIAL PRIMARY KEY,
    user_id          INTEGER REFERENCES users(id) ON DELETE CASCADE,
    type             VARCHAR(30) NOT NULL,
    direction        VARCHAR(10) NOT NULL,
    amount           DECIMAL(10,2) NOT NULL,
    balance_after    DECIMAL(10,2) NOT NULL,
    description      TEXT,
    counter_party_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at       TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ── Community Energy Sharing ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS donations (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    amount_kwh DECIMAL(8,2) NOT NULL CHECK (amount_kwh > 0),
    is_filled BOOLEAN DEFAULT FALSE,
    filled_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS energy_sales (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    amount_kwh DECIMAL(8,2) NOT NULL CHECK (amount_kwh > 0),
    price_per_kwh DECIMAL(8,2) NOT NULL CHECK (price_per_kwh > 0),
    is_filled BOOLEAN DEFAULT FALSE,
    filled_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS energy_requests (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    amount_kwh DECIMAL(8,2) NOT NULL CHECK (amount_kwh > 0),
    is_filled BOOLEAN DEFAULT FALSE,
    filled_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);