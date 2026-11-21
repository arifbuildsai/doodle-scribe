#!/usr/bin/env node
// ElevenLabs voiceover generator for the doodle-scribe skill.
//
// Usage:  node tts.mjs <script.txt> <outdir> [--voice <id-or-name-substring>] [--model <model_id>]
//         (or pipe the script in on stdin: echo "..." | node tts.mjs <outdir>)
//
// Env:    ELEVENLABS_API_KEY (required)
//
// Writes into <outdir>:
//   VO.wav        44.1 kHz mono WAV (the pipeline's canonical voiceover; converted via ffmpeg)
//   VO.mp3        the raw ElevenLabs mp3 (kept as backup; only when mp3 output was used)
//   WORDS.tsv     line, i, start, end, word  — word-level timestamps for the take
//   vo_meta.json  { duration, voice, model, format }
//
// The script text format: one line per voiceover line; blank lines become pauses.
// Line numbers in WORDS.tsv refer to the non-empty lines of the script, in order.

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

const API = 'https://api.elevenlabs.io/v1';
// Default voice: a public ElevenLabs preset ("Alice"). Override with --voice <id|name>
// or set ELEVENLABS_VOICE_ID. Instant voice clones require a plan that permits them.
const DEFAULT_VOICE = process.env.ELEVENLABS_VOICE_ID || 'Xb7hH8MSUJpSbSDYk0k2';
const DEFAULT_MODEL = 'eleven_multilingual_v2';
const KEY = process.env.ELEVENLABS_API_KEY;
if (!KEY) { console.error('ELEVENLABS_API_KEY is not set'); process.exit(1); }

// ---- args
const argv = process.argv.slice(2);
let scriptPath = null, outDir = null, voiceArg = null, model = DEFAULT_MODEL;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--voice') voiceArg = argv[++i];
  else if (argv[i] === '--model') model = argv[++i];
  else if (!scriptPath) scriptPath = argv[i];
  else if (!outDir) outDir = argv[i];
}
if (!outDir) { console.error('usage: node tts.mjs <script.txt|-> <outdir> [--voice id|name] [--model id]'); process.exit(1); }
const scriptText = scriptPath && scriptPath !== '-'
  ? fs.readFileSync(scriptPath, 'utf8')
  : fs.readFileSync(0, 'utf8'); // stdin

// ---- voice resolution: exact id, else substring match on the account's voice list
async function resolveVoice() {
  if (!voiceArg) return DEFAULT_VOICE;
  if (/^[A-Za-z0-9]{20}$/.test(voiceArg)) return voiceArg;
  const res = await fetch(API + '/voices', { headers: { 'xi-api-key': KEY } });
  const j = await res.json();
  const v = (j.voices || []).find((v) => v.name.toLowerCase().includes(voiceArg.toLowerCase()));
  if (!v) { console.error('voice not found: ' + voiceArg); process.exit(1); }
  return v.voice_id;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function generate(voiceId) {
  const text = scriptText.replace(/\r/g, '');
  // pcm is Pro-tier only; mp3_44100_128 works on lower tiers. Try pcm first for best quality.
  for (const format of ['pcm_44100', 'mp3_44100_128']) {
    const res = await fetch(`${API}/text-to-speech/${voiceId}/with-timestamps?output_format=${format}`, {
      method: 'POST',
      headers: { 'xi-api-key': KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ text, model_id: model }),
    });
    const j = await res.json().catch(() => ({}));
    if (res.ok && j.audio_base64) return { format, j };
    if (res.status === 429) { console.error('rate limited, retrying...'); await sleep(6000); continue; }
    const code = j.detail && j.detail.code;
    const st = j.detail && j.detail.status;
    if (code === 'subscription_required' || st === 'output_format_not_allowed') continue; // tier restriction -> next format
    console.error('ElevenLabs error', res.status, JSON.stringify(j.detail || j).slice(0, 300));
    process.exit(1);
  }
  console.error('all output formats failed');
  process.exit(1);
}

// ---- word timestamps from the character alignment (words keep their punctuation, like WORDS.tsv)
function wordsFromAlignment(j) {
  const a = j.alignment || j.normalized_alignment;
  if (!a) return [];
  const words = [];
  let line = 1, wi = 0, cur = null;
  const flush = () => { if (cur) { words.push({ line, i: wi++, start: cur.s, end: cur.e, word: cur.w }); cur = null; } };
  for (let k = 0; k < a.characters.length; k++) {
    const ch = a.characters[k], s = a.character_start_times_seconds[k], e = a.character_end_times_seconds[k];
    if (ch === '\n' || ch === '\r') { flush(); if (ch === '\n') line++; continue; } // next script line
    if (/\s/.test(ch)) { flush(); continue; }
    if (/[.,!?;:—…]/.test(ch) && cur) { cur.w += ch; cur.e = e; flush(); continue; } // punctuation ends the word
    cur = cur ? { w: cur.w + ch, s: cur.s, e } : { w: ch, s, e };
  }
  flush();
  return words;
}

async function main() {
  const voiceId = await resolveVoice();
  console.log('voice:', voiceId, '| model:', model);
  const { format, j } = await generate(voiceId);
  fs.mkdirSync(outDir, { recursive: true });

  const audio = Buffer.from(j.audio_base64, 'base64');
  const rawPath = path.join(outDir, format.startsWith('pcm') ? 'raw.pcm' : 'VO.mp3');
  fs.writeFileSync(rawPath, audio);

  // convert to canonical 44.1 kHz WAV (ffmpeg wraps pcm or re-encodes mp3)
  let wav = path.join(outDir, 'VO.wav');
  if (format.startsWith('pcm')) {
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 's16le', '-ar', '44100', '-ac', '1', '-i', rawPath, wav]);
    fs.unlinkSync(rawPath);
  } else {
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', rawPath, wav]);
  }

  const words = wordsFromAlignment(j);
  const lines = [...new Set(words.map((w) => w.line))].sort((a, b) => a - b);
  // renumber lines to consecutive 01.. (script lines without words are skipped)
  const renum = new Map(lines.map((l, k) => [l, k + 1]));
  const dur = words.length ? words[words.length - 1].end : 0;
  fs.writeFileSync(path.join(outDir, 'WORDS.tsv'),
    'line\ti\tstart\tend\tword\n' + words.map((w) =>
      String(renum.get(w.line)).padStart(2, '0') + '\t' + w.i + '\t' + w.start.toFixed(3) + '\t' + w.end.toFixed(3) + '\t' + w.word).join('\n') + '\n');
  fs.writeFileSync(path.join(outDir, 'vo_meta.json'), JSON.stringify({ duration: +dur.toFixed(3), voice: voiceId, model, format, lines: lines.length }, null, 2));

  console.log('VO.wav written | duration', dur.toFixed(2) + 's | words', words.length, '| lines', lines.length);
  console.log('first words:', words.slice(0, 6).map((w) => w.word + '@' + w.start.toFixed(2)).join(' '));
}
main().catch((e) => { console.error(e); process.exit(1); });
