// Scrim on Cloudflare Workers: same API as server.js, no cold starts.
// Static files ship as Worker Assets; analytics live in a SQLite-backed
// Durable Object (durable across deploys — an upgrade over Render's logs).
import SunCalc from "suncalc";
import { createClerkClient } from "@clerk/backend";
import { DurableObject } from "cloudflare:workers";

// ---------- sun math (identical to server.js) ----------

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

// ---------- Gemini over plain fetch (SDK-free: Workers-safe) ----------

async function gemini(env, model, payload) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY || "" },
      body: JSON.stringify(payload),
    }
  );
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(JSON.stringify(j.error || j || { code: res.status }));
  return j;
}

const genText = (j) => j.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") ?? "";
const genImage = (j) => (j.candidates?.[0]?.content?.parts ?? []).find((p) => p.inlineData) || null;
const parseJSONish = (text) => { try { return JSON.parse(text || "{}"); } catch { return { raw: text }; } };

function aiErr(e) {
  const s = String(e?.message || e);
  if (/"code"\s*:\s*402|prepayment|credits are depleted|RESOURCE_EXHAUSTED|exceeded your current quota/i.test(s)) {
    return "The AI budget is empty — Scrim's Gemini credits need topping up (ai.studio → billing). Sun timing and the live tools still work.";
  }
  return s;
}

function parseImage(image) {
  let mime = "image/jpeg";
  let data = image;
  const m = /^data:(.+?);base64,(.*)$/s.exec(image);
  if (m) { mime = m[1]; data = m[2]; }
  return { mime, data };
}

// ---------- prompts (identical to server.js) ----------

const DIAGRAM_SPEC = `"diagram": {
    "sunFrom": {"x": 0.0-1.0, "y": 0.0-1.0},
    "subject": {"x": 0.0-1.0, "y": 0.0-1.0},
    "marks": [{"x": 0.0-1.0, "y": 0.0-1.0, "tool": "silk" | "bounce" | "flag" | "shade" | "move" | "wait"}]
  }
For "diagram", all coordinates are fractions of the frame (x rightward, y downward).
"sunFrom" is the point on or near the frame edge where the main light enters.
"subject" is the centre of the main subject.
"marks" has exactly one entry per entry in "fixes", in the same order: the spot IN THE FRAME where that move happens (where the silk or bounce goes, where the subject should move to, or the subject itself for a timing fix). "tool" must be exactly one of the six enum values.`;

function gearLine(gear, kit) {
  if (gear === "kit" && Array.isArray(kit) && kit.length) {
    return `The crew's EXACT kit — plan only with these items, and if something essential is missing list it in "gear" prefixed "RENT:": ${kit.slice(0, 40).join("; ")}.`;
  }
  if (gear === "small") return "The crew has a small battery LED kit (one or two small lights with a softbox) plus grip: silks, bounces, flags.";
  if (gear === "full") return "The crew has a full lighting package (big LEDs/HMIs, stands, full grip) — controlled lighting indoors or outdoors is on the table.";
  return "The crew has NO lighting kit: only grip (silk, bounce, flag), repositioning the subject, and timing.";
}

async function diagnose(env, data, mime, sun, cloudCover) {
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
  const j = await gemini(env, env.VISION_MODEL || "gemini-3.5-flash", {
    contents: [{ role: "user", parts: [{ inlineData: { mimeType: mime, data } }, { text: prompt }] }],
    generationConfig: { responseMimeType: "application/json" },
  });
  return parseJSONish(genText(j));
}

async function plan(env, data, mime, sun, brief, diagnosis, gear, kit) {
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
  const j = await gemini(env, env.VISION_MODEL || "gemini-3.5-flash", {
    contents: [{ role: "user", parts: [{ inlineData: { mimeType: mime, data } }, { text: prompt }] }],
    generationConfig: { responseMimeType: "application/json" },
  });
  return parseJSONish(genText(j));
}

async function renderLook(env, data, mime, brief, diagnosis, gear, kit) {
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
CRITICAL: every piece of lighting equipment is OFF-CAMERA, outside the frame. Do NOT paint any gear into the image — no lights, stands, frames, silks, fabric, panels, reflectors, or bounce boards may appear. When the brief names gear (silk, muslin, flag, negative fill), it names OFF-CAMERA rigging: render only its effect on the light. "Negative fill" means the shadow side goes DEEPER and less filled — never a black object, black panel, or dark fabric anywhere in the picture. Show ONLY the resulting light falling on the existing scene.`;
  const j = await gemini(env, env.IMAGE_MODEL || "gemini-3.1-flash-image", {
    contents: [{ role: "user", parts: [{ inlineData: { mimeType: mime, data } }, { text: prompt }] }],
  });
  const img = genImage(j);
  return img ? { mimeType: img.inlineData.mimeType, data: img.inlineData.data } : null;
}

async function recheckRead(env, beforeData, beforeMime, afterData, afterMime, diagnosis) {
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
  const j = await gemini(env, env.VISION_MODEL || "gemini-3.5-flash", {
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
    generationConfig: { responseMimeType: "application/json" },
  });
  return parseJSONish(genText(j));
}

// ---------- auth: Clerk session OR the shared access code ----------

const clerkOn = (env) => Boolean(env.CLERK_SECRET_KEY && env.CLERK_PUBLISHABLE_KEY);

function clerk(env) {
  return createClerkClient({ secretKey: env.CLERK_SECRET_KEY, publishableKey: env.CLERK_PUBLISHABLE_KEY });
}

async function clerkUserId(request, env) {
  if (!clerkOn(env)) return null;
  try {
    const state = await clerk(env).authenticateRequest(request);
    return state.toAuth()?.userId || null;
  } catch {
    return null;
  }
}

// null = allowed; otherwise a 401 Response. Returns the userId alongside.
async function requireCode(request, env) {
  const code = env.ACCESS_CODE || "";
  if (!code && !clerkOn(env)) return { userId: null };
  if (code && request.headers.get("x-scrim-code") === code) return { userId: await clerkUserId(request, env) };
  const userId = await clerkUserId(request, env);
  if (userId) return { userId };
  return {
    deny: json({ error: clerkOn(env) ? "Sign in (or enter the access code) to use this." : "Access code required." }, 401),
  };
}

function whoami(request, userId, bodyUid) {
  if (userId) return "user:" + userId.slice(-8);
  const anon = String(request.headers.get("x-scrim-uid") || bodyUid || "").trim();
  return /^[a-z0-9-]{4,32}$/i.test(anon) ? "dev:" + anon : undefined;
}

const ADMIN_CACHE = new Map(); // userId -> boolean (per-isolate; fine as a cache)
async function isAdmin(request, env, url) {
  // ADMIN_CODE keeps the dashboard private even when the app itself is open
  const door = env.ADMIN_CODE || env.ACCESS_CODE;
  if (door && url.searchParams.get("code") === door) return true;
  const admins = (env.ADMIN_EMAILS || "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
  if (!clerkOn(env) || !admins.length) return false;
  const userId = await clerkUserId(request, env);
  if (!userId) return false;
  if (ADMIN_CACHE.has(userId)) return ADMIN_CACHE.get(userId);
  try {
    const u = await clerk(env).users.getUser(userId);
    const emails = (u.emailAddresses || []).map((e) => String(e.emailAddress || "").toLowerCase());
    const yes = emails.some((e) => admins.includes(e));
    ADMIN_CACHE.set(userId, yes);
    return yes;
  } catch {
    return false;
  }
}

// ---------- analytics: one SQLite Durable Object, durable across deploys ----------

export class ScrimAnalytics extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, t TEXT, e TEXT, m TEXT, u TEXT);
        CREATE TABLE IF NOT EXISTS feedback (id INTEGER PRIMARY KEY AUTOINCREMENT, t TEXT, name TEXT, body TEXT, u TEXT);
      `);
    });
  }

  log(e, m, u) {
    const sql = this.ctx.storage.sql;
    sql.exec("INSERT INTO events (t, e, m, u) VALUES (?, ?, ?, ?)", new Date().toISOString(), e, m ?? null, u ?? null);
    sql.exec("DELETE FROM events WHERE id <= (SELECT COALESCE(MAX(id), 0) FROM events) - 20000");
  }

  addFeedback(name, body, u) {
    const sql = this.ctx.storage.sql;
    sql.exec("INSERT INTO feedback (t, name, body, u) VALUES (?, ?, ?, ?)", new Date().toISOString(), name, body, u ?? null);
    sql.exec("DELETE FROM feedback WHERE id <= (SELECT COALESCE(MAX(id), 0) FROM feedback) - 2000");
  }

  dump() {
    const sql = this.ctx.storage.sql;
    const events = sql.exec("SELECT t, e, m, u FROM events ORDER BY id DESC LIMIT 5000").toArray().reverse();
    const feedback = sql.exec("SELECT t, name, body, u FROM feedback ORDER BY id DESC LIMIT 500").toArray().reverse();
    return { events, feedback };
  }
}

function analytics(env) {
  return env.ANALYTICS.get(env.ANALYTICS.idFromName("main"));
}

function logEvent(env, ctx, e, m, u) {
  console.log("[scrim-analytics]", JSON.stringify({ t: new Date().toISOString(), e, ...(m ? { m } : {}), ...(u ? { u } : {}) }));
  ctx.waitUntil(analytics(env).log(e, m, u).catch(() => {}));
}

// ---------- helpers ----------

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

const html = (body, status = 200) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });

// ---------- admin page (same dashboard, durable data) ----------

async function adminPage(request, env, url) {
  if (!(await isAdmin(request, env, url))) {
    return html(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Scrim admin</title>
<style>body{font-family:ui-monospace,Menlo,monospace;background:#F3F1E8;color:#191913;padding:40px 24px;max-width:520px;margin:auto}a{color:#A6452D}</style>
<h1>Admins only.</h1><p>Sign in to the app in this browser with an admin account, then come back — or open /admin?code=YOUR_ACCESS_CODE.</p><p><a href="/">← back to Scrim</a></p>`, 401);
  }

  const { events: EVENTS, feedback: FEEDBACK } = await analytics(env).dump();
  const esc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const now = Date.now();

  const counts = {};
  const devices = new Map();
  let errors = 0;
  EVENTS.forEach((ev) => {
    counts[ev.e] = (counts[ev.e] || 0) + 1;
    if (ev.m === "error") errors++;
    if (ev.u) {
      const d = devices.get(ev.u) || { n: 0, last: ev.t, top: {} };
      d.n++; d.last = ev.t; d.top[ev.e] = (d.top[ev.e] || 0) + 1;
      devices.set(ev.u, d);
    }
  });
  const AI_EVENTS = ["analyze", "plan", "render", "recheck", "depth", "chat"];
  const aiCalls = AI_EVENTS.reduce((s, k) => s + (counts[k] || 0), 0);
  const activeHour = new Set(EVENTS.filter((ev) => now - Date.parse(ev.t) < 3600000 && ev.u).map((ev) => ev.u)).size;

  const hours = new Array(24).fill(0);
  EVENTS.forEach((ev) => {
    const age = now - Date.parse(ev.t);
    if (age >= 0 && age < 86400000) hours[23 - Math.floor(age / 3600000)]++;
  });
  const hmax = Math.max(1, ...hours);
  const bars = hours.map((n, i) => {
    const h = Math.round((n / hmax) * 56);
    return `<rect x="${i * 22 + 2}" y="${60 - h}" width="18" height="${Math.max(h, 1)}" fill="${n ? "#A6452D" : "#DAD7C8"}"/><text x="${i * 22 + 11}" y="72" text-anchor="middle" font-size="8" fill="#5C5B50">${n || ""}</text>`;
  }).join("");
  const hourLabels = [0, 6, 12, 18, 23].map((i) => {
    const d = new Date(now - (23 - i) * 3600000);
    return `<text x="${i * 22 + 11}" y="82" text-anchor="middle" font-size="8" fill="#5C5B50">${String(d.getUTCHours()).padStart(2, "0")}h</text>`;
  }).join("");

  const card = (label, value, sub) => `<div class="card"><div class="v">${value}</div><div class="l">${label}</div>${sub ? `<div class="s">${sub}</div>` : ""}</div>`;
  const rows = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="num">${v}</td></tr>`).join("");
  const devRows = [...devices.entries()].sort((a, b) => Date.parse(b[1].last) - Date.parse(a[1].last)).slice(0, 40).map(([who, d]) => {
    const top = Object.entries(d.top).sort((a, b) => b[1] - a[1])[0];
    const cls = who.startsWith("user:") ? "acct" : "";
    return `<tr><td class="${cls}">${esc(who)}</td><td class="num">${d.n}</td><td>${esc(top ? top[0] : "")}</td><td>${d.last.slice(5, 16).replace("T", " ")}</td></tr>`;
  }).join("");
  const recent = EVENTS.slice(-100).reverse().map((ev) => `<tr><td>${ev.t.slice(5, 19).replace("T", " ")}</td><td>${esc(ev.e)}</td><td>${esc(ev.m || "")}</td><td class="${(ev.u || "").startsWith("user:") ? "acct" : ""}">${esc(ev.u || "")}</td></tr>`).join("");
  const fb = FEEDBACK.slice().reverse().map((f) => `<div class="fb"><b>${esc(f.name || "anonymous")}</b> <span>${f.t.slice(0, 16).replace("T", " ")}${f.u ? " · " + esc(f.u) : ""}</span><p>${esc(f.body)}</p></div>`).join("") || "<p class=\"note\">No feedback yet.</p>";

  return html(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="60"><title>Scrim admin</title>
<style>
body{font-family:ui-monospace,Menlo,monospace;background:#F3F1E8;color:#191913;padding:24px 20px 60px;max-width:760px;margin:auto}
h1{font-size:20px;font-family:Georgia,serif;font-weight:600}
h2{font-size:12px;letter-spacing:.16em;color:#A6452D;margin:32px 0 8px;border-bottom:1px solid #191913;padding-bottom:6px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:1px;background:#DAD7C8;border:1px solid #DAD7C8}
.card{background:#F3F1E8;padding:12px 10px}
.card .v{font-size:26px;font-family:Georgia,serif}.card .l{font-size:10px;letter-spacing:.14em;color:#5C5B50;text-transform:uppercase;margin-top:2px}.card .s{font-size:10px;color:#5C5B50;margin-top:2px}
table{border-collapse:collapse;width:100%;font-size:12px}
td{border-bottom:1px solid #DAD7C8;padding:5px 8px 5px 0;vertical-align:top}
td.num{text-align:right;font-weight:600}
td.acct{color:#A6452D;font-weight:600}
.fb{border-bottom:1px solid #DAD7C8;padding:10px 0;font-size:14px}
.fb span{color:#5C5B50;font-size:11px}.fb p{margin:6px 0 0;font-family:Georgia,serif}
.note{color:#5C5B50;font-size:12px}
svg{width:100%;max-width:540px;height:auto;display:block}
</style>
<h1>Scrim — admin</h1>
<p class="note">Durable store on Cloudflare (survives deploys; last 20k events / 2k notes) · auto-refreshes every 60 s · gemini ${env.GEMINI_API_KEY ? "on" : "OFF"} · clerk ${clerkOn(env) ? "on" : "off"} · times UTC</p>
<div class="grid">
${card("devices seen", devices.size, activeHour + " active last hour")}
${card("events", EVENTS.length, "")}
${card("AI calls", aiCalls, (counts.render || 0) + " renders")}
${card("errors", errors, "")}
${card("feedback", FEEDBACK.length, "")}
</div>
<h2>ACTIVITY — LAST 24 H (events/hour)</h2>
<svg viewBox="0 0 530 86">${bars}${hourLabels}</svg>
<h2>TOTALS</h2><table>${rows(counts) || "<tr><td>nothing yet</td></tr>"}</table>
<h2>WHO'S USING IT (last 40 devices — <span class="acct" style="border:0">red</span> = signed-in account)</h2>
<table><tr><td class="note">who</td><td class="note num">events</td><td class="note">top action</td><td class="note">last seen</td></tr>${devRows || "<tr><td>no identified devices yet</td></tr>"}</table>
<h2>FEEDBACK (${FEEDBACK.length})</h2>${fb}
<h2>LAST 100 EVENTS</h2><table>${recent || "<tr><td>none</td></tr>"}</table>`);
}

// ---------- the worker ----------

const PAGE_REWRITES = { "/scan": "/scan.html", "/meter": "/meter.html", "/room": "/room.html" };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;

    try {
      if (request.method === "GET" || request.method === "HEAD") {
        if (PAGE_REWRITES[p]) {
          const u = new URL(url); u.pathname = PAGE_REWRITES[p];
          return env.ASSETS.fetch(new Request(u, request));
        }
        if (p === "/sun") {
          const lat = Number(url.searchParams.get("lat"));
          const lng = Number(url.searchParams.get("lng"));
          if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
            return json({ error: "Need lat and lng query params." }, 400);
          }
          return json(sunReport(lat, lng, url.searchParams.get("t") || undefined));
        }
        if (p === "/health") {
          return json({
            ok: true,
            gemini: Boolean(env.GEMINI_API_KEY),
            locked: Boolean(env.ACCESS_CODE) || clerkOn(env),
            clerk: clerkOn(env) ? env.CLERK_PUBLISHABLE_KEY : null,
          });
        }
        if (p === "/stats") {
          const code = url.searchParams.get("code");
          return Response.redirect(url.origin + "/admin" + (code ? "?code=" + encodeURIComponent(code) : ""), 302);
        }
        if (p === "/admin") return adminPage(request, env, url);
        return env.ASSETS.fetch(request);
      }

      if (request.method !== "POST") return env.ASSETS.fetch(request);
      const body = await request.json().catch(() => ({}));

      // open endpoints: beacons + feedback
      if (p === "/track") {
        const { e, m, u } = body || {};
        if (typeof e !== "string" || !e || e.length > 40) return json({ error: "bad event" }, 400);
        const userId = await clerkUserId(request, env);
        logEvent(env, ctx, e, typeof m === "string" ? m.slice(0, 120) : undefined, whoami(request, userId, u));
        return json({ ok: true });
      }
      if (p === "/feedback") {
        const { text, name } = body || {};
        if (!text || typeof text !== "string" || !text.trim()) return json({ error: "Say something first." }, 400);
        const userId = await clerkUserId(request, env);
        const who = whoami(request, userId);
        console.log("[scrim-feedback]", JSON.stringify({ t: new Date().toISOString(), name: String(name || "").slice(0, 60), text: String(text).slice(0, 2000), ...(who ? { u: who } : {}) }));
        ctx.waitUntil(analytics(env).addFeedback(String(name || "").slice(0, 60), String(text).slice(0, 2000), who).catch(() => {}));
        logEvent(env, ctx, "feedback", undefined, who);
        return json({ ok: true });
      }

      // gated AI endpoints
      const gate = await requireCode(request, env);
      if (gate.deny) return gate.deny;
      const who = whoami(request, gate.userId);

      if (p === "/analyze") {
        const { image, latitude, longitude, timestamp, cloudCover } = body || {};
        if (!image || latitude == null || longitude == null) return json({ error: "Need image (base64), latitude, longitude." }, 400);
        const { mime, data } = parseImage(image);
        const sun = sunReport(Number(latitude), Number(longitude), timestamp);
        const diagnosis = await diagnose(env, data, mime, sun, Number(cloudCover)).catch((e) => ({ error: aiErr(e) }));
        logEvent(env, ctx, "analyze", diagnosis?.error ? "error" : "ok", who);
        return json({ sun, diagnosis });
      }

      if (p === "/chat") {
        const { messages, image, sun: sunNow, diagnosis, kit } = body || {};
        if (!Array.isArray(messages) || !messages.length) return json({ error: "Need messages." }, 400);
        const cx = [];
        if (sunNow) cx.push(`Right now the sun is ${sunNow.altitudeDeg} degrees up, from the ${sunNow.direction}; the light is ${sunNow.quality}.`);
        if (diagnosis && !diagnosis.error) cx.push(`Your latest read of the attached frame: ${diagnosis.hardness || "?"} light from ${diagnosis.direction || "?"}, ${diagnosis.colorTemp || "?"}, ${diagnosis.contrast || "?"} contrast. Problems: ${(diagnosis.problems || []).join("; ") || "none"}.`);
        if (Array.isArray(kit) && kit.length) cx.push(`The crew's kit: ${kit.slice(0, 40).join("; ")}. Prefer answers that use this gear.`);
        const system = `You are Scrim's gaffer: a veteran natural-light gaffer answering questions on location, by chat, on a phone.
${cx.join("\n")}
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
        try {
          const j = await gemini(env, env.VISION_MODEL || "gemini-3.5-flash", {
            systemInstruction: { parts: [{ text: system }] },
            contents: history,
          });
          logEvent(env, ctx, "chat", "ok", who);
          return json({ reply: genText(j) || "(no answer came back)" });
        } catch (err) {
          return json({ error: "chat failed", detail: aiErr(err) }, 500);
        }
      }

      if (p === "/plan") {
        const { image, brief, diagnosis, latitude, longitude, timestamp, gear, kit } = body || {};
        if (!image || !brief || latitude == null || longitude == null) return json({ error: "Need image (base64), brief, latitude, longitude." }, 400);
        const { mime, data } = parseImage(image);
        const sun = sunReport(Number(latitude), Number(longitude), timestamp);
        const result = await plan(env, data, mime, sun, String(brief).slice(0, 500), diagnosis, gear, kit).catch((e) => ({ error: aiErr(e) }));
        logEvent(env, ctx, "plan", result?.error ? "error" : "ok", who);
        return json({ plan: result });
      }

      if (p === "/recheck") {
        const { before, after, diagnosis } = body || {};
        if (!before || !after) return json({ error: "Need before and after images (base64)." }, 400);
        const b = parseImage(before), a = parseImage(after);
        const check = await recheckRead(env, b.data, b.mime, a.data, a.mime, diagnosis).catch((e) => ({ error: aiErr(e) }));
        logEvent(env, ctx, "recheck", check?.error ? "error" : "ok", who);
        return json({ check });
      }

      if (p === "/depth") {
        const { image } = body || {};
        if (!image) return json({ error: "Need image (base64)." }, 400);
        const { mime, data } = parseImage(image);
        const prompt = `Generate the DEPTH MAP of this exact photograph. Output an image with identical framing where each pixel's brightness encodes distance from the camera: pure white = nearest to camera, pure black = farthest, smooth grayscale in between. Preserve the exact geometry and silhouettes. No colors, no outlines, no text, no stylization — only the grayscale depth map.`;
        try {
          const j = await gemini(env, env.IMAGE_MODEL || "gemini-3.1-flash-image", {
            contents: [{ role: "user", parts: [{ inlineData: { mimeType: mime, data } }, { text: prompt }] }],
          });
          const img = genImage(j);
          logEvent(env, ctx, "depth", img ? "ok" : "error", who);
          if (!img) return json({ depth: null, error: "model returned no depth image" });
          return json({ depth: `data:${img.inlineData.mimeType};base64,${img.inlineData.data}`, error: null });
        } catch (err) {
          return json({ error: "depth failed", detail: aiErr(err) }, 500);
        }
      }

      if (p === "/render") {
        const { image, brief, diagnosis, gear, kit } = body || {};
        if (!image) return json({ error: "Need image (base64)." }, 400);
        const { mime, data } = parseImage(image);
        const render = await renderLook(env, data, mime, typeof brief === "string" ? brief.slice(0, 500) : "auto", diagnosis, gear, kit)
          .catch((e) => ({ error: aiErr(e) }));
        logEvent(env, ctx, "render", render && !render.error ? "ok" : "error", who);
        return json({
          render: render && !render.error ? `data:${render.mimeType};base64,${render.data}` : null,
          error: render?.error || (render ? null : "model returned no image"),
        });
      }

      return json({ error: "not found" }, 404);
    } catch (err) {
      console.error(err);
      return json({ error: "request failed", detail: aiErr(err) }, 500);
    }
  },
};
