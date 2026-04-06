-- VoltEquilibrium Database Schema
-- Run this file to set up the database from scratch
-- Command: docker exec -it green-energy-postgres psql -U postgres -d green_energy -f /app/schema.sql

-- Users table
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    role VARCHAR(50) DEFAULT 'consumer' CHECK (role IN ('consumer', 'generator')),
    location VARCHAR(255),
    lat DECIMAL(10,6),
    lng DECIMAL(10,6),
    reset_token VARCHAR(255),
    reset_token_expiry TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Inverter
CREATE TABLE IF NOT EXISTS inverters (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    name VARCHAR(255) NOT NULL,
    type VARCHAR(50) NOT NULL CHECK (type IN ('solar', 'wind')),
    capacity DECIMAL(10,2),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (user_id, type)
);

-- Energy readings table
CREATE TABLE IF NOT EXISTS energy_readings (
    id SERIAL PRIMARY KEY,
    inverter_id INTEGER REFERENCES inverters(id),
    kwh DECIMAL(10,2) NOT NULL,
    recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Seed inverters (only if table is empty)
INSERT INTO inverters (name, type, location)
SELECT * FROM (VALUES
    ('Solar Array A', 'solar', 'North'),
    ('Solar Array B', 'solar', 'South'),
    ('Wind Turbine WT-01', 'wind', 'East'),
    ('Wind Turbine WT-02', 'wind', 'West')
) AS data(name, type, location)
WHERE NOT EXISTS (SELECT 1 FROM inverters);