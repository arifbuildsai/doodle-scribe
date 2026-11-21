---
name: Doodle Scribe
description: >
  Produce hand-drawn animated videos from just a topic, in two styles: (1) "Doodle Scribe" —
  dense black-line doodle art on white paper revealed stroke-by-stroke under a photoreal
  drawing hand (line-art SVGs traced in true stroke order), and (2) "Whiteboard Explainer" —
  dry-erase marker on a glossy whiteboard with a traveling camera. Both write the script,
  generate the voiceover (ElevenLabs with word-level timestamps, or the user's own audio),
  storyboard visually, build a self-contained player HTML, and render a word-synced MP4 in
  headless Chrome with a generated sound score mixed under the narration. Use whenever the
  user asks for a "doodle video", "whiteboard explainer", "scribe video", "whiteboard video",
  "dry-erase explainer", "explainer animation", or a video "in the doodle/whiteboard format"
  — with or without a provided script/voiceover.
---

# Doodle Scribe — topic → finished hand-drawn MP4

Two profiles share one pipeline: **Doodle Scribe** (default; black-ink doodles on paper,
photoreal hand) and **Whiteboard Explainer** (marker on a glossy board, traveling camera).

Everything needed lives beside this SKILL.md (paths below are relative to this directory):

- `whiteboard/template.html` — the whiteboard profile's full player, self-contained (H library, drawing technique,
  SOUND kit, player, render hooks). Everything story-specific sits between
  `>>>CONTENT-VISUAL`, `>>>CONTENT-CAMERA`, `>>>CONTENT-SOUND`, `>>>CONTENT-META` markers.
- `reference/why-sky-blue.html` — the finished "Why the sky is blue" film as the worked example.
- `reference/storyboard.html` — the finished storyboard page as the worked example.
- `scripts/tts.mjs` — ElevenLabs voiceover + `WORDS.tsv` (word-level timestamps).
- `scripts/render.js` — headless-Chrome frame capture + offline sound render + ffmpeg mix.

## Workflow

### 0. Setup (per project, once)
In the project directory run `npm i puppeteer` (uses the system Chrome, no browser download)
if not already installed. Requires ffmpeg on PATH and network access (Google Fonts + ElevenLabs).

### 1. Script
Write 6–9 voiceover lines, one idea per line, 4–6 s each (~30 s total). First line = hook,
last = takeaway. Keep facts accurate; note any numbers you state. If the user supplies a
script, use it verbatim. Save as plain text: one line per spoken line, blank lines = pauses.

### 2. Voiceover (word-timed, never guess timing)
- User attached audio → use it as VO. Transcribe it with word-level timestamps yourself
  (e.g. faster-whisper, see `reference` workflow: `ffmpeg` → 16 kHz f32le → whisper `small`
  → spread script words over whisper hits, like the vox-doc `align_en.py` pattern). Do not ask.
- Otherwise generate with `scripts/tts.mjs`:
  `node <skill>/scripts/tts.mjs script.txt <outdir>` → `VO.wav` + `WORDS.tsv` + `vo_meta.json`.
  Default voice is the public preset "Alice"; override with `--voice <id|name>` or
  `ELEVENLABS_VOICE_ID`. Requires `ELEVENLABS_API_KEY` in the environment. If the account's
  plan does not allow `pcm_44100` output the script falls back to `mp3_44100_128`
  automatically and converts to WAV. Ask before substituting a different voice than the user
  expects; if the user's own voice clone is requested but the plan rejects it, say so.
- `WORDS.tsv` (line, i, start, end, word) is the timing source of truth. Build a BEATS table:
  one entry per line/idea with start/end from the take, the words, and what is on screen.
  `DURATION` = last word end + ~1 s.

### 3. STORYBOARD FIRST — wait for approval
Copy the structure of `reference/storyboard.html`: same technique code, a grid of panels
(6–10), each a canvas rendering the new story's key frame at its beat time via the shared
`drawFrame(t)`. Under each panel: beat number, start–end time from WORDS.tsv, exact on-screen
text, how it follows the previous beat (continuous: what carries over and how it moves, or
scene change: which transition and why), and key sounds. Below the grid: every fact/number
you assumed. Show the page (e.g. serve over localhost + browser preview; the browse relay
blocks `file://`), then WAIT for the user's OK. Only skip this if the user explicitly says so.

### 4. Build the player
Copy `whiteboard/template.html` and rewrite only the marked CONTENT blocks:

- `>>>CONTENT-VISUAL`: the ITEMS list — every stroke/text/dot is an item with absolute
  `a..b` times taken from WORDS.tsv so each visual lands on the word it illustrates (may
  lead by ≤ 0.2 s, never lag). Reuse the template's helper builders (`line/text/dot/arrow/
  molecule/sun/eye/scribble`) and add topic-specific ones as needed. Draw subjects accurately
  for the topic; verify the science/facts shown.
- `>>>CONTENT-CAMERA`: one key per scene `[t, x, y, zoom]`; hold during speech, move during
  pauses. Continuous beats = pan/zoom of the same scene; real scene changes = long pan across
  the big board. World is ~x −200…5000, y −150…1350 at 1280×720.
- `>>>CONTENT-SOUND`: story accents (whoosh on pans, sparkle/ticks/swishes, impact/ding on
  the key number and takeaway). The generic per-item marker-stroke loop is fixed — keep it.
- `>>>CONTENT-META`: DURATION; also the `<title>`.
- Leave the ghost-lesson board texture, sheen, grain and player untouched.

Non-negotiable style rules (they make it read as the real medium):
- Every stroke draws on in sequence; the marker-in-hand rides whatever is currently being
  drawn and switches barrel color with the marker. The marker must be visible in essentially
  every frame where anything is drawing.
- On-screen text is key words/labels/numbers only — never the spoken sentence, no subtitles.
  At 1280×720: headlines ≥ 44 px, every story label ≥ 28 px, key numbers ≥ 64 px.
- Keep all finishing passes (paper/board gradient, ghost residue, sheen with parallax,
  ceiling lights, `H.grain`) at the same strength on every frame.
- Every frame is a pure function of `t`: seed all randomness with `H.rng`/`H.makeNoise`,
  never `Math.random`. Target < 100 ms per frame (use `step: 6–8` options on long strokes).

### 5. QA before rendering
Serve the project dir (`python3 -m http.server <port> &`), open the page in the browser,
seek mid-draw times and confirm the marker, layout and text; check the control bar works.
(The browse relay evaluates in an isolated world — page globals like `window.seek` read as
`undefined` there; that is an artifact. Drive the UI through DOM events and judge the canvas.)

### 6. Render the MP4
`node <skill>/scripts/render.js --page <player.html> --out <topic>.mp4 --vo <outdir>/VO.wav`
Smoke-test first with `--limit 30`. It captures every frame headlessly, renders the sound
score offline (`SOUND.renderOffline`, voiceover mode), and muxes video + voiceover
(loudnorm −17) with the effects sidechain-ducked under the narration (final −16 LUFS).
QC the output: ffprobe streams (stereo 48 kHz) and pull frames at key times.

### 7. Deliver
Preview the MP4 to the user, list what was built and where, and offer adjustments
(pacing, labels, mix) — a re-render is cheap: video recapture only when visuals change,
otherwise re-mix only.

## Notes
- ElevenLabs: script lines are spoken in order; `WORDS.tsv` line numbers match non-empty
  script lines. If the take breathes differently than planned, trust the take.
- Sound design rules: minor `{ minor: true }` strokes/labels/ticks sit ~60 % under the
  narration; big hits (key number, wrong/right moment, takeaway) stay full volume and land
  on stressed words or in pauses; everything starts on the exact frame its event appears.
- If `ELEVENLABS_API_KEY` is missing, ask the user for a key or a voiceover file — do not
  silently substitute a different TTS voice.

## Second profile: Doodle Scribe (Doodle-Insta-like)

A hand-drawn scribe look on plain white paper: dense black-line doodle art revealed
stroke-by-stroke under a photoreal drawing hand, outlined display type, accent pops
(purple scribbles, yellow highlight bars), hard cuts between scenes, static camera.
The whiteboard workflow above applies unchanged (script → VO → word-synced beats →
storyboard-first unless skipped → build → QA → render). Differences:

- Template: `doodle-scribe/template.html` (same player harness; exposes `DS_DURATION`).
- Art: generate per topic with Google Flow + Nano Banana (drive flow.google.com with the
  browse tools: New project → composer → model Nano Banana Pro, aspect 1:1, x1 → generate
  → open tile → Download media → 1K). Style-locked prompt prefix: "Simple hand-drawn black
  ink doodle line art on a pure white background, thick uniform black strokes, cartoon
  style, no shading, no gray tones, no color, no text." plus one subject per image. Also
  generate ONE photoreal sprite: right hand holding a black marker on pure white, tip
  pointing lower-left, no shadows (the scribe hand). Accept user-supplied doodle art too.
- Files go to `assets/<name>.jpg`; `keyLineArt()` keys white→alpha and auto-detects each
  image's background luminance from its corners, so textured paper is fine.
- Reveal: `scribe(img, x, y, w, a, b, scene)` wipes the art along a serpentine path; the
  hand sprite's calibrated tip (`HAND_TIP`, `HAND_BASE`) rides the edge. Tune both once
  per hand image by test frames (`doodle-scribe/qa_frames.js`).
- Keep square art within y 80–560 at w ≤ 500 so the headline row at y ~640 stays clear.
- Hard cuts: set `CUTS` times in speech gaps; each scene is a fresh white canvas.
- Sound: pencil/pen strokes per reveal (minor), page-flip `paper` on cuts, pops on labels,
  full-volume impact on the takeaway.
- Render: same `scripts/render.js` (reads DS_DURATION); `--allow-file-access-from-files`
  is already in its launch args because the page keys file:// images on canvas.

### SVG import mode (v2 — "draw it in code ourselves" without hand-authoring art)
- Art source: **stroke-based line-art SVGs** (Openmoji black line layer is ideal: every element
  is `fill="none" stroke="#000"`, uniform 2px, round caps; CC BY-SA 4.0 — write attribution
  into assets/SOURCES.md + video description). SVG Repo direct downloads work
  (`svgrepo.com/download/<id>/<slug>.svg`) but their HTML pages rate-limit bots, and many icons
  are FILLED silhouettes — unusable for stroke-order drawing. Prefer Openmoji / line-art sources.
- Pipeline: `scripts/svg2strokes.mjs out.js name=file.svg ...` flattens line/rect/circle/ellipse/
  polyline/polygon/path (M L H V C S Q T A Z, abs+rel) into polylines and emits
  `window.STROKES`. Include `<script src="assets/strokes.js"></script>` before the player script.
- Engine: `scribeSvg(name, x, y, w, a, b, scene, {whiteout})` — item kind `svg`; strokes are time-sliced by
  polyline length, drawn with pen() + light wobble, hand rides the ink front of the live stroke
  (same rules as lines: finished strokes never park the hand). True stroke-order drawing, pen
  lifts between strokes, marker width = max(6, scale*2.2) from the SVG's 2px line.
- `whiteout: true` (used for the cloud): the glyph's first closed stroke progressively fills
  paper-white BEFORE inking, so foreground objects genuinely COVER line art beneath them
  (a cloud hiding a star). Draw order matters: the covered item must come first in ITEMS.
- scoreSound must have an `it.k === 'svg'` case (pencil stroke + pop) — otherwise the offline
  sound render crashes on `it.s.length` (svg items have no `.s`).
- Attribution requirement: Openmoji is CC BY-SA — keep SOURCES.md in every project and credit
  in the video description ("Doodle line art: Openmoji — openmoji.org — CC BY-SA 4.0").
- Sample of converted stroke data: `doodle-scribe/strokes.sample.js`; source manifest sample:
  `doodle-scribe/SOURCES.sample.md`.
- Worked example: the template's CONTENT blocks currently hold "The Little Star Nobody
  Noticed" — a complete 63.5s, 6-scene emotional story (159-word VO, every scene item laid on
  word timestamps, procedural star protagonist with expression changes, whiteout cloud, beam +
  dotted paths, closing message held ~3.5s). Use it as the reference for pacing and item
  layout; rewrite the CONTENT blocks per project. qa_frames.js is copied per project (edit
  the page URL at its top).

### Doodle profile — the look (keep these rules; they define the style)
- The photoreal hand draws EVERYTHING: doodle reveals and every hand-drawn line (underlines,
  highlight bars, swashes, curls, dots, the dotted path). Only the big outlined display text
  appears without the hand (that is the reference's grammar).
- Hand rules: fixed angle — never rotate or mirror the sprite (a finished stroke must not
  park the hand; only actively-drawing strokes hold it); the tip anchors on the INK FRONT
  (newest ink), not the path start. The scribe hand photo (`doodle-scribe/hand-reference.jpg`)
  ships with the skill (author-generated; free to use and redistribute) — build steps copy it
  into the project's assets/ as hand-new.jpg. Users may swap in their own hand photo via the
  per-hand calibration table (tip/rot/len per file).
- Decorative lines must read hand-drawn: bowed curves (qbez), wobble amp ~2.4–3.4, ink
  pooling, placed in speech gaps; labels letter-by-letter.
