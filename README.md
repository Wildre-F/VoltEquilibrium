<div align="center">

<img src="https://readme-typing-svg.demolab.com?font=Fira+Code&weight=600&size=26&pause=1000&color=1d9e75&center=true&vCenter=true&width=700&lines=VoltEquilibrium;Smart+Green+Energy+Management;IoT+%2B+Community+Power+Sharing" alt="Typing SVG" />

![Status](https://img.shields.io/badge/status-Active-1d9e75?style=flat-square)
![Platform](https://img.shields.io/badge/platform-Web-1d9e75?style=flat-square)
![License](https://img.shields.io/badge/license-MIT-7f77dd?style=flat-square)

</div>

---

## About

**VoltEquilibrium** is a smart green energy management web application that connects users to their renewable energy IoT devices via MQTT. The platform provides real-time energy analytics, AI-assisted power predictions using live weather data, community energy sharing, and a revolutionary **Power Share** feature that allows users to send excess energy across the grid to their community.

This is an **international collaborative project** developed in partnership with a university from Belgium.

---

## Built with

<div align="center">
  <img src="https://skillicons.dev/icons?i=nodejs,express,docker,postgres,js,html,css,tailwind,npm,postman" />
</div>

**Additional Services**
- [Open-Meteo Weather API](https://open-meteo.com/) — free weather forecasting and solar irradiance for power predictions
- MQTT (Eclipse Mosquitto) — IoT device communication protocol
- Ollama + Gemma 3 — Local AI chatbot for energy assistance
- PayFast Sandbox — Payment integration for wallet top-ups
- REST API & Fetch API — data communication layer

---

## Features

| Feature | Description | Status |
|---|---|---|
| **IoT Device Connect** | Connect solar/wind devices via MQTT with live simulators | Done |
| **Energy Dashboard** | Real-time dials, energy flow diagram, charts, weather widget | Done |
| **Analytics** | Historical charts, efficiency model, ROI calculator | Done |
| **7-Day Forecast** | Physics-based generation prediction using solar irradiance (GHI) | Done |
| **Efficiency Insights** | Panel health monitoring, maintenance alerts, savings lost | Done |
| **AI Chatbot (VoltBot)** | Energy assistant powered by Gemma 3 via Ollama (GPU accelerated) | Done |
| **Power Share** | Buy, sell, donate, and request energy from your community | Done |
| **Wallet** | PayFast sandbox payments, transaction history | Done |
| **Recommendations** | Appliance shift scheduler, maintenance health scorecard | Done |
| **Battery-Only Users** | Setup with just a battery, receive community energy | Done |
| **Dark Mode** | Full dark/light theme via CSS variables across all pages | Done |
| **Debug Console** | Hidden live MQTT data stream (8x click logo) | Done |
| **Swagger Docs** | Interactive API documentation at `/api-docs` | Done |
| **Carbon to Action** | CO2 savings converted to real-world equivalents | Coming Soon |

---

## System Architecture

```
IoT Devices / Simulators (MQTT)
      |
      v
 Eclipse Mosquitto Broker
      |
      v
 Node.js / Express Backend --- Ollama (Gemma 3 AI)
      |
      |---- PostgreSQL 17 Database
      |
      |---- Open-Meteo Weather + Solar Irradiance API
      |
      |---- PayFast Sandbox (Payments)
      |
      +---- Frontend (HTML, CSS, Tailwind, Chart.js)
                  |
                  +---- Dashboard, Analytics, Community, Recommendations
```

---

## Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed and running
- [Git](https://git-scm.com/downloads)

## Getting Started

### 1. Clone the repo

```bash
git clone https://github.com/Wildre-F/VoltEquilibrium.git
cd VoltEquilibrium
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

# Email (optional)
EMAIL_USER=
EMAIL_PASS=

# Google OAuth (optional)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

# PayFast Sandbox (optional)
PAYFAST_MERCHANT_ID=10000100
PAYFAST_MERCHANT_KEY=46f0cd694581a
PAYFAST_PASSPHRASE=jt7NOE43FZPn
PAYFAST_SANDBOX=true
```

### 3. Start the project

```bash
docker compose up --build
```

This starts four containers:

| Service | Description | Port |
|---|---|---|
| **postgres** | PostgreSQL 17 database | 5432 |
| **mqtt** | Mosquitto MQTT broker | 1883 / 9001 |
| **ollama** | Ollama AI (Gemma model) | 11434 |
| **backend** | Node.js Express API | 3000 |

### 4. Pull the AI model (first time only)

```bash
docker exec green-energy-ollama ollama pull gemma3:1b
```

### 5. Serve the frontend

```bash
python -m http.server 9090
# or
npx serve . -l 9090
```

Then open [http://localhost:9090/frontend/login.html](http://localhost:9090/frontend/login.html)

### 6. Stopping

```bash
docker compose down        # keep data
docker compose down -v     # reset everything
```

---

## Project Structure

```
VoltEquilibrium/
├── frontend/                # Static HTML pages (16 pages)
├── Javascript/
│   ├── config.js            # Shared API URL + auth helpers
│   ├── tailwind-config.js   # Shared Tailwind color config
│   ├── theme.js             # Dark/light toggle + loading screen
│   ├── chatbot.js           # VoltBot AI widget
│   ├── dashboard.js         # Dashboard logic
│   ├── analytics.js         # Analytics + efficiency + ROI + forecast
│   ├── inverter.js          # Inverter telemetry
│   ├── community.js         # Community sharing
│   └── recommendations.js   # Appliance shift + maintenance health
├── CSS/
│   ├── theme.css            # CSS variables for dark/light mode
│   └── dashboard.css        # Dashboard-specific styles
├── backend/
│   ├── app.js               # Express entry point (slim, 473 lines)
│   ├── routes/              # 11 route modules
│   ├── helpers/             # Shared constants, auth, energy, wallet
│   ├── simulators/          # Solar + wind IoT simulators
│   ├── schema.sql           # Database schema
│   └── swagger.json         # OpenAPI 3.0 spec
├── mosquitto/               # MQTT broker config
└── docker-compose.yaml
```

## API Documentation

Interactive Swagger UI: **http://localhost:3000/api-docs**

50+ endpoints: Auth, Profile, Setup, Readings, Analytics, Inverter, Weather, Forecast, Wallet, Chat, Notifications, Community.

## GPU Acceleration (Optional)

The AI chatbot runs on CPU by default. To enable GPU:

1. Install [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)
2. Uncomment the `deploy` block under `ollama` in `docker-compose.yaml`
3. Restart: `docker compose up -d`

---

## International Collaboration

This project is being developed in collaboration with a **university partner from Belgium**, bringing together students across borders to build real-world green energy solutions.

---

## Roadmap

- [x] Project setup and architecture planning
- [x] MQTT IoT device integration + simulators
- [x] Energy analytics dashboard with live dials
- [x] Weather API power prediction engine (GHI-based)
- [x] 7-day generation forecast
- [x] Community energy sharing (buy/sell/donate/request)
- [x] AI chatbot (Ollama + Gemma)
- [x] PayFast wallet integration
- [x] Dark mode across all pages
- [x] Battery-only consumer support
- [x] Code cleanup and modular architecture
- [ ] Carbon to Action converter
- [ ] Mobile responsive bottom navigation
- [ ] Full production deployment

---

<div align="center">
  <img src="https://readme-typing-svg.demolab.com?font=Fira+Code&size=13&pause=1000&color=1d9e75&center=true&vCenter=true&width=600&lines=Building+a+greener+future%2C+one+watt+at+a+time." alt="Footer" />
</div>
