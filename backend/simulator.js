require('dotenv').config();
const fetch = require('node-fetch');

const API_BASE = `http://localhost:3000`;
let token = null;

// Simulate realistic solar output based on time of day
function getSolarOutput() {
    const hour = new Date().getHours();
    // Solar is 0 at night, peaks at midday
    if (hour < 6 || hour > 19) return 0;
    const peak = Math.sin((hour - 6) * Math.PI / 13);
    const base = peak * 5; // max 5 kWh per array
    return parseFloat((base + (Math.random() - 0.5) * 0.5).toFixed(2));
}

// Simulate realistic wind output
function getWindOutput() {
    // Wind is more random, between 1-4 kWh
    const base = 2.5;
    const fluctuation = (Math.random() - 0.5) * 2;
    return parseFloat(Math.max(0.5, base + fluctuation).toFixed(2));
}

// Login to get token
async function login() {
    try {
        const response = await fetch(`${API_BASE}/api/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email: process.env.SIMULATOR_EMAIL,
                password: process.env.SIMULATOR_PASSWORD
            })
        });
        const result = await response.json();
        if (result.success) {
            token = result.token;
            console.log('Simulator logged in successfully');
        } else {
            console.error('Simulator login failed:', result.message);
        }
    } catch (error) {
        console.error('Simulator login error:', error.message);
    }
}

// Send reading for an inverter
async function sendReading(inverterId, kwh) {
    try {
        await fetch(`${API_BASE}/api/readings`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ inverter_id: inverterId, kwh })
        });
    } catch (error) {
        console.error(`Error sending reading for inverter ${inverterId}:`, error.message);
    }
}

// Run simulation
async function simulate() {
    if (!token) {
        await login();
    }

    const solarA = getSolarOutput();
    const solarB = getSolarOutput();
    const wind1 = getWindOutput();
    const wind2 = getWindOutput();

    console.log(`[${new Date().toLocaleTimeString()}] Solar A: ${solarA} kWh | Solar B: ${solarB} kWh | Wind 1: ${wind1} kWh | Wind 2: ${wind2} kWh`);

    await sendReading(1, solarA); // Solar Array A
    await sendReading(2, solarB); // Solar Array B
    await sendReading(3, wind1);  // Wind Turbine WT-01
    await sendReading(4, wind2);  // Wind Turbine WT-02
}

// Run every 30 seconds
console.log('VoltEquilibrium Inverter Simulator starting...');
simulate();
setInterval(simulate, 30000);