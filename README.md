# Symptom Nerd Backend (Local)

This is a minimal local proxy for the Symptom Nerd iOS app. It keeps your OpenAI API key off-device.

## Setup
1) Open a terminal and go to this folder:

```bash
cd "/Users/davidolumide/Documents/Symptom Nerd/SymptomNerd/backend"
```

2) Install dependencies:

```bash
npm install
```

3) Create a `.env` file:

```bash
cp .env.example .env
```

4) Choose your AI provider in `.env` (Gemini or OpenAI).

Gemini example:

```text
AI_PROVIDER=gemini
GEMINI_API_KEY=your-gemini-key
GEMINI_MODEL=gemini-2.5-flash
```

OpenAI example:

```text
AI_PROVIDER=openai
OPENAI_API_KEY=sk-...
```

5) Run the server:

```bash
npm start
```

It will listen on `http://localhost:3001` and print the active provider.

## Pharmacist web console (local)
This console lets staff triage chat sessions and call requests.

1) Create a Firebase service account and download the JSON.
2) Set one of these:
   - `GOOGLE_APPLICATION_CREDENTIALS=/full/path/to/service-account.json`
   - OR `FIREBASE_SERVICE_ACCOUNT_JSON='{"type":"service_account", ...}'`
3) Set credentials for the console:
   - `PHARMACIST_USER=pharmacist`
   - `PHARMACIST_PASS=strong-password`
4) Start the server and open:
   - `http://localhost:3001/pharmacist`

The console uses Basic Auth and Firebase Admin SDK (bypasses Firestore rules).

## Optional: Log AI requests to Neon (Postgres)
If you want to store AI request/response metadata in Neon:
1) Create a Neon project and copy the connection string.
2) Add this to `.env`:

```text
NEON_DATABASE_URL=postgres://user:pass@host/db?sslmode=require
LOG_AI_REQUESTS=true
```

The server will auto-create a table named `ai_requests` on first use.

## Device testing
If you want to test on a physical iPhone:
- Make sure your Mac and iPhone are on the same Wi-Fi
- Use your Mac’s LAN IP in the iOS app Settings → “AI backend URL”, e.g.
  `http://192.168.1.10:3001`
- Ensure macOS Firewall allows incoming connections on port 3001

## Endpoints
- `POST /ai/analyze`
- `POST /ai/chat`
- `GET /health`

The server expects a JSON payload matching the app’s `AIRequest` contract.
