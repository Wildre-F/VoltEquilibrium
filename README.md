# Green Energy Management Platform

A smart green energy web application for monitoring solar/renewable energy systems, sharing energy in a community, and managing a wallet — powered by real-time IoT data over MQTT.

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

Create a file called `.env` in the **`backend/`** folder:

```bash
cp backend/.env.example backend/.env
```

If `.env.example` doesn't exist, create `backend/.env` manually with the following contents:

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
FRONTEND_URL=http://localhost:8080

# MQTT
MQTT_BROKER=mqtt://mqtt:1883

# Email (optional — only needed for password-reset emails)
EMAIL_USER=
EMAIL_PASS=

# Google OAuth (optional — only needed for Google login)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
```

> **Important:** Change `JWT_SECRET` to any random string. The database values must match what is in `docker-compose.yaml`.

### 3. Start the project

From the project root, run:

```bash
docker compose up --build
```

This starts three containers:

| Service      | Description              | Local Port |
|--------------|--------------------------|------------|
| **postgres** | PostgreSQL 17 database   | 5432       |
| **mqtt**     | Mosquitto MQTT broker    | 1883 / 9001 (WebSocket) |
| **backend**  | Node.js Express API      | 3000       |

The database schema is automatically applied on first run from `backend/schema.sql`.

### 4. Open the frontend

The frontend is static HTML — just open any page directly in your browser:

```
frontend/Dashboard.html
```

Or serve it with any simple HTTP server. For example, from the project root:

```bash
# Python
python -m http.server 8080

# Node.js (npx, no install needed)
npx serve . -l 8080
```

Then open [http://localhost:8080/frontend/Dashboard.html](http://localhost:8080/frontend/Dashboard.html).

> If you use a different port than `8080`, update `FRONTEND_URL` in your `.env` file to match.

### 5. Stopping the project

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
├── frontend/           # Static HTML/CSS/JS pages
├── backend/
│   ├── app.js          # Express API entry point
│   ├── db.js           # PostgreSQL connection
│   ├── passport.js     # Google OAuth strategy
│   ├── launcher.js     # Simulator launcher
│   ├── schema.sql      # Database schema (auto-applied)
│   └── simulators/     # IoT device simulators
├── mosquitto/
│   └── config/         # Mosquitto MQTT broker config
├── CSS/                # Shared stylesheets
├── Javascript/         # Shared frontend scripts
└── docker-compose.yaml
```

## Troubleshooting

- **Port already in use** — Stop any local PostgreSQL, Mosquitto, or Node services that may be using ports 5432, 1883, or 3000.
- **Backend keeps restarting** — Check that `backend/.env` exists and `JWT_SECRET` is set. Run `docker compose logs backend` to see errors.
- **Database connection refused** — The backend container connects to the hostname `postgres` (not `localhost`). Make sure `DB_HOST=postgres` in your `.env`.
- **CORS errors in the browser** — Make sure `FRONTEND_URL` in `.env` matches the URL you opened the frontend on (e.g. `http://localhost:8080`).
