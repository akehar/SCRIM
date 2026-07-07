import express from "express";
import SunCalc from "suncalc";
import { GoogleGenAI } from "@google/genai";

const app = express();
app.use(express.json({ limit: "16mb" }));
app.use(express.static("public"));

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

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

function sunReport(lat, lng, when) {
  const date = when ? new Date(when) : new Date();
  const pos = SunCalc.getPosition(date, lat, lng);
  const times = SunCalc.getTimes(date, lat, lng);
  const altDeg = rad2deg(pos.altitude);
  // suncalc azimuth is measured from south; shift to a compass bearing from north.
  const bearing = (rad2deg(pos.azimuth) + 180 + 360) % 360;

  return {
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

async function diagnose(data, mime, sun) {
  const prompt = `You are an experienced gaffer looking at a single frame lit by natural light.
Right now the sun is ${sun.now.altitudeDeg} degrees above the horizon, coming from the ${sun.now.direction}, and the light is ${sun.now.quality}.
Judge ONLY the lighting on the subject and scene. Reply with strict JSON, no markdown, exactly this shape:
{
  "direction": "where the main light comes from, in plain words",
  "hardness": "soft" | "medium" | "hard",
  "colorTemp": "warm" | "neutral" | "cool",
  "contrast": "low" | "balanced" | "high",
  "problems": ["at most 3 short plain-language issues"],
  "fixes": ["at most 3 specific softening or timing moves, e.g. add a 4x4 silk, bounce the shadow side, move into open shade, wait for golden hour at a given time"],
  "diagram": {
    "sunFrom": {"x": 0.0-1.0, "y": 0.0-1.0},
    "subject": {"x": 0.0-1.0, "y": 0.0-1.0},
    "marks": [{"x": 0.0-1.0, "y": 0.0-1.0, "tool": "silk" | "bounce" | "flag" | "shade" | "move" | "wait", "label": "2-4 words"}]
  }
}
For "diagram", all coordinates are fractions of the frame (x rightward, y downward).
"sunFrom" is the point on or near the frame edge where the main light enters.
"subject" is the centre of the main subject.
"marks" has exactly one entry per entry in "fixes", in the same order: the spot IN THE FRAME where that move happens (where the silk or bounce goes, where the subject should move to, or the subject itself for a timing fix).`;

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

// ---------- Gemini call 2: render the softened look ----------

async function renderSoftened(data, mime, lookHint) {
  const prompt = `Re-light this exact photo as if the harsh natural light had been softened and warmed toward golden hour.
Keep the same subject, framing, composition, background, and geometry EXACTLY. Change ONLY the light:
soften the hard shadows, gently warm the tone, lower the contrast on faces, keep it photographic and realistic, not stylised.${lookHint ? " Look note: " + lookHint : ""}`;

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

// ---------- the one endpoint ----------

app.post("/analyze", async (req, res) => {
  try {
    const { image, latitude, longitude, timestamp, lookHint } = req.body || {};
    if (!image || latitude == null || longitude == null) {
      return res.status(400).json({ error: "Need image (base64), latitude, longitude." });
    }

    // accept either a data URL or raw base64
    let mime = "image/jpeg";
    let data = image;
    const m = /^data:(.+?);base64,(.*)$/s.exec(image);
    if (m) { mime = m[1]; data = m[2]; }

    const sun = sunReport(Number(latitude), Number(longitude), timestamp);

    const [diagnosis, render] = await Promise.all([
      diagnose(data, mime, sun).catch((e) => ({ error: String(e?.message || e) })),
      renderSoftened(data, mime, lookHint).catch((e) => ({ error: String(e?.message || e) })),
    ]);

    res.json({
      sun,
      diagnosis,
      render: render && !render.error ? `data:${render.mimeType};base64,${render.data}` : null,
      renderError: render?.error || (render ? null : "model returned no image"),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "analyze failed", detail: String(err?.message || err) });
  }
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
app.get("/health", (_req, res) => res.json({ ok: true, gemini: Boolean(process.env.GEMINI_API_KEY) }));

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("scrim backend listening on :" + port);
  if (!process.env.GEMINI_API_KEY) {
    console.warn("GEMINI_API_KEY is not set: sun timing works, diagnosis and render will fail.");
  }
});
