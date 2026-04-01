# Dots & Boxes AI Battle Suite

Full-stack Dots & Boxes game built with FastAPI, vanilla JavaScript, SQLite, and multiple AI strategies.

The project supports:
- Human vs Human
- Human vs AI
- AI vs AI
- Algorithm comparison
- Game history and replay
- Session-isolated live gameplay for multiple concurrent users

## Screenshots

### Dashboard
![Dashboard](docs/screenshots/dashboard.png)

### Play Minimax
![Play Minimax](docs/screenshots/play-minimax.png)

### AI vs AI
![AI vs AI](docs/screenshots/ai-vs-ai.png)

## Live Demo

- Production: [https://dot-and-boxes-ai-game.vercel.app](https://dot-and-boxes-ai-game.vercel.app)
- Repository: [https://github.com/senapathiyaswanth/Dot-And-Boxes-AI-Game](https://github.com/senapathiyaswanth/Dot-And-Boxes-AI-Game)

## Highlights

- Per-session game isolation so different users do not share the same board
- Minimax, Alpha-Beta, and Adaptive AI strategies
- Faster Vercel runtime behavior with hosted-specific tuning
- Reduced end-of-game latency and improved game-over modal handling
- AI-vs-AI speed controls with faster hosted defaults
- History and replay for completed games

## Current Architecture

### Frontend

Core files:
- `public/index.html`
- `public/script.js`
- `public/styles.css`

Frontend responsibilities:
- render the single-page interface
- manage section navigation
- send a stable browser-scoped `session_id` with live gameplay requests
- render boards, scores, AI metrics, history, and game-over modal
- use polling fallback on Vercel where WebSockets are not relied on

### Backend

Core files:
- `backend/app.py`
- `backend/api/routes.py`
- `backend/session_manager.py`
- `backend/engine/game.py`
- `backend/ai/strategies.py`
- `backend/ai/heuristics.py`
- `backend/learning/qlearning.py`
- `backend/database/db.py`

Backend responsibilities:
- keep live game state isolated per session
- run Minimax, Alpha-Beta, and Adaptive AI turns
- manage AI-vs-AI background tasks
- store completed game history in SQLite
- persist Q-learning data

## Multi-User Model

This project is now safe for multiple simultaneous users on a single running app instance.

Each live session gets:
- its own `GameState`
- its own async lock
- its own AI-vs-AI task
- its own state version
- its own WebSocket/polling scope

This prevents one user's moves or board resets from affecting another user's game.

## Deployment Notes

### Localhost

Localhost gives the best parity for the full experience because the app can behave like a single long-lived server.

Run with:

```powershell
.\.venv\Scripts\python.exe -m uvicorn backend.app:app --host 127.0.0.1 --port 8000
```

Open:

- `http://127.0.0.1:8000`
- `http://localhost:8000`

### Vercel

The project is deployed successfully on Vercel, but the runtime is tuned differently from localhost.

Deployment in this repository is configured with:
- `vercel.json` routing `/api/*` to the FastAPI app and SPA routes to `public/index.html`
- `public/` as the static frontend directory served by Vercel
- `.vercelignore` to keep local-only files out of deployments

Hosted adjustments include:
- no dependency on WebSocket live updates
- state-response fast path to avoid extra round trips
- reduced AI-vs-AI pacing delay
- Vercel-specific AI depth caps for responsiveness
- async persistence after game completion to avoid blocking the modal path

These changes are there to make the hosted version feel responsive within a serverless environment.

#### Fresh Vercel setup

1. Install the Vercel CLI:

```powershell
cmd /c npm install -g vercel
```

2. Log in and link the repo:

```powershell
vercel login
vercel
```

3. Deploy production:

```powershell
vercel --prod
```

When you run the app locally, FastAPI now serves `public/` first so local behavior matches the deployed Vercel frontend.

### Important Limitation

Live sessions are still in memory.

This means the project is good for:
- localhost
- demos
- one running app instance
- single-instance hosting

On Vercel specifically, SQLite history and Q-learning data are written into the function temp directory, so they should be treated as non-durable across cold starts or different instances.

It is not yet the final architecture for:
- multiple app instances behind load balancing
- crash-safe live session recovery
- large-scale production clusters

For that, the next step would be Redis or another shared live state layer.

## AI Strategies

### Minimax

- full adversarial search
- slower than Alpha-Beta
- useful for comparison and educational visibility

### Alpha-Beta

- pruned search
- much better for interactive play
- best default for responsive hosted turns

### Adaptive AI

- Alpha-Beta plus Q-learning influence
- reuses learned move values while keeping tree-search guidance

## Performance Improvements Already Applied

Recent stabilization and responsiveness work includes:
- fixed session cross-talk between Minimax, Alpha-Beta, and AI-vs-AI sections
- stopped Vercel websocket retry loops
- reduced AI think delay by removing extra client fetches after turns
- returned live state directly from move endpoints
- moved end-of-game save work off the critical response path
- improved AI-vs-AI pacing and hosted defaults
- added state-version tracking so the frontend ignores unchanged snapshots
- improved game-over modal reopening behavior
- added hash-based section linking such as `#play-minimax` and `#aivai`

## API Overview

REST endpoints:
- `GET /api/state`
- `POST /api/start-game`
- `POST /api/reset`
- `POST /api/move`
- `POST /api/ai-move`
- `POST /api/ai-vs-ai`
- `GET /api/suggest`
- `POST /api/comparison`
- `GET /api/history`
- `GET /api/history/{id}`
- `GET /api/stats`
- `GET /api/learning-stats`
- `GET /api/balance-stats`

WebSocket endpoint:
- `WS /api/ws`

Live gameplay clients must send a stable `session_id` query parameter. The built-in frontend already does this automatically.

## Project Structure

```text
Ai_project/
├─ README.md
├─ requirements.txt
├─ backend/
│  ├─ app.py
│  ├─ session_manager.py
│  ├─ api/
│  │  └─ routes.py
│  ├─ ai/
│  │  ├─ balance.py
│  │  ├─ heuristics.py
│  │  └─ strategies.py
│  ├─ database/
│  │  └─ db.py
│  ├─ engine/
│  │  └─ game.py
│  └─ learning/
│     └─ qlearning.py
├─ frontend/
│  ├─ index.html
│  ├─ script.js
│  ├─ styles.css
│  └─ assets/
├─ docs/
│  └─ screenshots/
└─ data/
   ├─ games.db
   └─ learning_data.json
```

## Installation

### Windows

```powershell
python -m venv .venv
.\.venv\Scripts\activate
pip install -r requirements.txt
```

### macOS / Linux

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Testing Notes

Verification performed during the recent stabilization pass included:
- 12 repeated local test games
- multiple AI-vs-AI strategy pairings
- repeated Human-vs-AI flows
- clean game-over completion checks
- state version progression checks
- production Vercel endpoint timing checks

## Troubleshooting

### Localhost page keeps loading

Check whether another process is already using port `8000`:

```powershell
cmd /c netstat -ano | findstr :8000
```

Stop the stuck process:

```powershell
taskkill /PID <pid> /F
```

### Hosted AI-vs-AI still feels slow

Use the faster options in the AI-vs-AI speed selector:
- `Instant (0.01s)`
- `Fast (0.03s)`
- `Balanced (0.05s)`

### History behaves differently across hosting styles

Localhost and single-instance hosting give the most predictable behavior because live sessions remain in one process.

## Future Production Upgrade Path

If this project needs true production-grade multi-instance reliability, add:
- Redis for shared live session state
- Postgres instead of local SQLite
- cross-instance pub/sub for realtime fanout
- background job handling for longer AI tasks
- observability, rate limiting, and health checks

## License

This repository currently has no separate license file. Add one if you want to make usage terms explicit.
