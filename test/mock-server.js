/**
 * Minimal OpenAI-compatible mock, used to exercise the action without spending tokens.
 *
 *   node test/mock-server.js [port] [mode]
 *
 * modes: ok | slow | flaky | wrong-model | nondeterministic | down
 */
'use strict';

const http = require('node:http');

const port = Number(process.argv[2] || 8787);
const mode = process.argv[3] || 'ok';

const PRIMES = '2 3 5 7 11 13 17 19';

function sse(res, model, text, delayMs) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const tokens = text.split(' ');
  let i = 0;
  const tick = () => {
    if (i >= tokens.length) {
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    const chunk = {
      id: 'chatcmpl-mock',
      object: 'chat.completion.chunk',
      model,
      choices: [{ index: 0, delta: { content: (i ? ' ' : '') + tokens[i] } }],
    };
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    i += 1;
    setTimeout(tick, 5);
  };
  setTimeout(tick, delayMs);
}

const server = http.createServer((req, res) => {
  if (mode === 'down') {
    res.writeHead(503).end('{"error":{"message":"upstream unavailable"}}');
    return;
  }
  if (req.url.startsWith('/v1/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        object: 'list',
        data: [
          { id: 'gpt-5.5', object: 'model', owned_by: 'mock' },
          { id: 'claude-sonnet-4-6', object: 'model', owned_by: 'mock' },
          { id: 'gpt-image-2', object: 'model', owned_by: 'mock' },
          { id: 'sora-2', object: 'model', owned_by: 'mock' },
        ],
      })
    );
    return;
  }
  if (req.url.startsWith('/v1/chat/completions')) {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      const requested = parsed.model;
      if (mode === 'flaky' && Math.random() < 0.5) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end('{"error":{"message":"rate limited"}}');
        return;
      }
      const model = mode === 'wrong-model' ? 'some-cheap-substitute' : requested;
      const text =
        mode === 'nondeterministic'
          ? `${PRIMES} ${Math.random().toString(36).slice(2, 6)}`
          : PRIMES;
      const delay = mode === 'slow' ? 1200 : 20;
      if (!parsed.stream) {
        setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 'chatcmpl-mock',
              object: 'chat.completion',
              model,
              choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
            })
          );
        }, delay);
        return;
      }
      sse(res, model, text, delay);
    });
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end('{"error":{"message":"not found"}}');
});

server.listen(port, () => {
  console.log(`mock endpoint on http://127.0.0.1:${port}/v1 (mode: ${mode})`);
});
