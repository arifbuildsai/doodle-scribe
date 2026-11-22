#!/usr/bin/env node
/**
 * svg2strokes.mjs — convert stroke-based SVGs (Openmoji-style line art) into
 * pen strokes for the scribe engine. Emits a global `window.STROKES` map.
 *
 * Usage: node svg2strokes.mjs <out-strokes.js> <name1=svg1> [name2=svg2 ...]
 * Each SVG must be stroke-based (fill="none" stroke="#000"). Filled silhouettes
 * (e.g. many SVG Repo icons) are NOT drawable in stroke order — prefer line art.
 *
 * Source tracking: write assets/SOURCES.md with name -> source + license.
 */
import fs from 'node:fs';

// ---------- minimal SVG geometry extraction ----------
const NS = 'http://www.w3.org/2000/svg';

function viewBoxOf(svgText) {
  const m = svgText.match(/viewBox="([\d.\-\s]+)"/);
  if (m) {
    const n = m[1].trim().split(/[\s,]+/).map(Number);
    return { x: n[0], y: n[1], w: n[2], h: n[3] };
  }
  const w = svgText.match(/\bwidth="([\d.]+)"/), h = svgText.match(/\bheight="([\d.]+)"/);
  return { x: 0, y: 0, w: w ? +w[1] : 100, h: h ? +h[1] : 100 };
}

/** Flatten an SVG path `d` string into polyline points. */
function flattenPath(d, steps = 24) {
  const toks = d.match(/[MmLlHhVvCcSsQqTtAaZz]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) || [];
  let i = 0, cx = 0, cy = 0, sx = 0, sy = 0, cmd = '';
  const pts = [];
  const num = () => parseFloat(toks[i++]);
  const push = (x, y) => pts.push([x, y]);
  const bez = (p0, p1, p2, p3, n = steps) => {
    for (let k = 1; k <= n; k++) {
      const t = k / n, u = 1 - t;
      push(
        u*u*u*p0[0] + 3*u*u*t*p1[0] + 3*u*t*t*p2[0] + t*t*t*p3[0],
        u*u*u*p0[1] + 3*u*u*t*p1[1] + 3*u*t*t*p2[1] + t*t*t*p3[1]
      );
    }
  };
  const quad = (p0, p1, p2, n = 16) => {
    for (let k = 1; k <= n; k++) {
      const t = k / n, u = 1 - t;
      push(u*u*p0[0] + 2*u*t*p1[0] + t*t*p2[0], u*u*p0[1] + 2*u*t*p1[1] + t*t*p2[1]);
    }
  };
  while (i < toks.length) {
    if (/[A-Za-z]/.test(toks[i])) cmd = toks[i++];
    const rel = cmd === cmd.toLowerCase() && cmd !== 'Z' && cmd !== 'z';
    const C = cmd.toUpperCase();
    if (C === 'M') {
      let x = num(), y = num();
      if (rel) { x += cx; y += cy; }
      cx = sx = x; cy = sy = y; push(cx, cy);
      // implicit lineto after moveto
      cmd = rel ? 'l' : 'L';
    } else if (C === 'L') {
      let x = num(), y = num();
      if (rel) { x += cx; y += cy; }
      push(cx = x, cy = y);
    } else if (C === 'H') {
      let x = num(); if (rel) x += cx;
      push(cx = x, cy);
    } else if (C === 'V') {
      let y = num(); if (rel) y += cy;
      push(cx, cy = y);
    } else if (C === 'C') {
      const x1 = num(), y1 = num(), x2 = num(), y2 = num(), x = num(), y = num();
      let X1 = x1, Y1 = y1, X2 = x2, Y2 = y2, X = x, Y = y;
      if (rel) { X1 += cx; Y1 += cy; X2 += cx; Y2 += cy; X += cx; Y += cy; }
      bez([cx, cy], [X1, Y1], [X2, Y2], [X, Y]);
      cx = X; cy = Y;
    } else if (C === 'S') {
      const x2 = num(), y2 = num(), x = num(), y = num();
      let X2 = x2, Y2 = y2, X = x, Y = y;
      if (rel) { X2 += cx; Y2 += cy; X += cx; Y += cy; }
      // reflect previous control point
      const prev = pts.length > 1 ? pts[pts.length - 1] : [cx, cy];
      const c1 = [prev[0] + (prev[0] - cx), prev[1] + (prev[1] - cy)]; // approximation
      bez([cx, cy], c1, [X2, Y2], [X, Y]);
      cx = X; cy = Y;
    } else if (C === 'Q') {
      const x1 = num(), y1 = num(), x = num(), y = num();
      let X1 = x1, Y1 = y1, X = x, Y = y;
      if (rel) { X1 += cx; Y1 += cy; X += cx; Y += cy; }
      quad([cx, cy], [X1, Y1], [X, Y]);
      cx = X; cy = Y;
    } else if (C === 'T') {
      const x = num(), y = num();
      let X = x, Y = y;
      if (rel) { X += cx; Y += cy; }
      const prev = pts.length > 1 ? pts[pts.length - 1] : [cx, cy];
      const c1 = [prev[0] + (prev[0] - cx), prev[1] + (prev[1] - cy)];
      quad([cx, cy], c1, [X, Y]);
      cx = X; cy = Y;
    } else if (C === 'A') {
      const rx = num(), ry = num(), rot = num(), laf = num(), sf = num(), x = num(), y = num();
      let X = x, Y = y;
      if (rel) { X += cx; Y += cy; }
      // endpoint->center parameterization (SVG spec), then sample
      const phi = rot * Math.PI / 180;
      const cos = Math.cos(phi), sin = Math.sin(phi);
      const dx = (cx - X) / 2, dy = (cy - Y) / 2;
      const x1p = cos * dx + sin * dy, y1p = -sin * dx + cos * dy;
      const rx2 = rx*rx, ry2 = ry*ry, x1p2 = x1p*x1p, y1p2 = y1p*y1p;
      let k = Math.sqrt(Math.max(0, (rx2*ry2 - rx2*y1p2 - ry2*x1p2) / (rx2*y1p2 + ry2*x1p2)));
      if (laf === sf) k = -k;
      const cxp = k * rx * y1p / ry, cyp = -k * ry * x1p / rx;
      const cx0 = cos * cxp - sin * cyp + (cx + X) / 2;
      const cy0 = sin * cxp + cos * cyp + (cy + Y) / 2;
      const ang = (ux, uy) => Math.atan2(uy, ux);
      const ux0 = (x1p - cxp) / rx, uy0 = (y1p - cyp) / ry;
      const ux1 = (-x1p - cxp) / rx, uy1 = (-y1p - cyp) / ry;
      let a0 = ang(ux0, uy0), a1 = ang(ux1, uy1);
      if (!sf && a1 - a0 < 0) a1 += 2 * Math.PI;
      else if (sf && a1 - a0 > 0) a1 -= 2 * Math.PI;
      const n = Math.max(8, Math.ceil(Math.abs(a1 - a0) / (Math.PI / 16)));
      for (let s = 1; s <= n; s++) {
        const a = a0 + (a1 - a0) * s / n;
        push(cx0 + rx * Math.cos(a) * cos - ry * Math.sin(a) * sin,
             cy0 + rx * Math.cos(a) * sin + ry * Math.sin(a) * cos);
      }
      cx = X; cy = Y;
    } else if (C === 'Z') {
      push(sx, sy); cx = sx; cy = sy;
      if (/[A-Za-z]/.test(toks[i] || '')) cmd = '';
    }
  }
  return pts;
}

/** Parse one SVG file into an array of strokes (point arrays). */
function parseSvg(text) {
  const vb = viewBoxOf(text);
  const strokes = [];
  // only elements that carry visible stroke attributes (Openmoji `#line` layer etc.)
  const els = [...text.matchAll(/<(line|path|circle|ellipse|rect|polyline|polygon)\b[^>]*\/?>/g)];
  for (const m of els) {
    const tag = m[1], attrs = m[0];
    const fillNone = /fill="none"/.test(attrs);
    const hasStroke = /stroke="(?!none)[^"]*"/.test(attrs) || /stroke="/.test(attrs) && !/stroke="none"/.test(attrs);
    // keep an element if it is a stroke (fill:none + stroke) — line-art layers
    if (!(fillNone && hasStroke)) continue;
    let pts = null;
    if (tag === 'line') {
      pts = [[+attrs.match(/x1="([-\d.]+)"/)?.[1] || 0, +attrs.match(/y1="([-\d.]+)"/)?.[1] || 0],
             [+attrs.match(/x2="([-\d.]+)"/)?.[1] || 0, +attrs.match(/y2="([-\d.]+)"/)?.[1] || 0]];
    } else if (tag === 'path') {
      const d = attrs.match(/ d="([^"]+)"/)?.[1];
      if (d) pts = flattenPath(d);
    } else if (tag === 'circle' || tag === 'ellipse') {
      const cx = +attrs.match(/cx="([-\d.]+)"/)?.[1], cy = +attrs.match(/cy="([-\d.]+)"/)?.[1];
      const rx = +(attrs.match(/r="([-\d.]+)"/) || attrs.match(/rx="([-\d.]+)"/))?.[1];
      const ry = tag === 'circle' ? rx : +attrs.match(/ry="([-\d.]+)"/)?.[1];
      pts = [];
      for (let a = 0; a <= 64; a++) pts.push([cx + rx * Math.cos(a / 64 * 2 * Math.PI), cy + ry * Math.sin(a / 64 * 2 * Math.PI)]);
    } else if (tag === 'rect') {
      const x = +attrs.match(/x="([-\d.]+)"/)?.[1], y = +attrs.match(/y="([-\d.]+)"/)?.[1];
      const w = +attrs.match(/width="([-\d.]+)"/)?.[1], h = +attrs.match(/height="([-\d.]+)"/)?.[1];
      pts = [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]];
    } else if (tag === 'polyline' || tag === 'polygon') {
      const p = attrs.match(/points="([^"]+)"/)?.[1];
      if (p) {
        const n = p.trim().split(/[\s,]+/).map(Number);
        pts = [];
        for (let k = 0; k + 1 < n.length; k += 2) pts.push([n[k], n[k + 1]]);
        if (tag === 'polygon') pts.push(pts[0]);
      }
    }
    if (pts && pts.length > 1) strokes.push(pts);
  }
  return { vb, strokes };
}

// ---------- main ----------
const [out, ...pairs] = process.argv.slice(2);
if (!out || pairs.length === 0) { console.error('usage: svg2strokes.mjs <out.js> name=svg [...]'); process.exit(1); }
const result = {};
for (const p of pairs) {
  const eq = p.indexOf('=');
  const name = p.slice(0, eq), file = p.slice(eq + 1);
  const { vb, strokes } = parseSvg(fs.readFileSync(file, 'utf8'));
  if (!strokes.length) { console.error(`WARN: no strokes in ${file} (${name})`); continue; }
  result[name] = { vb, strokes };
  const lens = strokes.reduce((a, s) => a + s.length, 0);
  console.log(`${name}: ${strokes.length} strokes, ${lens} points, viewBox ${vb.w}x${vb.h}`);
}
const js = `// generated by svg2strokes.mjs — line-art stroke data for the scribe engine\nwindow.STROKES = ${JSON.stringify(result)};\n`;
fs.writeFileSync(out, js);
console.log(`wrote ${out} (${(js.length / 1024).toFixed(1)} KB)`);
