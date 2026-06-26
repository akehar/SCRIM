# Scrim (backend)

The weekend slice of Scrim, a natural-light gaffer assistant. One endpoint that, given a photo plus a location and time, returns:

1. **A sun report** computed locally with `suncalc`: the sun's current angle, direction, and quality, plus today's golden hour and blue hour windows. No AI, works offline once moved onto the phone.
2. **A lighting diagnosis** from a Gemini vision model: direction, hardness, colour temperature, contrast, the problems, and specific softening or timing fixes.
3. **A softened render** from Nano Banana (`gemini-3.1-flash-image`): the same frame re-lit toward a soft, warm, golden-hour look, subject and framing kept intact.

It ships with a tiny test page so you can try it from your phone before any native app exists.

> The render is a directional preview, not a final grade. It shows the person what softer light would do, it does not measure it.

## Endpoint

`POST /analyze`

Request:

```json
{
  "image": "data:image/jpeg;base64,...",
  "latitude": 41.55,
  "longitude": -8.42,
  "timestamp": "2026-06-26T12:00:00Z",
  "lookHint": "optional, e.g. moody warm"
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
    "fixes": ["put a 4x4 silk between sun and subject", "bounce the shadow side", "or wait for golden hour at 19:42"]
  },
  "render": "data:image/png;base64,..."
}
```

`GET /health` returns `{ "ok": true }`.

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
