#!/usr/bin/env node
/**
 * Render history.jsonl (written by the action) into a single self-contained status page.
 *
 *   node render-status.js public/history.jsonl > public/index.html
 *
 * No dependencies. The output is plain HTML/CSS so it can be served from GitHub Pages.
 */
'use strict';

const fs = require('node:fs');

const file = process.argv[2];
if (!file) {
  console.error('usage: render-status.js <history.jsonl> [--title "..."]');
  process.exit(1);
}

const titleFlag = process.argv.indexOf('--title');
const TITLE = titleFlag !== -1 ? process.argv[titleFlag + 1] : 'LLM API status';

const rows = fs
  .readFileSync(file, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  })
  .filter(Boolean);

if (!rows.length) {
  console.error('no rows in history file');
  process.exit(1);
}

const recent = rows.slice(-720); // ~15 days at 30-minute intervals
const models = [...new Set(recent.flatMap((r) => Object.keys(r.models ?? {})))];

const uptime = (predicate) => {
  const total = recent.length;
  const good = recent.filter(predicate).length;
  return total ? ((good / total) * 100).toFixed(2) : '—';
};

const latest = recent[recent.length - 1];
const p50s = recent.map((r) => r.p50).filter((v) => typeof v === 'number');
const overallP50 = p50s.length ? Math.round(p50s.sort((a, b) => a - b)[Math.floor(p50s.length / 2)]) : null;

const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);

function ticks(predicate, titleFor) {
  return recent
    .slice(-90)
    .map((r) => {
      const state = predicate(r);
      return `<i class="t ${state}" title="${esc(titleFor(r))}"></i>`;
    })
    .join('');
}

const modelSections = models
  .map((m) => {
    const state = (r) => {
      const entry = r.models?.[m];
      if (!entry) return 'na';
      if (!entry.ok) return 'down';
      return entry.issues ? 'degraded' : 'ok';
    };
    const up = uptime((r) => r.models?.[m]?.ok);
    const lat = recent
      .map((r) => r.models?.[m]?.ttft)
      .filter((v) => typeof v === 'number')
      .sort((a, b) => a - b);
    const p50 = lat.length ? Math.round(lat[Math.floor(lat.length / 2)]) : null;
    return `
      <section class="row">
        <div class="meta">
          <h3>${esc(m)}</h3>
          <p>${up}% availability${p50 ? ` · ${p50} ms TTFT p50` : ''}</p>
        </div>
        <div class="ticks">${ticks(state, (r) => `${r.t} · ${state(r)}`)}</div>
      </section>`;
  })
  .join('');

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(TITLE)}</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #ffffff; --fg: #101215; --muted: #6b7280; --line: #e5e7eb; --card: #fafafa;
    --ok: #16a34a; --degraded: #f59e0b; --down: #dc2626; --na: #d1d5db;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#0d0f12; --fg:#e7e9ea; --muted:#9aa1ab; --line:#23272e; --card:#14171b; --na:#2a2f36; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.55 ui-sans-serif,-apple-system,"Segoe UI",Inter,sans-serif; }
  .wrap { max-width: 820px; margin: 0 auto; padding: 48px 16px 80px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .sub { color: var(--muted); font-size: 13px; margin: 0 0 28px; }
  .hero { display:flex; align-items:center; gap:12px; padding:18px 20px; border:1px solid var(--line); border-radius:12px; background:var(--card); margin-bottom:28px; }
  .dot { width:12px; height:12px; border-radius:50%; flex:none; }
  .dot.ok{background:var(--ok)} .dot.degraded{background:var(--degraded)} .dot.down{background:var(--down)}
  .hero strong { font-size:17px; }
  .hero span { color:var(--muted); font-size:13px; }
  .row { display:flex; gap:16px; align-items:center; justify-content:space-between; padding:14px 0; border-top:1px solid var(--line); flex-wrap:wrap; }
  .meta h3 { margin:0; font-size:14px; font-weight:600; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  .meta p { margin:2px 0 0; color:var(--muted); font-size:12px; }
  .ticks { display:flex; gap:2px; align-items:flex-end; }
  .t { display:block; width:5px; height:26px; border-radius:2px; background:var(--na); }
  .t.ok{background:var(--ok)} .t.degraded{background:var(--degraded)} .t.down{background:var(--down)}
  footer { margin-top:36px; color:var(--muted); font-size:12px; border-top:1px solid var(--line); padding-top:16px; }
  a { color: inherit; }
</style>
</head>
<body>
  <div class="wrap">
    <h1>${esc(TITLE)}</h1>
    <p class="sub">Last checked ${esc(latest.t)} · ${recent.length} samples</p>

    <div class="hero">
      <span class="dot ${esc(latest.status)}"></span>
      <div>
        <strong>${esc(latest.status === 'ok' ? 'All systems operational' : latest.status === 'degraded' ? 'Degraded performance' : 'Outage')}</strong><br>
        <span>${uptime((r) => r.status === 'ok')}% of checks fully healthy${overallP50 ? ` · ${overallP50} ms median TTFT` : ''}</span>
      </div>
    </div>

    ${modelSections}

    <footer>
      Generated by <a href="https://github.com/apimaster-ai/api-health-action">api-health-action</a>.
      Each bar is one scheduled check, oldest on the left.
    </footer>
  </div>
</body>
</html>`;

process.stdout.write(html);
