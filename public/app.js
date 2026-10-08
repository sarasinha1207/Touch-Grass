const MAX_SIDE = 1024;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 130_000;

const NUDGES = [
  "Nice find! Now look around: what else is within 20 steps of you?",
  "Phone away, eyes up. There is probably another one nearby.",
  "Spot the next one without the screen. Come back only if you get stuck.",
  "Try finding three more before you pull this out again.",
];

const $ = (id) => document.getElementById(id);
const cameraInput = $("file-camera");
const uploadInput = $("file-upload");
const drop = $("drop");
const preview = $("preview");
const dropHint = $("drop-hint");
const goBtn = $("go");
const statusEl = $("status");
const resultEl = $("result");

let imageDataUrl = null;
let busy = false;

function setStatus(text, kind = "") {
  statusEl.hidden = !text;
  statusEl.textContent = text || "";
  statusEl.className = "status" + (kind ? " " + kind : "");
}

// Resize on-device so uploads are small and fast (and EXIF/GPS data is dropped).
async function toResizedDataUrl(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return canvas.toDataURL("image/jpeg", 0.85);
}

async function handleFile(file) {
  if (!file || busy) return;
  resultEl.hidden = true;
  if (!file.type.startsWith("image/") || file.size > MAX_FILE_BYTES) {
    setStatus("Please choose a photo under 25 MB.", "error");
    return;
  }
  try {
    imageDataUrl = await toResizedDataUrl(file);
  } catch {
    setStatus("Couldn't read that image. Try a JPEG or PNG.", "error");
    return;
  }
  preview.src = imageDataUrl;
  preview.hidden = false;
  dropHint.hidden = true;
  goBtn.disabled = false;
  setStatus("");
}

function reset() {
  imageDataUrl = null;
  cameraInput.value = "";
  uploadInput.value = "";
  preview.hidden = true;
  preview.removeAttribute("src");
  dropHint.hidden = false;
  goBtn.disabled = true;
  resultEl.hidden = true;
  setStatus("");
}

$("take").addEventListener("click", () => cameraInput.click());
$("choose").addEventListener("click", () => uploadInput.click());
drop.addEventListener("click", () => uploadInput.click());
drop.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); uploadInput.click(); }
});
cameraInput.addEventListener("change", () => handleFile(cameraInput.files[0]));
uploadInput.addEventListener("change", () => handleFile(uploadInput.files[0]));
["dragenter", "dragover"].forEach((t) =>
  drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach((t) =>
  drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", (e) => handleFile(e.dataTransfer.files[0]));

goBtn.addEventListener("click", async () => {
  if (!imageDataUrl || busy) return;
  if (!navigator.onLine) {
    setStatus("You appear to be offline. Reconnect and try again.", "error");
    return;
  }
  busy = true;
  goBtn.disabled = true;
  resultEl.hidden = true;
  setStatus("Looking closely… this can take a few seconds.", "busy");
  try {
    const res = await fetch("/api/identify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: imageDataUrl }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Something went wrong.");
    renderResult(data);
    setStatus("");
  } catch (err) {
    const timedOut = err.name === "TimeoutError";
    setStatus(
      timedOut ? "That took too long. Try again." : err.message || "Something went wrong. Try again.",
      "error",
    );
  } finally {
    busy = false;
    goBtn.disabled = !imageDataUrl;
  }
});

// Build the card with DOM APIs + textContent: model output is never treated as HTML.
function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function listSection(title, items) {
  if (!items?.length) return null;
  const wrap = document.createElement("div");
  const ul = document.createElement("ul");
  items.forEach((i) => ul.append(el("li", i)));
  wrap.append(el("h4", title), ul);
  return wrap;
}

function plainText(d) {
  const lines = [`${d.common_name} (${d.scientific_name})`, d.summary];
  [["Lifespan", d.lifespan], ["Size", d.size], ["Habitat", d.habitat], ["Found in", d.range], ["Diet", d.diet]]
    .filter(([, v]) => v).forEach(([k, v]) => lines.push(`${k}: ${v}`));
  if (d.fun_facts.length) lines.push("Fun facts: " + d.fun_facts.join(" "));
  lines.push("Identified with Touch Grass (AI can be wrong).");
  return lines.filter(Boolean).join("\n");
}

async function copyText(text, btn) {
  const original = btn.textContent;
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = "Copied!";
  } catch {
    btn.textContent = "Copy not available";
  }
  setTimeout(() => { btn.textContent = original; }, 1800);
}

function showResult() {
  resultEl.hidden = false;
  resultEl.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderResult(d) {
  resultEl.replaceChildren();

  if (!d.identified) {
    const again = el("button", "Try another photo", "btn btn-ghost");
    again.type = "button";
    again.addEventListener("click", () => { reset(); $("identify").scrollIntoView({ behavior: "smooth" }); });
    const actions = el("div", null, "card-actions");
    actions.append(again);
    resultEl.append(
      el("h3", "Hmm, I'm not sure"),
      el("p", d.summary || "I couldn't spot a plant or animal in that photo. Try getting closer or improving the light."),
      actions,
    );
    showResult();
    return;
  }

  const tags = el("div", null, "tags");
  tags.append(
    el("span", d.category, "tag"),
    el("span", `${d.confidence} confidence`, d.confidence === "low" ? "tag low" : "tag"),
  );

  const facts = el("dl", null, "facts");
  [["Lifespan", d.lifespan], ["Size", d.size], ["Habitat", d.habitat], ["Found in", d.range], ["Diet", d.diet]]
    .filter(([, v]) => v)
    .forEach(([k, v]) => {
      const row = document.createElement("div");
      row.append(el("dt", k), el("dd", v));
      facts.append(row);
    });

  resultEl.append(el("h3", d.common_name), el("p", d.scientific_name, "sci"), tags, el("p", d.summary), facts);
  [
    listSection("How to recognise it", d.key_features),
    listSection("Fun facts", d.fun_facts),
    d.confidence !== "high" ? listSection("It could also be", d.alternatives) : null,
  ].filter(Boolean).forEach((s) => resultEl.append(s));

  if (d.safety_note) resultEl.append(el("p", "⚠️ " + d.safety_note, "warn"));
  resultEl.append(el("p", NUDGES[Math.floor(Math.random() * NUDGES.length)], "nudge"));

  const copy = el("button", "Copy details", "btn btn-ghost");
  copy.type = "button";
  copy.addEventListener("click", () => copyText(plainText(d), copy));
  const another = el("button", "Identify another", "btn");
  another.type = "button";
  another.addEventListener("click", () => { reset(); $("identify").scrollIntoView({ behavior: "smooth" }); });
  const actions = el("div", null, "card-actions");
  actions.append(copy, another);
  resultEl.append(actions);

  showResult();
}

// Show which open model is powering the app.
fetch("/api/info")
  .then((r) => (r.ok ? r.json() : null))
  .then((info) => { if (info?.model) $("model-badge").textContent = info.model; })
  .catch(() => {});
