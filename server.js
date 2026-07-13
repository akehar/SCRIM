import express from "express";
import SunCalc from "suncalc";
import { GoogleGenAI } from "@google/genai";

const app = express();
app.use(express.json({ limit: "16mb" }));
app.use(express.static("public"));

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Shared access code protecting the AI endpoints (the ones that spend money).
// Unset = open, for local dev. Set ACCESS_CODE in Render to lock the deploy.
const ACCESS_CODE = process.env.ACCESS_CODE || "";
function requireCode(req, res, next) {
  if (!ACCESS_CODE || req.get("x-scrim-code") === ACCESS_CODE) return next();
  res.status(401).json({ error: "Access code required." });
}

// ---------- beta analytics: in-memory since boot, durable via Render's log stream ----------
// Search "[scrim-analytics]" / "[scrim-feedback]" in Render Logs for history across restarts.
const EVENTS = [];
const FEEDBACK = [];
const BOOTED = new Date();
function logEvent(e, meta) {
  const ev = { t: new Date().toISOString(), e, ...(meta ? { m: meta } : {}) };
  EVENTS.push(ev);
  if (EVENTS.length > 2000) EVENTS.shift();
  console.log("[scrim-analytics]", JSON.stringify(ev));
}

// Nano Banana 2 edits the actual frame (image in, image out).
const IMAGE_MODEL = process.env.IMAGE_MODEL || "gemini-3.1-flash-image";
// Reads the frame and returns JSON. Model ids drift, so confirm the
// current flash model at https://ai.google.dev before you ship.
const VISION_MODEL = process.env.VISION_MODEL || "gemini-3.5-flash";

// ---------- sun math (no AI, runs anywhere, can move to the phone later) ----------

function rad2deg(r) { return (r * 180) / Math.PI; }

function compass(bearingDeg) {
  const dirs = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"];
  return dirs[Math.round((((bearingDeg % 360) + 360) % 360) / 45) % 8];
}

function lightQuality(altDeg) {
  if (altDeg <= 0) return "sun is below the horizon, blue hour or night";
  if (altDeg <= 6) return "very soft, warm, golden";
  if (altDeg <= 15) return "soft and directional, flattering";
  if (altDeg <= 45) return "getting hard, watch the shadows";
  return "harsh and overhead, the hardest light of the day";
}

function validDate(d) {
  return d instanceof Date && !Number.isNaN(d.getTime());
}

// The next (or currently open) soft-light window, so the UI can run a countdown.
// Checks today and tomorrow; near the poles some windows never happen, hence the guards.
function nextGoldenWindow(lat, lng, now) {
  const windows = [];
  for (const dayOffset of [0, 1]) {
    const day = new Date(now.getTime() + dayOffset * 86400000);
    const t = SunCalc.getTimes(day, lat, lng);
    if (validDate(t.sunrise) && validDate(t.goldenHourEnd)) {
      windows.push({ label: "morning golden hour", start: t.sunrise, end: t.goldenHourEnd });
    }
    if (validDate(t.goldenHour) && validDate(t.sunset)) {
      windows.push({ label: "evening golden hour", start: t.goldenHour, end: t.sunset });
    }
  }
  windows.sort((a, b) => a.start - b.start);
  const open = windows.find((w) => w.start <= now && now < w.end);
  if (open) return { ...open, active: true, minutesUntil: 0, minutesLeft: Math.round((open.end - now) / 60000) };
  const next = windows.find((w) => w.start > now);
  return next ? { ...next, active: false, minutesUntil: Math.round((next.start - now) / 60000) } : null;
}

// The sun's arc sampled every 30 min for ~36 h: drives the AR overlay and the day timeline.
function sunPath(lat, lng, from) {
  const start = new Date(from);
  start.setMinutes(0, 0, 0);
  const points = [];
  for (let i = 0; i <= 72; i++) {
    const t = new Date(start.getTime() + i * 30 * 60000);
    const p = SunCalc.getPosition(t, lat, lng);
    points.push({
      t,
      azimuthDeg: Math.round((rad2deg(p.azimuth) + 180 + 360) % 360),
      altitudeDeg: Math.round(rad2deg(p.altitude)),
    });
  }
  return points;
}

function sunReport(lat, lng, when) {
  const date = when ? new Date(when) : new Date();
  const pos = SunCalc.getPosition(date, lat, lng);
  const times = SunCalc.getTimes(date, lat, lng);
  const altDeg = rad2deg(pos.altitude);
  // suncalc azimuth is measured from south; shift to a compass bearing from north.
  const bearing = (rad2deg(pos.azimuth) + 180 + 360) % 360;

  return {
    path: sunPath(lat, lng, date),
    now: {
      altitudeDeg: Math.round(altDeg),
      azimuthDeg: Math.round(bearing),
      direction: compass(bearing),
      quality: lightQuality(altDeg),
    },
    nextGoldenHour: nextGoldenWindow(lat, lng, date),
    morningGoldenHour: { start: times.sunrise, end: times.goldenHourEnd },
    eveningGoldenHour: { start: times.goldenHour, end: times.sunset },
    blueHour: { start: times.sunset, end: times.dusk },
    sunrise: times.sunrise,
    sunset: times.sunset,
  };
}

// ---------- Gemini call 1: diagnose the light ----------

const DIAGRAM_SPEC = `"diagram": {
    "sunFrom": {"x": 0.0-1.0, "y": 0.0-1.0},
    "subject": {"x": 0.0-1.0, "y": 0.0-1.0},
    "marks": [{"x": 0.0-1.0, "y": 0.0-1.0, "tool": "silk" | "bounce" | "flag" | "shade" | "move" | "wait"}]
  }
For "diagram", all coordinates are fractions of the frame (x rightward, y downward).
"sunFrom" is the point on or near the frame edge where the main light enters.
"subject" is the centre of the main subject.
"marks" has exactly one entry per entry in "fixes", in the same order: the spot IN THE FRAME where that move happens (where the silk or bounce goes, where the subject should move to, or the subject itself for a timing fix). "tool" must be exactly one of the six enum values.`;

async function diagnose(data, mime, sun, cloudCover) {
  const sky = Number.isFinite(cloudCover)
    ? cloudCover >= 75 ? " The sky is heavily overcast, so the ambient is soft and diffuse."
      : cloudCover >= 40 ? ` The sky is about ${Math.round(cloudCover)}% cloudy — broken light.`
      : " The sky is mostly clear."
    : "";
  const prompt = `You are an experienced gaffer looking at a single frame lit by natural light.
Right now the sun is ${sun.now.altitudeDeg} degrees above the horizon, coming from the ${sun.now.direction}, and the light is ${sun.now.quality}.${sky}
Judge ONLY the lighting on the subject and scene. "fixes" is YOUR call as the gaffer: the treatment you would run if the director gave no direction. Reply with strict JSON, no markdown, exactly this shape:
{
  "direction": "where the main light comes from, in plain words",
  "hardness": "soft" | "medium" | "hard",
  "colorTemp": "warm" | "neutral" | "cool",
  "contrast": "low" | "balanced" | "high",
  "problems": ["at most 3 short plain-language issues"],
  "fixes": ["at most 3 specific practical moves, e.g. add a 4x4 silk, bounce the shadow side, move into open shade, wait for golden hour at a given time"],
  ${DIAGRAM_SPEC}
}`;

  const res = await ai.models.generateContent({
    model: VISION_MODEL,
    contents: [{
      role: "user",
      parts: [
        { inlineData: { mimeType: mime, data } },
        { text: prompt },
      ],
    }],
    config: { responseMimeType: "application/json" },
  });

  const text = res.text ?? res.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") ?? "{}";
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

// ---------- Gemini call 1b: plan for a brief ----------

// What the crew can rig changes what the gaffer plans. "none" is grip-only natural
// light; "full" unlocks controlled lighting indoors or out.
function gearLine(gear, kit) {
  if (gear === "kit" && Array.isArray(kit) && kit.length) {
    return `The crew's EXACT kit — plan only with these items, and if something essential is missing list it in "gear" prefixed "RENT:": ${kit.slice(0, 40).join("; ")}.`;
  }
  if (gear === "small") return "The crew has a small battery LED kit (one or two small lights with a softbox) plus grip: silks, bounces, flags.";
  if (gear === "full") return "The crew has a full lighting package (big LEDs/HMIs, stands, full grip) — controlled lighting indoors or outdoors is on the table.";
  return "The crew has NO lighting kit: only grip (silk, bounce, flag), repositioning the subject, and timing.";
}

// Same cheap vision model as diagnose: redraws the moves and the diagram for the
// director's brief, so the plan matches what the user actually wants.
async function plan(data, mime, sun, brief, diagnosis, gear, kit) {
  const read = diagnosis && !diagnosis.error
    ? `Your earlier read of this frame: key from ${diagnosis.direction || "unknown"}, ${diagnosis.hardness || "?"} light, ${diagnosis.colorTemp || "?"}, ${diagnosis.contrast || "?"} contrast. Problems: ${(diagnosis.problems || []).join("; ") || "none listed"}.`
    : "";
  const prompt = `You are an experienced gaffer planning natural-light work on location.
Right now the sun is ${sun.now.altitudeDeg} degrees above the horizon, coming from the ${sun.now.direction}, and the light is ${sun.now.quality}.
${read}
The director's brief for this frame: "${brief}".
${gearLine(gear, kit)}
Plan at most 3 practical moves within that gear that get THIS frame to THAT brief. Do not default to softening; serve the brief (a dramatic brief may mean shaping hard light, a dappled brief may mean placing broken shade).
Be CONCRETE like a real gaffer's notes: name the fixture and modifier, the stand (C-stand, combo), rig height in feet, tilt, and distance from subject; name diffusion by frame size and gel (4x4 216 full, 250 half, opal) and how many feet of it.
Reply with strict JSON, no markdown, exactly this shape:
{
  "approach": "one short sentence: the treatment you're going for",
  "fixes": ["at most 3 specific practical moves with rigging detail, in shooting order"],
  "gear": ["packing list, max 8 lines with quantities — fixtures + modifiers, stands, frames, fabric/diffusion with sizes and footage, sandbags; prefix RENT: for anything essential the crew lacks"],
  "overhead": {
    "sunDeg": 0-360,
    "subject": {"x": -1.0 to 1.0, "d": 0.0 to 1.0},
    "items": [{"kind": "light" | "silk" | "bounce" | "flag", "label": "short name", "x": -1.0 to 1.0, "d": 0.0 to 1.0, "heightFt": number}]
  },
  ${DIAGRAM_SPEC}
}
"overhead" is a TOP-DOWN set map seen from above, camera at the bottom: x is left(-1) to right(+1) of the camera axis, d is depth from camera (0) to far (1). "sunDeg" is where the sunlight COMES FROM: 0 = from behind camera, 90 = from camera right, 180 = from behind the subject (backlight), 270 = from camera left. One item per physical piece in the plan, max 5.`;

  const res = await ai.models.generateContent({
    model: VISION_MODEL,
    contents: [{
      role: "user",
      parts: [
        { inlineData: { mimeType: mime, data } },
        { text: prompt },
      ],
    }],
    config: { responseMimeType: "application/json" },
  });

  const text = res.text ?? res.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") ?? "{}";
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

// ---------- Gemini call 2: relight to a brief ----------

async function renderLook(data, mime, brief, diagnosis, gear, kit) {
  const read = diagnosis && !diagnosis.error
    ? `A gaffer read this frame as: key from ${diagnosis.direction || "unknown"}, ${diagnosis.hardness || "?"} light, ${diagnosis.colorTemp || "?"}, ${diagnosis.contrast || "?"} contrast. Problems: ${(diagnosis.problems || []).join("; ") || "none listed"}.`
    : "";
  const wants = brief && brief !== "auto"
    ? `The director's brief: ${brief}.`
    : `No brief was given — make the gaffer's call yourself: pick the single treatment that best fixes the problems above and keep it believable for this location and time of day.`;

  const prompt = `Relight this exact photograph. This is a LIGHTING change, not a color grade: the geometry of the light must change, not just the tones.
${read}
${wants}
${gearLine(gear, kit)} Every effect must be achievable with that gear.
What must change: the direction, apparent size, and quality of the light on the subject. Reshape shadow EDGES (a bigger apparent source means a softer penumbra), open or deepen shadow AREAS, tame or add speculars and catchlights, and keep every effect motivated by a plausible physical source — sun angle, bounce, silk, flag, or foliage.
What must NOT change: subject identity and pose, framing, composition, lens perspective, background content, and scene geometry. Photorealistic, like the scene was reshot under the new lighting — not stylised, not a filter.
CRITICAL: every piece of lighting equipment is OFF-CAMERA, outside the frame. Do NOT paint any gear into the image — no lights, stands, frames, silks, fabric, panels, reflectors, or bounce boards may appear. Show ONLY the resulting light falling on the existing scene.`;

  const res = await ai.models.generateContent({
    model: IMAGE_MODEL,
    contents: [{
      role: "user",
      parts: [
        { inlineData: { mimeType: mime, data } },
        { text: prompt },
      ],
    }],
  });

  const parts = res.candidates?.[0]?.content?.parts ?? [];
  const img = parts.find((p) => p.inlineData);
  return img ? { mimeType: img.inlineData.mimeType, data: img.inlineData.data } : null;
}

// accept either a data URL or raw base64
function parseImage(image) {
  let mime = "image/jpeg";
  let data = image;
  const m = /^data:(.+?);base64,(.*)$/s.exec(image);
  if (m) { mime = m[1]; data = m[2]; }
  return { mime, data };
}

// ---------- endpoints ----------

// The read: sun + diagnosis + diagram. Cheap vision call, no image generation.
app.post("/analyze", requireCode, async (req, res) => {
  try {
    const { image, latitude, longitude, timestamp, cloudCover } = req.body || {};
    if (!image || latitude == null || longitude == null) {
      return res.status(400).json({ error: "Need image (base64), latitude, longitude." });
    }
    const { mime, data } = parseImage(image);
    const sun = sunReport(Number(latitude), Number(longitude), timestamp);
    const diagnosis = await diagnose(data, mime, sun, Number(cloudCover)).catch((e) => ({ error: String(e?.message || e) }));
    logEvent("analyze", diagnosis?.error ? "error" : "ok");
    res.json({ sun, diagnosis });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "analyze failed", detail: String(err?.message || err) });
  }
});

// ---------- Gemini call: ask the gaffer (chat) ----------

app.post("/chat", requireCode, async (req, res) => {
  try {
    const { messages, image, sun: sunNow, diagnosis, kit } = req.body || {};
    if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ error: "Need messages." });
    const ctx = [];
    if (sunNow) ctx.push(`Right now the sun is ${sunNow.altitudeDeg} degrees up, from the ${sunNow.direction}; the light is ${sunNow.quality}.`);
    if (diagnosis && !diagnosis.error) ctx.push(`Your latest read of the attached frame: ${diagnosis.hardness || "?"} light from ${diagnosis.direction || "?"}, ${diagnosis.colorTemp || "?"}, ${diagnosis.contrast || "?"} contrast. Problems: ${(diagnosis.problems || []).join("; ") || "none"}.`);
    if (Array.isArray(kit) && kit.length) ctx.push(`The crew's kit: ${kit.slice(0, 40).join("; ")}. Prefer answers that use this gear.`);
    const system = `You are Scrim's gaffer: a veteran natural-light gaffer answering questions on location, by chat, on a phone.
${ctx.join("\n")}
Answer in plain, practical on-set language. Be specific (gear sizes, angles, times), stay on lighting/photography/filmmaking, and keep answers to a few short sentences unless asked to go deep. If a question needs the frame and none is attached, say so.
Formatting: this renders in a phone chat. Use short paragraphs, "-" bullets for lists, **bold** for gear names, and nothing else — no tables, no code blocks, and NEVER ASCII-art diagrams or maps. If asked for a setup map, describe positions in words and mention that the Shoot tab's plan draws an overhead map.`;

    const history = messages.slice(-12).map((m, i, arr) => ({
      role: m.role === "user" ? "user" : "model",
      parts: [
        ...(image && i === arr.length - 1 && m.role === "user"
          ? [{ inlineData: { mimeType: parseImage(image).mime, data: parseImage(image).data } }]
          : []),
        { text: String(m.text || "").slice(0, 2000) },
      ],
    }));

    const r = await ai.models.generateContent({
      model: VISION_MODEL,
      config: { systemInstruction: system },
      contents: history,
    });
    const text = r.text ?? r.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") ?? "";
    logEvent("chat", "ok");
    res.json({ reply: text || "(no answer came back)" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "chat failed", detail: String(err?.message || err) });
  }
});

// The plan: cheap vision call that redraws fixes + diagram for the director's brief.
app.post("/plan", requireCode, async (req, res) => {
  try {
    const { image, brief, diagnosis, latitude, longitude, timestamp, gear, kit } = req.body || {};
    if (!image || !brief || latitude == null || longitude == null) {
      return res.status(400).json({ error: "Need image (base64), brief, latitude, longitude." });
    }
    const { mime, data } = parseImage(image);
    const sun = sunReport(Number(latitude), Number(longitude), timestamp);
    const p = await plan(data, mime, sun, String(brief).slice(0, 500), diagnosis, gear, kit)
      .catch((e) => ({ error: String(e?.message || e) }));
    logEvent("plan", p?.error ? "error" : "ok");
    res.json({ plan: p });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "plan failed", detail: String(err?.message || err) });
  }
});

// The re-check: BEFORE and AFTER frames, did the moves work?
async function recheckRead(beforeData, beforeMime, afterData, afterMime, diagnosis) {
  const earlier = diagnosis && !diagnosis.error
    ? `The BEFORE frame was read as: ${diagnosis.hardness || "?"} light from ${diagnosis.direction || "?"}, ${diagnosis.contrast || "?"} contrast. Problems: ${(diagnosis.problems || []).join("; ") || "none listed"}.`
    : "";
  const prompt = `You are the same gaffer checking your own work. The first image is BEFORE, the second is AFTER the crew applied the plan.
${earlier}
Compare ONLY the lighting on the subject and scene. Reply with strict JSON, no markdown, exactly this shape:
{
  "verdict": "better" | "same" | "worse",
  "cleared": ["problems from before that are now fixed"],
  "remaining": ["problems still present"],
  "new": ["any new lighting problems the fix introduced"],
  "note": "one sentence of direction for the next tweak, or praise if it's right"
}`;
  const res = await ai.models.generateContent({
    model: VISION_MODEL,
    contents: [{
      role: "user",
      parts: [
        { inlineData: { mimeType: beforeMime, data: beforeData } },
        { text: "BEFORE" },
        { inlineData: { mimeType: afterMime, data: afterData } },
        { text: "AFTER" },
        { text: prompt },
      ],
    }],
    config: { responseMimeType: "application/json" },
  });
  const text = res.text ?? res.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") ?? "{}";
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

app.post("/recheck", requireCode, async (req, res) => {
  try {
    const { before, after, diagnosis } = req.body || {};
    if (!before || !after) return res.status(400).json({ error: "Need before and after images (base64)." });
    const b = parseImage(before), a = parseImage(after);
    const check = await recheckRead(b.data, b.mime, a.data, a.mime, diagnosis)
      .catch((e) => ({ error: String(e?.message || e) }));
    logEvent("recheck", check?.error ? "error" : "ok");
    res.json({ check });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "recheck failed", detail: String(err?.message || err) });
  }
});

// Depth map for the Relight Studio: one image-model call per frame, cached client-side.
// The WebGL relight preview then runs live on-device at zero per-move cost.
app.post("/depth", requireCode, async (req, res) => {
  try {
    const { image } = req.body || {};
    if (!image) return res.status(400).json({ error: "Need image (base64)." });
    const { mime, data } = parseImage(image);
    const prompt = `Generate the DEPTH MAP of this exact photograph. Output an image with identical framing where each pixel's brightness encodes distance from the camera: pure white = nearest to camera, pure black = farthest, smooth grayscale in between. Preserve the exact geometry and silhouettes. No colors, no outlines, no text, no stylization — only the grayscale depth map.`;
    const r = await ai.models.generateContent({
      model: IMAGE_MODEL,
      contents: [{ role: "user", parts: [{ inlineData: { mimeType: mime, data } }, { text: prompt }] }],
    });
    const parts = r.candidates?.[0]?.content?.parts ?? [];
    const img = parts.find((p) => p.inlineData);
    logEvent("depth", img ? "ok" : "error");
    if (!img) return res.json({ depth: null, error: "model returned no depth image" });
    res.json({ depth: `data:${img.inlineData.mimeType};base64,${img.inlineData.data}`, error: null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "depth failed", detail: String(err?.message || err) });
  }
});

// The relight: only called when the user asks, so no renders are wasted.
// brief is free text, or "auto" for the gaffer's call. diagnosis (from /analyze) grounds the render.
app.post("/render", requireCode, async (req, res) => {
  try {
    const { image, brief, diagnosis, gear, kit } = req.body || {};
    if (!image) return res.status(400).json({ error: "Need image (base64)." });
    const { mime, data } = parseImage(image);
    const render = await renderLook(data, mime, typeof brief === "string" ? brief.slice(0, 500) : "auto", diagnosis, gear, kit)
      .catch((e) => ({ error: String(e?.message || e) }));
    logEvent("render", render && !render.error ? "ok" : "error");
    res.json({
      render: render && !render.error ? `data:${render.mimeType};base64,${render.data}` : null,
      error: render?.error || (render ? null : "model returned no image"),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "render failed", detail: String(err?.message || err) });
  }
});

// Client-side UI events: fire-and-forget beacons (tab views, exports, studio opens).
app.post("/track", (req, res) => {
  const { e, m } = req.body || {};
  if (typeof e !== "string" || !e || e.length > 40) return res.status(400).json({ error: "bad event" });
  logEvent(e, typeof m === "string" ? m.slice(0, 120) : undefined);
  res.json({ ok: true });
});

// In-app beta feedback: kept in memory AND printed whole to the log stream.
app.post("/feedback", (req, res) => {
  const { text, name } = req.body || {};
  if (!text || typeof text !== "string" || !text.trim()) return res.status(400).json({ error: "Say something first." });
  const fb = { t: new Date().toISOString(), name: String(name || "").slice(0, 60), text: String(text).slice(0, 2000) };
  FEEDBACK.push(fb);
  if (FEEDBACK.length > 500) FEEDBACK.shift();
  console.log("[scrim-feedback]", JSON.stringify(fb));
  logEvent("feedback");
  res.json({ ok: true });
});

// The owner's dashboard: /stats?code=YOUR_ACCESS_CODE
app.get("/stats", (req, res) => {
  if (ACCESS_CODE && req.query.code !== ACCESS_CODE) return res.status(401).send("Add ?code=YOUR_ACCESS_CODE");
  const counts = {};
  EVENTS.forEach((ev) => { counts[ev.e] = (counts[ev.e] || 0) + 1; });
  const esc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const rows = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v}</td></tr>`).join("");
  const recent = EVENTS.slice(-80).reverse().map((ev) => `<tr><td>${ev.t.slice(5, 19).replace("T", " ")}</td><td>${esc(ev.e)}</td><td>${esc(ev.m || "")}</td></tr>`).join("");
  const fb = FEEDBACK.slice().reverse().map((f) => `<div class="fb"><b>${esc(f.name || "anonymous")}</b> <span>${f.t.slice(0, 16).replace("T", " ")}</span><p>${esc(f.text)}</p></div>`).join("") || "<p>No feedback yet.</p>";
  res.send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Scrim stats</title>
<style>body{font-family:ui-monospace,Menlo,monospace;background:#F3F1E8;color:#191913;padding:24px;max-width:720px;margin:auto}
h1{font-size:20px}h2{font-size:13px;letter-spacing:.14em;color:#A6452D;margin-top:28px}table{border-collapse:collapse;width:100%;font-size:13px}
td{border-bottom:1px solid #DAD7C8;padding:5px 8px 5px 0}.fb{border-bottom:1px solid #DAD7C8;padding:10px 0;font-size:14px}
.fb span{color:#5C5B50;font-size:11px}.fb p{margin:6px 0 0;font-family:Georgia,serif}.note{color:#5C5B50;font-size:12px}</style>
<h1>Scrim — beta stats</h1>
<p class="note">In-memory since boot (${BOOTED.toISOString().slice(0, 16).replace("T", " ")} UTC) · resets on deploy/idle · full history: Render Logs, search [scrim-analytics] or [scrim-feedback]</p>
<h2>TOTALS SINCE BOOT</h2><table>${rows(counts) || "<tr><td>nothing yet</td></tr>"}</table>
<h2>FEEDBACK (${FEEDBACK.length})</h2>${fb}
<h2>LAST 80 EVENTS</h2><table>${recent || "<tr><td>none</td></tr>"}</table>`);
});

// Sun-only report: no image, no AI, no key needed. Cheap enough to poll.
app.get("/sun", (req, res) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return res.status(400).json({ error: "Need lat and lng query params." });
  }
  res.json(sunReport(lat, lng, req.query.t));
});

// gemini:false tells the test page to explain itself instead of failing silently.
app.get("/health", (_req, res) => res.json({ ok: true, gemini: Boolean(process.env.GEMINI_API_KEY), locked: Boolean(ACCESS_CODE) }));

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("scrim backend listening on :" + port);
  if (!process.env.GEMINI_API_KEY) {
    console.warn("GEMINI_API_KEY is not set: sun timing works, diagnosis and render will fail.");
  }
});
