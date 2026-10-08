# Touch Grass 🌿

Snap a photo of a plant or animal you don't recognise and an open-weight vision model tells you what it is: name, lifespan, features, range, fun facts. Then you put the phone away and keep exploring.

- **Stack:** Node + Express (one dependency), plain HTML/CSS/JS. No database, no build step.
- **AI:** any open-weight vision model behind an OpenAI-compatible API (Ollama locally, a hosted provider on Render).
- **Privacy:** photos are resized on-device, sent only to the model, and never stored.

## Run locally

1. Install [Ollama](https://ollama.com) and pull a vision model:
   ```bash
   ollama pull qwen2.5vl:7b
   ```
   (On a weaker laptop try a smaller one, e.g. `gemma3:4b`, and set `AI_MODEL` to match.)
2. Install and start:
   ```bash
   npm install
   npm run dev
   ```
3. Open http://localhost:3000. To try it on your phone, open `http://<your-laptop-ip>:3000` on the same Wi-Fi.

Copy `.env.example` to `.env` to change the model or endpoint.

## Deploy on Render

Render has no GPU, so on Render the app calls a hosted open-weight model instead of Ollama.

1. Push this folder to GitHub.
2. In Render: **New → Blueprint** (uses `render.yaml`) or **New → Web Service** with build `npm install` and start `npm start`.
3. Set the environment variables `AI_BASE_URL`, `AI_MODEL`, `AI_API_KEY` to an OpenAI-compatible provider serving an open-weight vision model (see `.env.example`).

Render's free tier sleeps when idle, so the first request after a break is slow.

## What's in the app

- Public one-page site with a header, a body of seven sections, and a footer. The sections are: hero (with an example result), identifier (with photo tips), what you can find, how it works, open source (live model name and run-it-yourself), safety and privacy, and FAQ. It has a mobile menu and scroll highlighting in the nav, is responsive, supports light and dark mode, and is keyboard accessible.
- Identifier: take a photo or choose one (or drag and drop), then get a field-guide card with a copy-to-clipboard option and a nudge to go back outside.
- Handled cases: not-a-plant/animal photos, low confidence with alternatives, unreadable model replies, model downtime, timeouts, oversized files, rate limiting and offline.
- Hardening: strict Content-Security-Policy, model output rendered as text only, and a per-IP rate limit.

## How it works

`POST /api/identify` takes one image, sends it to the model with a field-naturalist prompt that asks for strict JSON, validates and trims the reply, and returns it. The page renders the result with `textContent` only, so model output is never injected as HTML. A small in-memory rate limit protects your model quota.

## Safety

AI identification can be wrong. The app lowers its stated confidence when unsure, offers alternatives, and always tells users not to eat or handle wild plants or animals based on its answer.
