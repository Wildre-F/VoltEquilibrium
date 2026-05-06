# VoltEquilibrium — Green Energy Management Platform

A smart green energy web application for monitoring solar/renewable energy systems, sharing energy in a community, and managing a wallet — powered by real-time IoT data over MQTT and an AI chatbot (Ollama/Gemma).

## Features

- **Live Dashboard** — Real-time speed dials, energy flow diagram, charts for solar and wind
- **Analytics** — Historical power/battery charts, efficiency model, ROI calculator
- **Community Sharing** — Buy, sell, donate, and request energy from neighbours
- **Wallet** — PayFast sandbox integration for top-ups, transaction history
- **AI Chatbot (VoltBot)** — Energy assistant powered by Gemma 3 via Ollama
- **Recommendations** — Appliance shift scheduler, smart power schedule (Eskom vs battery)
- **Battery-Only Users** — Setup with just a battery, receive community energy, simulated load
- **Dark Mode** — Full dark/light theme via CSS variables
- **Debug Console** — Hidden MQTT live stream (8x click logo to reveal)
- **Swagger API Docs** — Interactive API browser at `/api-docs`

## Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed and running
- [Git](https://git-scm.com/downloads)

## Getting Started

### 1. Clone the repository

```bash
git clone <repo-url>
cd MegaProject
```

### 2. Create the environment file

```bash
cp backend/.env.example backend/.env
```

Edit `backend/.env` with your values:

```env
# Required
JWT_SECRET=change-me-to-a-random-string

# Database (must match docker-compose.yaml)
DB_HOST=postgres
DB_PORT=5432
DB_NAME=green_energy
DB_USER=postgres
DB_PASSWORD=postgres

# Frontend URL (for CORS and redirects)
FRONTEND_URL=http://localhost:9090

# MQTT
MQTT_BROKER=mqtt://mqtt:1883

# Email (optional — password reset emails)
EMAIL_USER=
EMAIL_PASS=

# Google OAuth (optional)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

# PayFast Sandbox (optional — wallet top-ups)
PAYFAST_MERCHANT_ID=10000100
PAYFAST_MERCHANT_KEY=46f0cd694581a
PAYFAST_PASSPHRASE=jt7NOE43FZPn
PAYFAST_SANDBOX=true
PAYFAST_RETURN_URL=http://localhost:9090/frontend/Wallet.html?payment=success
PAYFAST_CANCEL_URL=http://localhost:9090/frontend/Wallet.html?payment=cancelled
PAYFAST_NOTIFY_URL=http://localhost:3000/api/wallet/payfast/notify
```

### 3. Start the project

```bash
docker compose up --build
```

This starts four containers:

| Service      | Description              | Local Port |
|--------------|--------------------------|------------|
| **postgres** | PostgreSQL 17 database   | 5432       |
| **mqtt**     | Mosquitto MQTT broker    | 1883 / 9001 (WebSocket) |
| **ollama**   | Ollama AI (Gemma model)  | 11434      |
| **backend**  | Node.js Express API      | 3000       |

The database schema is automatically applied on first run from `backend/schema.sql`.

### 4. Pull the AI model (first time only)

```bash
docker exec green-energy-ollama ollama pull gemma3:1b
```

### 5. Serve the frontend

The frontend is static HTML. Serve it with any HTTP server:

```bash
# Python
python -m http.server 9090

# Node.js
npx serve . -l 9090
```

Then open [http://localhost:9090/frontend/login.html](http://localhost:9090/frontend/login.html).

> Update `FRONTEND_URL` in `.env` if you use a different port.

### 6. Stopping the project

```bash
docker compose down
```

To also delete the database data (fresh start):

```bash
docker compose down -v
```

## Project Structure

```
MegaProject/
├── frontend/                # Static HTML pages
│   ├── Dashboard.html       # Live monitor + energy flow diagram
│   ├── Analytics.html       # Charts, efficiency model, ROI calculator
│   ├── Inverter.html        # Inverter telemetry + guided tour
│   ├── Community_sharing.html # Buy/sell/donate/request energy
│   ├── Recommendations.html # Appliance shift + smart power schedule
│   ├── Wallet.html          # PayFast payments + transactions
│   ├── Notifications.html   # User notifications
│   ├── profile.html         # Profile, achievements, avatar
│   ├── setup.html           # Setup wizard (solar/wind/battery)
│   ├── splash.html          # Login splash screen
│   ├── debug.html           # MQTT debug console (hidden)
│   └── login.html           # Authentication
├── Javascript/
│   ├── config.js            # Shared API URL + auth helpers
│   ├── tailwind-config.js   # Shared Tailwind color config
│   ├── theme.js             # Shared dark/light toggle
│   ├── chatbot.js           # VoltBot AI chatbot widget
│   ├── dashboard.js         # Dashboard logic
│   ├── analytics.js         # Analytics + efficiency + ROI
│   ├── inverter.js          # Inverter page logic
│   ├── community.js         # Community sharing logic
│   ├── recommendations.js   # Appliance shift + power schedule
│   └── login_script.js      # Login/register logic
├── CSS/
│   ├── theme.css            # CSS variables for dark/light mode
│   ├── dashboard.css        # Dashboard-specific styles
│   └── login_style.css      # Login page styles
├── backend/
│   ├── app.js               # Express entry point (473 lines)
│   ├── routes/
│   │   ├── auth.js          # Register, login, OAuth, password reset
│   │   ├── profile.js       # Profile CRUD, avatar, location
│   │   ├── setup.js         # Inverter/battery setup, seed data
│   │   ├── readings.js      # Live readings, history, battery
│   │   ├── analytics.js     # CO2 savings, generation summary
│   │   ├── inverter.js      # Inverter summary, analytics, efficiency
│   │   ├── weather.js       # Current weather + forecast
│   │   ├── wallet.js        # PayFast, withdraw, transactions
│   │   ├── chat.js          # Ollama/Gemma AI chatbot
│   │   ├── community.js     # Donations, sales, requests
│   │   └── notifications.js # User notifications
│   ├── helpers/
│   │   ├── auth.js          # JWT authentication middleware
│   │   ├── constants.js     # Shared constants (tariffs, CO2, PayFast)
│   │   ├── energy.js        # Energy transfer, SOC, area matching
│   │   └── wallet.js        # Wallet helpers
│   ├── simulators/          # IoT device simulators
│   ├── db.js                # PostgreSQL connection pool
│   ├── passport.js          # Google OAuth strategy
│   ├── launcher.js          # Auto-starts simulators on boot
│   ├── schema.sql           # Database schema
│   └── swagger.json         # OpenAPI 3.0 spec
├── mosquitto/config/        # MQTT broker config
└── docker-compose.yaml      # Docker services
```

## API Documentation

Interactive Swagger UI available at: **http://localhost:3000/api-docs**

Covers all 50+ endpoints organized by: Auth, Profile, Setup, Readings, Analytics, Inverter, Weather, Wallet, Chat, Notifications, Community.

## GPU Acceleration (Optional)

The AI chatbot runs on CPU by default. To enable GPU:

1. Install [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)
2. Uncomment the `deploy` block under `ollama` in `docker-compose.yaml`
3. Restart: `docker compose up -d`

## Troubleshooting

- **Port already in use** — Stop any local PostgreSQL, Mosquitto, or Node services using ports 5432, 1883, 3000, or 11434.
- **Backend keeps restarting** — Check `backend/.env` exists and `JWT_SECRET` is set. Run `docker compose logs backend`.
- **Database connection refused** — Make sure `DB_HOST=postgres` in `.env` (not `localhost`).
- **CORS errors** — Make sure `FRONTEND_URL` in `.env` matches your frontend URL.
- **VoltBot not responding** — Run `docker exec green-energy-ollama ollama list` to check if the model is pulled.
- **No solar data** — Simulators start automatically for generator users. Check `docker compose logs backend` for simulator output.
