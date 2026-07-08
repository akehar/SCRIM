# Scrim (backend)

The weekend slice of Scrim, a natural-light gaffer assistant.

Sun apps (PhotoPills, Sun Seeker) tell you where the sun will be but never look at your frame. AI relighters fix the photo afterwards but teach you nothing on set. Scrim sits in the gap: it reads *your* frame right now, names the problem in plain language, gives you a physical or timing fix, and shows a preview of what softer light would do — so you get it right in camera.

One endpoint that, given a photo plus a location and time, returns:

1. **A sun report** computed locally with `suncalc`: the sun's current angle, direction, and quality, plus today's golden hour and blue hour windows. No AI, works offline once moved onto the phone.
2. **A lighting diagnosis** from a Gemini vision model: direction, hardness, colour temperature, contrast, the problems, and specific softening or timing fixes — plus a `diagram` with frame-space coordinates (where the sun enters, where the subject is, and a numbered mark per fix) that the test page draws directly on the photo.
3. **A softened render** from Nano Banana (`gemini-3.1-flash-image`): the same frame re-lit toward a soft, warm, golden-hour look, subject and framing kept intact.

It ships as an app-shell web app (dark, set-friendly, installable as a PWA) with three screens:

- **Now** — ticking golden-hour countdown, the sun's arc for the day with golden/blue bands and a now-cursor, cloud-cover-aware timing (Open-Meteo, no key), a sun compass, and a "you've read light here before" note when you return to a logged spot.
- **Shoot** — live viewfinder built on `getUserMedia` (phone lenses, or any camera that presents as a video source: Osmo Pocket 3 Webcam Mode, Sony a7S III/a7 IV/FX3 USB Streaming, HDMI via capture stick) with an AR sun-path overlay on the feed; then the read → brief → plan → relight flow, a **Check my work** re-check loop (`POST /recheck` grades a before/after pair: cleared / remaining / new problems), and a shareable call-sheet PNG (frame + burned-in diagram + moves + windows).
- **Log** — scene memory: the last 12 reads with thumbnail, light summary, time, and distance from where you stand.

> The render is a directional preview, not a final grade. It shows the person what softer light would do, it does not measure it.

## Endpoints

The read and the render are split so renders are never wasted: `/analyze` is the cheap vision call, `/render` only fires when the user presses **Light it**.

`POST /analyze` — the read.

Request:

```json
{
  "image": "data:image/jpeg;base64,...",
  "latitude": 41.55,
  "longitude": -8.42,
  "timestamp": "2026-06-26T12:00:00Z"
}
```

`image` accepts a data URL or raw base64. `timestamp` is optional and defaults to now.

Response:

```json
{
  "sun": {
    "now": { "altitudeDeg": 64, "azimuthDeg": 180, "direction": "south", "quality": "harsh and overhead, the hardest light of the day" },
    "morningGoldenHour": { "start": "...", "end": "..." },
    "eveningGoldenHour": { "start": "...", "end": "..." },
    "blueHour": { "start": "...", "end": "..." },
    "sunrise": "...",
    "sunset": "..."
  },
  "diagnosis": {
    "direction": "high overhead, slightly camera right",
    "hardness": "hard",
    "colorTemp": "neutral",
    "contrast": "high",
    "problems": ["harsh shadows under the eyes", "blown highlights on the forehead"],
    "fixes": ["put a 4x4 silk between sun and subject", "bounce the shadow side", "or wait for golden hour at 19:42"],
    "diagram": { "sunFrom": {"x": 0.1, "y": 0.1}, "subject": {"x": 0.5, "y": 0.55}, "marks": [{"x": 0.3, "y": 0.2, "tool": "silk", "label": "4x4 silk here"}] }
  }
}
```

`POST /plan` — the brief-aware plan. `{ "image": "...", "brief": "...", "diagnosis": {…}, "latitude": …, "longitude": … }` → `{ "plan": { "approach": "one-line treatment", "fixes": […], "diagram": {…} } }`. Same cheap vision model as `/analyze`: when the user picks a look, the moves and the diagram redraw **for that brief** (a dramatic brief shapes hard light rather than softening it) instead of staying stuck on the default read. "Gaffer's call" reuses the plan from the read, no extra call.

`POST /render` — the relight. `{ "image": "...", "brief": "text or \"auto\"", "diagnosis": {…} }` → `{ "render": "data:...", "error": null }`. The brief is the director's direction (the test page offers preset looks — Soft & golden, Dramatic, Dappled canopy, Clean commercial — plus free text); `"auto"` is the **gaffer's call**, where the model picks the treatment that fixes the diagnosed problems. Passing the `diagnosis` from `/analyze` grounds the relight in the read. The prompt insists on a lighting change (shadow edges, source size, motivated sources), not a color grade.

The `sun` object also carries `nextGoldenHour` — the next (or currently open) golden-hour window with `minutesUntil`/`minutesLeft`, which drives the test page's live countdown. If a Gemini call fails, the response says why in `diagnosis.error` / the render `error` instead of going quiet.

`GET /sun?lat=41.55&lng=-8.42` returns just the sun report — no image, no AI, no key needed. The test page calls it on load so the countdown works before you ever take a photo.

`GET /health` returns `{ "ok": true, "gemini": true|false }` — `gemini:false` means `GEMINI_API_KEY` isn't set on the server, and the test page shows a banner explaining that instead of failing silently.

## Run locally

```bash
npm install
cp .env.example .env      # then paste your GEMINI_API_KEY
npm start                 # http://localhost:3000
```

Open `http://localhost:3000` on your machine, or your computer's LAN address on your phone, and take a photo.

## Deploy to Render from GitHub

1. Push this folder to a GitHub repo (suggested name: `scrim`).
2. In Render, **New > Web Service**, connect the repo.
3. Render reads `render.yaml` automatically. If you set it up by hand instead: runtime Node, build `npm install`, start `npm start`.
4. Add an environment variable **GEMINI_API_KEY** with your key. (Do not commit it.)
5. Deploy, then open the Render URL on your phone and take a photo.

The free plan cold-starts after idle, so the first request after a quiet spell is slow. Fine for testing.

## Notes

- The key lives only on Render. The app and the test page never see it.
- Model ids drift. `gemini-3.1-flash-image` is the image model; for the vision diagnosis, confirm the current flash model id at https://ai.google.dev and set `VISION_MODEL` to match.
- Next steps once the reads look good: move the sun math onto the phone for offline live use, add the golden-hour countdown and the sun-direction compass overlay, then the grounded chat assistant.
