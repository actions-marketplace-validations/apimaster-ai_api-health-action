# LLM API Health Check — GitHub Action

Monitor any OpenAI-compatible LLM endpoint on a schedule: availability, latency, and
whether the model you asked for is the model that answered.

[![llm api](https://img.shields.io/endpoint?url=https%3A%2F%2Fapimaster-ai.github.io%2Fapi-health-action%2Fbadge.json)](https://github.com/apimaster-ai/api-health-action)

```yaml
- uses: apimaster-ai/api-health-action@v1
  with:
    api-key: ${{ secrets.LLM_API_KEY }}
    base-url: https://apimaster.ai/v1
    models: gpt-5.5, claude-sonnet-4-6
```

Zero dependencies, nothing to install, runs in about a second.

## Why you would want this

If your product calls an LLM gateway — your own, a vendor's, or an aggregator's — you
find out it broke when a user tells you. Three failure modes are common and none of them
show up as a 500:

1. **The catalog moved.** The model id in your config was renamed or removed. Requests
   start failing with a 400 that looks like your bug.
2. **Latency drifted.** Time-to-first-token quietly triples after an upstream change.
3. **The model changed underneath you.** The endpoint answers, but a different (cheaper)
   model is serving the traffic. Output quality drops and nothing in your logs says why.

This action checks all three every N minutes and writes the result to the job summary, a
badge, and an append-only history file you can render as a status page.

## Usage

### Minimal

```yaml
name: llm-health
on:
  schedule: [{ cron: '*/30 * * * *' }]
  workflow_dispatch:

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: apimaster-ai/api-health-action@v1
        with:
          api-key: ${{ secrets.LLM_API_KEY }}
          models: gpt-5.5, claude-sonnet-4-6
```

### With identity checks and a status page

```yaml
jobs:
  check:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4
      - uses: apimaster-ai/api-health-action@v1
        id: health
        with:
          api-key: ${{ secrets.LLM_API_KEY }}
          base-url: https://apimaster.ai/v1
          models: |
            gpt-5.5
            claude-sonnet-4-6
            glm-5.3-flash
          checks: availability,latency,identity
          latency-threshold-ms: 4000
          runs-per-model: 3
          badge-file: public/badge.json
          history-file: public/history.jsonl
          json-file: public/latest.json
          fail-on: error

      - run: node scripts/render-status.js public/history.jsonl > public/index.html
      - uses: peaceiris/actions-gh-pages@v4
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          publish_dir: public
```

`scripts/render-status.js` ships in [`examples/`](examples/).

### Gate a deployment on it

```yaml
- uses: apimaster-ai/api-health-action@v1
  id: health
  with:
    api-key: ${{ secrets.LLM_API_KEY }}
    models: gpt-5.5
    fail-on: degraded          # stop the deploy if latency or identity looks wrong

- if: steps.health.outputs.status != 'ok'
  run: echo "p50 was ${{ steps.health.outputs.p50 }} ms" && exit 1
```

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `api-key` | *(required)* | Pass from a secret. Never inline it. |
| `base-url` | `https://apimaster.ai/v1` | Any OpenAI-compatible base URL, including `/v1` |
| `models` | `''` | Comma- or newline-separated ids. Empty checks only `/models`. |
| `checks` | `availability,latency` | Any of `availability`, `latency`, `identity` |
| `latency-threshold-ms` | `5000` | TTFT p50 above this marks the model degraded |
| `runs-per-model` | `2` | More runs means a steadier p50 and a better identity signal |
| `max-tokens` | `256` | Do not go below ~128: reasoning models spend the budget before emitting text |
| `fail-on` | `error` | `error` · `degraded` · `never` |
| `summary` | `true` | Write the table to the job summary |
| `badge-file` | `''` | Path for a shields.io endpoint JSON |
| `history-file` | `''` | Append one JSON line per run |
| `json-file` | `''` | Full report as JSON |
| `timeout-ms` | `60000` | Per-request timeout |

## Outputs

| Output | Description |
| --- | --- |
| `status` | `ok` · `degraded` · `down` |
| `p50` | Median TTFT across successful probes, in ms |
| `failures` | Number of failed probes |
| `models-available` | Model count returned by `/models` |
| `results` | Full JSON report |

## What the identity check actually does

Three deterministic probes, reported as warnings rather than a verdict:

- **Echo** — compares the `model` field in the response with the id you requested.
- **Determinism** — sends the same `temperature: 0` prompt `runs-per-model` times. A
  single backend gives one answer; a pool that rotates between different models does not.
- **Correctness floor** — a prompt with exactly one right answer. A frontier model gets
  it right every time; a much smaller substitute often does not.

None of this proves authenticity, and the action does not claim it does. It catches the
failure modes that actually happen in production.

## Cost

With the defaults (2 runs × 256 max tokens per model), a 30-minute schedule costs at most
about 25k output tokens per model per day — usually far less, since the probe answer is
short and the budget is a ceiling, not a bill. Use `checks: availability` and
`runs-per-model: 1` if you want it cheaper.

**Do not lower `max-tokens` below ~128.** Most models on a modern gateway are reasoning
models: they spend completion tokens on hidden reasoning before emitting any visible
text. Measured on one gateway, a model given 64 tokens spent 59 on reasoning and returned
an empty string — which the identity check would otherwise score as a wrong answer, so
your monitor would report a healthy model as degraded every half hour.

## Works with

Any OpenAI-compatible endpoint: OpenAI, Azure OpenAI, [APIMaster](https://apimaster.ai/docs),
OpenRouter, Together, Groq, vLLM, Ollama, LiteLLM, your own gateway. Point `base-url` at it.

## Development

```bash
node test/mock-server.js 8787 ok &          # modes: ok slow flaky wrong-model nondeterministic down
INPUT_API_KEY=k INPUT_BASE_URL=http://127.0.0.1:8787/v1 \
INPUT_MODELS=gpt-5.5 INPUT_CHECKS=availability,latency,identity \
node src/index.js
```

## License

MIT
