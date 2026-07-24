# SpeakUp — Personal English Speaking Coach (local-first)

A single-user, runs-100%-on-localhost English conversation coach.
The loop: **coach speaks → you reply by voice → coach evaluates & replies → repeat.**

> Status: **M0 (scaffold) + M1 (bare voice loop) shipped.** Feedback meters, persistence,
> the error ledger, and custom scenarios come in later milestones (see `HANDOFF.md`).

## Stack
- **client/** — React + Vite + Tailwind v4. Voice in/out via the browser (Web Speech API + SpeechSynthesis).
- **server/** — Node + Express. `POST /turn` orchestrates the turn.
- **brain** — pluggable LLM interface. `mock` (offline, zero-key) or `mistral`. Swap via env.
- **db** — SQLite + Prisma (initialized in M0; writes begin in M3).

## Quick start
```bash
# 1. install everything (root + server + client)
npm run install:all

# 2. create the SQLite db from the Prisma schema
npm run prisma:migrate        # name the migration e.g. "init"

# 3. run both client and server together
npm run dev
```
Then open the client (Vite prints the URL, usually http://localhost:5173).

### Using a real LLM (Mistral)
The app runs out of the box with the **mock brain** (no key needed). To use Mistral:
1. Put your key in `server/.env`: `MISTRAL_API_KEY=...`
2. The brain auto-detects the key and switches to Mistral. (Force it with `BRAIN_PROVIDER=mistral`.)
3. Restart `npm run dev`. `GET /health` reports the active brain.

## Voice loop notes (Ruta A)
- Speech-to-text uses the browser's **Web Speech API** — best support in **Chrome/Edge**.
- A **text input fallback** is provided so you can drive the loop without a mic or in any browser.
- Text-to-speech uses **SpeechSynthesis** (all major browsers).
- Offline/local STT+TTS ($0) is the optional M6 milestone.

## Endpoints
- `GET /health` → `{ status, brain, tts, stt, ts }`
- `POST /turn` → body `{ utterance, history }` → `{ coach_reply, xp, audio?, audioFormat?, ttsProvider }`
- `POST /turn/audio` → multipart `{ audio, history? }` → `{ transcript, coach_reply, xp, audio?, audioFormat?, ttsProvider }` (server-side STT; requires `STT_PROVIDER`, 501 otherwise)

## Layout
```
speakup/
├── package.json        # root: concurrently dev script
├── client/             # React + Vite + Tailwind
└── server/             # Express + Prisma + brain
    ├── .env            # server config (gitignored)
    └── prisma/         # schema + dev.db
```
