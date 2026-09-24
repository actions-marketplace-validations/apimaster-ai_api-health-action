#!/usr/bin/env node
/**
 * LLM API Health Check — GitHub Action entrypoint.
 *
 * Deliberately dependency-free and single-file: an action that installs nothing
 * starts in ~1s and cannot break because of a transitive dependency.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const input = (name, fallback = '') => {
  const v = process.env[`INPUT_${name.toUpperCase().replace(/-/g, '_')}`];
  return v === undefined || v === '' ? fallback : v;
};

const CONFIG = {
  key: input('api-key'),
  baseUrl: input('base-url', 'https://apimaster.ai/v1').replace(/\/+$/, ''),
  models: input('models')
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean),
  checks: input('checks', 'availability,latency')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  latencyThreshold: Number(input('latency-threshold-ms', '5000')),
  runs: Math.max(1, Number(input('runs-per-model', '2'))),
  maxTokens: Number(input('max-tokens', '256')),
  failOn: input('fail-on', 'error'),
  summary: input('summary', 'true') === 'true',
  badgeFile: input('badge-file'),
  historyFile: input('history-file'),
  jsonFile: input('json-file'),
  timeout: Number(input('timeout-ms', '60000')),
};

const DET_PROMPT = 'List the first 8 prime numbers separated by single spaces. Output only the numbers.';
const PRIMES = '2 3 5 7 11 13 17 19';

function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  if (!file) {
    console.log(`::set-output-fallback:: ${name}=${serialized}`);
    return;
  }
  // Multi-line values need the delimiter form.
  const delimiter = `ghadelim_${Math.random().toString(36).slice(2)}`;
  fs.appendFileSync(file, `${name}<<${delimiter}\n${serialized}\n${delimiter}\n`);
}

function writeSummary(markdown) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) fs.appendFileSync(file, markdown + '\n');
  else console.log(markdown);
}

function ensureDir(file) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

async function request(url, options = {}) {
  const started = Date.now();
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${CONFIG.key}`,
      'Content-Type': 'application/json',
      'User-Agent': 'api-health-action',
      ...options.headers,
    },
    signal: AbortSignal.timeout(CONFIG.timeout),
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { ok: res.ok, status: res.status, data, ms: Date.now() - started };
}

async function checkModelList() {
  try {
    const res = await request(`${CONFIG.baseUrl}/models`);
    if (!res.ok) {
      return { ok: false, status: res.status, ms: res.ms, error: `HTTP ${res.status}`, count: 0 };
    }
    const ids = (res.data?.data || []).map((m) => m.id);
    return { ok: true, status: res.status, ms: res.ms, count: ids.length, ids };
  } catch (err) {
    return { ok: false, error: String(err.message).slice(0, 200), count: 0 };
  }
}

/** One streaming completion, measuring time to first token. */
async function probeModel(model) {
  const started = Date.now();
  let res;
  try {
    res = await fetch(`${CONFIG.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${CONFIG.key}`,
        'Content-Type': 'application/json',
        'User-Agent': 'api-health-action',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: DET_PROMPT }],
        max_tokens: CONFIG.maxTokens,
        temperature: 0,
        stream: true,
      }),
      signal: AbortSignal.timeout(CONFIG.timeout),
    });
  } catch (err) {
    return { ok: false, error: String(err.message).slice(0, 160) };
  }
  if (!res.ok) {
    const body = await res.text();
    return {
      ok: false,
      status: res.status,
      error: `HTTP ${res.status} ${body.slice(0, 120)}`,
    };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let ttft = null;
  let text = '';
  let echoed = null;
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const json = JSON.parse(payload);
        echoed = echoed ?? json.model ?? null;
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) {
          if (ttft === null) ttft = Date.now() - started;
          text += delta;
        }
      } catch {
        /* partial frame */
      }
    }
  }
  return {
    ok: true,
    ttft: ttft ?? Date.now() - started,
    total: Date.now() - started,
    echoed,
    text: text.trim(),
    // Streaming gives us no usage block, so infer the reasoning case: the stream
    // completed but never produced visible content. With a small max-tokens that is
    // what a reasoning model looks like, and scoring it as a wrong answer produces
    // false alarms on a schedule.
    emptyOutput: text.trim() === '',
  };
}

async function checkModel(model) {
  const samples = [];
  for (let i = 0; i < CONFIG.runs; i += 1) {
    samples.push(await probeModel(model));
  }
  const good = samples.filter((s) => s.ok);
  const failed = samples.filter((s) => !s.ok);
  const result = {
    model,
    runs: samples.length,
    ok: good.length > 0,
    failures: failed.length,
    error: failed[0]?.error ?? null,
    ttft_p50: good.length ? median(good.map((s) => s.ttft)) : null,
    total_p50: good.length ? median(good.map((s) => s.total)) : null,
    issues: [],
  };

  if (!good.length) {
    result.issues.push({ level: 'down', text: result.error ?? 'all probes failed' });
    return result;
  }
  if (failed.length) {
    result.issues.push({ level: 'degraded', text: `${failed.length}/${samples.length} probes failed` });
  }
  if (CONFIG.checks.includes('latency') && result.ttft_p50 > CONFIG.latencyThreshold) {
    result.issues.push({
      level: 'degraded',
      text: `TTFT p50 ${result.ttft_p50} ms over the ${CONFIG.latencyThreshold} ms threshold`,
    });
  }
  if (CONFIG.checks.includes('identity')) {
    const echoes = [...new Set(good.map((s) => s.echoed).filter(Boolean))];
    if (echoes.length > 1) {
      result.issues.push({ level: 'degraded', text: `responses echoed multiple ids: ${echoes.join(', ')}` });
    } else if (echoes[0] && echoes[0] !== model) {
      result.issues.push({ level: 'degraded', text: `requested ${model}, endpoint echoed ${echoes[0]}` });
    }
    // Runs that produced no visible text cannot be judged for correctness or
    // determinism: the budget went to reasoning tokens before the answer started.
    const judged = good.filter((s) => !s.emptyOutput);
    const empty = good.length - judged.length;
    const answers = [
      ...new Set(judged.map((s) => s.text.replace(/[^\d ]/g, '').replace(/\s+/g, ' ').trim())),
    ];
    const correct = judged.filter((s) =>
      s.text.replace(/[^\d ]/g, '').replace(/\s+/g, ' ').trim().includes(PRIMES)
    ).length;
    result.identity = {
      echoes,
      distinctAnswers: answers.length,
      correct,
      of: judged.length,
      emptyOutputs: empty,
    };
    if (empty === good.length) {
      result.issues.push({
        level: 'degraded',
        text: `all ${empty} probes returned no text — raise max-tokens, reasoning models spend the budget before answering`,
      });
    }
    if (answers.length > 1) {
      result.issues.push({
        level: 'degraded',
        text: `${answers.length} different answers to an identical temperature-0 prompt`,
      });
    }
    if (judged.length && correct === 0) {
      result.issues.push({ level: 'degraded', text: 'deterministic prime probe answered incorrectly every time' });
    }
  }
  return result;
}

function renderSummary(report) {
  const icon = { ok: '🟢', degraded: '🟡', down: '🔴' };
  const lines = [];
  lines.push(`## ${icon[report.status]} LLM API health — \`${report.status}\``);
  lines.push('');
  lines.push(`Endpoint: \`${report.baseUrl}\` · ${report.checkedAt}`);
  lines.push('');
  lines.push(
    `Model list: ${report.modelList.ok ? `✅ ${report.modelList.count} models in ${report.modelList.ms} ms` : `❌ ${report.modelList.error}`}`
  );
  if (report.models.length) {
    lines.push('');
    lines.push('| Model | Status | TTFT p50 | Total p50 | Notes |');
    lines.push('| --- | --- | ---: | ---: | --- |');
    for (const m of report.models) {
      const status = !m.ok ? '🔴 down' : m.issues.length ? '🟡 degraded' : '🟢 ok';
      lines.push(
        `| \`${m.model}\` | ${status} | ${m.ttft_p50 ?? '—'} ms | ${m.total_p50 ?? '—'} ms | ${
          m.issues.map((i) => i.text).join('; ') || ''
        } |`
      );
    }
  }
  lines.push('');
  lines.push(
    `<sub>Generated by [api-health-action](https://github.com/apimaster-ai/api-health-action) — ${report.runs} run(s) per model, max_tokens=${report.maxTokens}.</sub>`
  );
  return lines.join('\n');
}

function badgeFor(report) {
  const color = { ok: 'brightgreen', degraded: 'yellow', down: 'red' }[report.status];
  const message =
    report.status === 'down'
      ? 'down'
      : report.p50
        ? `${report.status} · ${report.p50} ms`
        : report.status;
  return { schemaVersion: 1, label: 'llm api', message, color };
}

async function main() {
  if (!CONFIG.key) {
    console.error('::error::api-key input is empty. Pass it from a secret.');
    process.exit(1);
  }

  const report = {
    baseUrl: CONFIG.baseUrl,
    checkedAt: new Date().toISOString(),
    checks: CONFIG.checks,
    runs: CONFIG.runs,
    maxTokens: CONFIG.maxTokens,
    modelList: await checkModelList(),
    models: [],
  };

  for (const model of CONFIG.models) {
    report.models.push(await checkModel(model));
  }

  const ttfts = report.models.filter((m) => m.ttft_p50 != null).map((m) => m.ttft_p50);
  report.p50 = median(ttfts);
  report.failures = report.models.filter((m) => !m.ok).length + (report.modelList.ok ? 0 : 1);

  const anyDown = !report.modelList.ok || report.models.some((m) => !m.ok);
  const anyDegraded = report.models.some((m) => m.issues.length > 0);
  report.status = anyDown ? 'down' : anyDegraded ? 'degraded' : 'ok';

  if (CONFIG.summary) writeSummary(renderSummary(report));

  if (CONFIG.jsonFile) {
    ensureDir(CONFIG.jsonFile);
    fs.writeFileSync(CONFIG.jsonFile, JSON.stringify(report, null, 2));
  }
  if (CONFIG.badgeFile) {
    ensureDir(CONFIG.badgeFile);
    fs.writeFileSync(CONFIG.badgeFile, JSON.stringify(badgeFor(report)));
  }
  if (CONFIG.historyFile) {
    ensureDir(CONFIG.historyFile);
    const row = {
      t: report.checkedAt,
      status: report.status,
      p50: report.p50,
      models: Object.fromEntries(
        report.models.map((m) => [m.model, { ok: m.ok, ttft: m.ttft_p50, issues: m.issues.length }])
      ),
    };
    fs.appendFileSync(CONFIG.historyFile, JSON.stringify(row) + '\n');
  }

  setOutput('status', report.status);
  setOutput('results', JSON.stringify(report));
  setOutput('p50', String(report.p50 ?? ''));
  setOutput('failures', String(report.failures));
  setOutput('models-available', String(report.modelList.count ?? 0));

  for (const m of report.models) {
    for (const issue of m.issues) {
      const level = issue.level === 'down' ? 'error' : 'warning';
      console.log(`::${level}::${m.model}: ${issue.text}`);
    }
  }
  if (!report.modelList.ok) {
    console.log(`::error::model list unreachable: ${report.modelList.error}`);
  }

  console.log(`status=${report.status} p50=${report.p50 ?? 'n/a'}ms failures=${report.failures}`);

  if (CONFIG.failOn === 'never') return;
  if (CONFIG.failOn === 'degraded' && report.status !== 'ok') process.exit(1);
  if (report.status === 'down') process.exit(1);
}

main().catch((err) => {
  console.log(`::error::${String(err.stack || err).slice(0, 500)}`);
  process.exit(1);
});
