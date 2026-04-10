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

-- ── Energy readings (daily kWh summary) ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS energy_readings (
    id SERIAL PRIMARY KEY,
    inverter_id INTEGER REFERENCES inverters(id) ON DELETE CASCADE,
    kwh DECIMAL(10,2) NOT NULL,
    recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ── Raw readings (full telemetry from inverter) ───────────────────────────────
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

-- ── Fix foreign key constraints to use ON DELETE CASCADE ──────────────────────
-- energy_readings
ALTER TABLE energy_readings DROP CONSTRAINT IF EXISTS energy_readings_inverter_id_fkey;
ALTER TABLE energy_readings ADD CONSTRAINT energy_readings_inverter_id_fkey
    FOREIGN KEY (inverter_id) REFERENCES inverters(id) ON DELETE CASCADE;

-- raw_readings
ALTER TABLE raw_readings DROP CONSTRAINT IF EXISTS raw_readings_inverter_id_fkey;
ALTER TABLE raw_readings ADD CONSTRAINT raw_readings_inverter_id_fkey
    FOREIGN KEY (inverter_id) REFERENCES inverters(id) ON DELETE CASCADE;

-- ── Add columns to existing tables if missing (safe to re-run) ────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS api_key VARCHAR(255) UNIQUE;
ALTER TABLE inverters ADD COLUMN IF NOT EXISTS profile VARCHAR(50);
ALTER TABLE batteries ALTER COLUMN name DROP NOT NULL;
ALTER TABLE batteries ADD CONSTRAINT IF NOT EXISTS batteries_user_id_unique UNIQUE (user_id);