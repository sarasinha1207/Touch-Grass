import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Any OpenAI-compatible endpoint works: Ollama locally, or a hosted open-weight
// model (Hugging Face, OpenRouter, Together, ...) when deployed.
const AI_BASE_URL = (process.env.AI_BASE_URL || "http://localhost:11434/v1").replace(/\/+$/, "");
const AI_API_KEY = process.env.AI_API_KEY || "ollama";
const AI_MODEL = process.env.AI_MODEL || "qwen2.5vl:7b";
const PORT = process.env.PORT || 3000;

const MAX_REQUESTS_PER_MINUTE = Number(process.env.RATE_LIMIT_PER_MIN || 8);
const IMAGE_DATA_URL = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
const MAX_IMAGE_CHARS = 6_000_000; // ~4.5 MB of image data

const SYSTEM_PROMPT = `You are a careful field naturalist. The user sends a photo taken outdoors.
Identify the single most prominent plant, animal, or fungus in it and reply with ONLY a JSON object, no prose, using exactly this shape:
{
  "identified": true or false,
  "category": "plant" | "animal" | "fungus" | "other",
  "common_name": string,
  "scientific_name": string,
  "confidence": "high" | "medium" | "low",
  "summary": one or two friendly sentences,
  "lifespan": string,
  "size": string,
  "key_features": [3 to 5 short strings that help recognise it],
  "habitat": string,
  "range": string describing where in the world it is found,
  "diet": string (animals only, otherwise ""),
  "fun_facts": [2 to 3 short strings],
  "safety_note": string (toxicity, bites, stings, protected status; "" if none),
  "alternatives": [up to 3 other species names it could be, when confidence is not high]
}
Rules: if the photo does not clearly show a plant, animal, or fungus, set "identified" to false and put a short explanation in "summary". Never invent certainty: lower the confidence when the photo is blurry, partial, or ambiguous. Keep every string short.`;

const app = express();
app.set("trust proxy", 1); // Render sits behind a proxy
app.disable("x-powered-by");
app.use((_req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(self), geolocation=(), microphone=()",
    "Content-Security-Policy":
      "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; frame-ancestors 'none'",
  });
  next();
});
app.use(express.json({ limit: "8mb" }));
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

// Public, non-secret info so the page can say which open model is doing the work.
app.get("/api/info", (_req, res) => res.json({ model: AI_MODEL.split("/").pop() }));

// Tiny in-memory rate limit so a public deployment can't drain the model quota.
const hits = new Map();
function rateLimit(req, res, next) {
  const now = Date.now();
  const recent = (hits.get(req.ip) || []).filter((t) => now - t < 60_000);
  if (recent.length >= MAX_REQUESTS_PER_MINUTE) {
    return res.status(429).json({ error: "Slow down a little. Try again in a minute." });
  }
  recent.push(now);
  hits.set(req.ip, recent);
  next();
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, times] of hits) {
    if (!times.some((t) => now - t < 60_000)) hits.delete(ip);
  }
}, 60_000).unref();

function extractJson(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("no JSON in model reply");
  return JSON.parse(text.slice(start, end + 1));
}

const str = (v, max = 400) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const list = (v, n, max = 200) =>
  Array.isArray(v) ? v.map((x) => str(x, max)).filter(Boolean).slice(0, n) : [];

function normalise(raw) {
  const category = ["plant", "animal", "fungus", "other"].includes(raw.category) ? raw.category : "other";
  const confidence = ["high", "medium", "low"].includes(raw.confidence) ? raw.confidence : "low";
  return {
    identified: raw.identified !== false && !!str(raw.common_name),
    category,
    common_name: str(raw.common_name, 120),
    scientific_name: str(raw.scientific_name, 120),
    confidence,
    summary: str(raw.summary, 600),
    lifespan: str(raw.lifespan),
    size: str(raw.size),
    key_features: list(raw.key_features, 5),
    habitat: str(raw.habitat),
    range: str(raw.range),
    diet: str(raw.diet),
    fun_facts: list(raw.fun_facts, 3, 300),
    safety_note: str(raw.safety_note, 400),
    alternatives: list(raw.alternatives, 3, 120),
  };
}

app.post("/api/identify", rateLimit, async (req, res) => {
  const image = req.body?.image;
  if (typeof image !== "string" || image.length > MAX_IMAGE_CHARS || !IMAGE_DATA_URL.test(image)) {
    return res.status(400).json({ error: "Please send a JPEG, PNG or WebP photo under ~4 MB." });
  }

  try {
    const upstream = await fetch(`${AI_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${AI_API_KEY}` },
      body: JSON.stringify({
        model: AI_MODEL,
        temperature: 0.2,
        max_tokens: 900,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              { type: "text", text: "What is this? Reply with the JSON object only." },
              { type: "image_url", image_url: { url: image } },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(120_000),
    });

    if (!upstream.ok) {
      const detail = (await upstream.text()).slice(0, 300);
      console.error("model error", upstream.status, detail);
      return res.status(502).json({ error: "The identification model is unavailable right now." });
    }

    const data = await upstream.json();
    const content = data?.choices?.[0]?.message?.content;
    const text = Array.isArray(content) ? content.map((c) => c.text || "").join("") : content;
    res.json(normalise(extractJson(String(text || ""))));
  } catch (err) {
    console.error("identify failed:", err.message);
    const timedOut = err.name === "TimeoutError";
    res.status(timedOut ? 504 : 502).json({
      error: timedOut
        ? "The model took too long. Try again."
        : "Couldn't read the model's answer. Try another photo.",
    });
  }
});

app.get("/healthz", (_req, res) => res.send("ok"));

// JSON errors for the API (e.g. oversized or malformed bodies), plain 404 elsewhere.
app.use("/api", (_req, res) => res.status(404).json({ error: "Not found." }));
app.use((req, res) => res.status(404).type("text").send("Nothing growing here. Head back to /"));
app.use((err, _req, res, _next) => {
  const tooBig = err.type === "entity.too.large";
  res.status(tooBig ? 413 : 400).json({
    error: tooBig ? "That photo is too large. Try a smaller one." : "Bad request.",
  });
});

app.listen(PORT, () => {
  console.log(`Touch Grass on http://localhost:${PORT}  (model: ${AI_MODEL} @ ${AI_BASE_URL})`);
});
