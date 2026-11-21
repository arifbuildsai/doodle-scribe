#!/usr/bin/env node
// Headless-Chrome frame renderer for the whiteboard-explainer skill.
//
// Usage:
//   node render.js --page <player.html> --out <final.mp4> [--vo <VO.wav>] [--fps 30] [--limit N] [--keep]
//
// Requires: puppeteer installed in the current project (`npm i puppeteer` — no browser download needed,
// it uses the system Chrome), ffmpeg on PATH, and a network connection for Google Fonts.
// The page must expose window.seek(t), window.SB_DURATION, window.scoreSound and set window.__ready.
//
// Steps: capture every frame off the canvas -> silent mp4; render the effects score offline -> fx.wav;
// mux video + voiceover + (sidechain-ducked) effects -> final mp4.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > -1 && i + 1 < process.argv.length ? process.argv[i + 1] : d; };
const has = (k) => process.argv.includes('--' + k);

const pagePath = path.resolve(arg('page', 'why-sky-blue.html'));
const OUT = path.resolve(arg('out', 'out.mp4'));
const VO = arg('vo') ? path.resolve(arg('vo')) : null;
const FPS = +arg('fps', 30);
const LIMIT = +arg('limit', 0); // >0 renders only the first N frames (smoke test)
const WORK = has('keep') ? path.dirname(OUT) : fs.mkdtempSync(path.join(os.tmpdir(), 'wb-render-'));

// puppeteer resolution: current project first, then skill dir, then global
function loadPuppeteer() {
  for (const base of [process.cwd(), __dirname, path.dirname(__dirname)]) {
    try { return require(require.resolve('puppeteer', { paths: [base, path.join(base, 'node_modules')] })); } catch (e) {}
  }
  console.error('puppeteer not found — run:  npm i puppeteer   in the project directory');
  process.exit(1);
}
const puppeteer = loadPuppeteer();

async function launch() {
  // Chrome resolution: puppeteer's channel first, then common system paths, then bundled Chromium
  const CHROME_PATHS = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ];
  const chromeFallback = CHROME_PATHS.find((p) => fs.existsSync(p));
  for (const opts of [{ channel: 'chrome' }, ...(chromeFallback ? [{ executablePath: chromeFallback }] : []), {}]) {
    try { return await puppeteer.launch({ ...opts, headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--autoplay-policy=no-user-gesture-required', '--allow-file-access-from-files'] }); } catch (e) {}
  }
  throw new Error('no Chrome found');
}

(async () => {
  const browser = await launch();
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
  await page.goto('file://' + pagePath, { waitUntil: 'networkidle0', timeout: 60000 });
  await page.waitForFunction('window.__ready === true', { timeout: 30000 });
  await page.evaluate('window.__renderMode = true');

  const DUR = await page.evaluate('window.SB_DURATION ?? window.DS_DURATION ?? window.DURATION');
  const N = LIMIT > 0 ? Math.min(LIMIT, Math.round(DUR * FPS)) : Math.round(DUR * FPS);
  console.log('duration', DUR, '| frames', N, '| fps', FPS, '| vo', VO || 'none');

  // ---- video
  const silent = path.join(WORK, 'video_silent.mp4');
  const ffV = spawn('ffmpeg', ['-y', '-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', String(FPS), '-i', 'pipe:0',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', silent],
    { stdio: ['pipe', 'ignore', 'inherit'] });
  const t0 = Date.now();
  for (let i = 0; i < N; i++) {
    const b64 = await page.evaluate((t) => {
      window.seek(t);
      return document.getElementById('cv').toDataURL('image/jpeg', 0.93).split(',')[1];
    }, i / FPS);
    await new Promise((res) => ffV.stdin.write(Buffer.from(b64, 'base64'), res));
    if (i % 100 === 0) console.log('frame', i, '/', N, Math.round((Date.now() - t0) / 1000) + 's');
  }
  ffV.stdin.end();
  await new Promise((res) => ffV.on('close', res));
  console.log('video done', Math.round((Date.now() - t0) / 1000) + 's');
  if (LIMIT > 0) { await browser.close(); fs.copyFileSync(silent, OUT); console.log('smoke test (silent, no mix) ->', OUT); return; }

  // ---- effects score offline (voiceover mode)
  const fx = await page.evaluate(async () => {
    const r = await window.SOUND.renderOffline(window.scoreSound, window.SB_DURATION ?? window.DS_DURATION ?? window.DURATION, 48000, { voiceover: true });
    const b = new Uint8Array(r.inter.buffer);
    let s = '';
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    return { b64: btoa(s), peak: r.peak, frames: r.frames, sr: r.sr };
  });
  console.log('fx peak', fx.peak.toFixed(3));
  const n = fx.frames, sr = fx.sr;
  const fxWav = path.join(WORK, 'fx.wav');
  const wav = Buffer.alloc(44 + n * 4);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + n * 4, 4); wav.write('WAVE', 8);
  wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(sr, 24); wav.writeUInt32LE(sr * 4, 28); wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(n * 4, 40);
  const f32 = new Float32Array(Buffer.from(fx.b64, 'base64').buffer);
  for (let i = 0; i < n * 2; i++) wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, f32[i])) * 32767), 44 + i * 2);
  fs.writeFileSync(fxWav, wav);

  await browser.close();

  // ---- mix: voiceover on top, effects sidechain-ducked under it
  const chain = VO
    ? ['-i', silent, '-i', VO, '-i', fxWav, '-filter_complex',
      '[1:a]aformat=sample_rates=48000:channel_layouts=stereo,loudnorm=I=-17:TP=-2,aresample=48000,asplit=2[v1][v2];' +
      '[2:a]aformat=sample_rates=48000:channel_layouts=stereo,loudnorm=I=-26:TP=-4:LRA=20,aresample=48000[fx0];' +
      '[fx0][v1]sidechaincompress=threshold=0.05:ratio=3:attack=10:release=250[fx];' +
      '[v2][fx]amix=inputs=2:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[a]']
    : ['-i', silent, '-i', fxWav, '-filter_complex', '[1:a]aformat=sample_rates=48000:channel_layouts=stereo[a]'];
  const maps = VO ? ['-map', '0:v', '-map', '[a]'] : ['-map', '0:v', '-map', '[a]'];
  execFileSync('ffmpeg', ['-y', ...chain, ...maps, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', OUT], { stdio: 'inherit' });
  console.log('done ->', OUT);
  if (!has('keep')) console.log('(work files in ' + WORK + ')');
})().catch((e) => { console.error(e); process.exit(1); });
