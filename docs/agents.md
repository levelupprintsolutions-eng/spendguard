# What spendguard enforces

There are two ways a run gets stopped.

**Provider proxy.** `spendguard proxy` is a localhost reverse proxy. The agent's API base URL points at it. The proxy forwards the call, reads the usage the provider returns, and prices it. The call that crosses the cap is already billed. The next call gets HTTP 402 and is not forwarded. `spendguard kill` does the same thing immediately. This works for any process that can set a base URL, including agents and frameworks this repo has never heard of.

**Host hooks.** Claude Code, Codex, Cursor, and Gemini CLI can run a hook before a tool or a model call. The hook can refuse that call. It can only price what that host puts on stdin or in a transcript. When the host does not report tokens, the hook can still honor the kill switch, and a dollar cap does not trip.

Warnings from the proxy are the `x-spendguard-warning` response header and `spendguard status`. They are not written into the model prompt. A hook warning is a `systemMessage` the terminal shows.

| Agent | How you attach it | Enforced | Only monitored, or not seen |
| --- | --- | --- | --- |
| Any HTTP client | `spendguard proxy --provider …` and set the base URL | The next request after the cap or the kill switch. OpenAI, Anthropic, Gemini, and xAI response shapes are parsed, including SSE. | Search-grounding fees and cache-storage fees charged per hour. A response with no usage object is not billed. |
| Claude Code | `spendguard init` | Tool calls, prompts, and the end of a turn, from the JSONL transcript. | One model call can land after the cap because the transcript lags. See the README. |
| Codex CLI | `spendguard init --adapter codex` | Tool denial and ending the turn, once `token_usage` parses. | Unrecognized `token_usage` does not trip a dollar cap. Hosted tools such as WebSearch skip `PreToolUse`. New hooks wait until you trust them. |
| Cursor | `spendguard init --adapter cursor` | The kill switch denies the next tool, shell, read, prompt, or subagent. A dollar cap applies when the transcript is Claude-style JSONL. | Hook payloads have no token counts. Unknown spend does not trip a cap unless `--strict`. |
| Gemini CLI | `spendguard init --adapter gemini` | `BeforeModel` and `BeforeTool` refuse the next call when recorded spend is over the cap, and `continue: false` stops the loop. | `AfterModel` usage is whatever `usageMetadata` contains. A total with no split is priced as output tokens. Streamed chunks that repeat usage can over-count. `AfterAgent` is not told to retry. The proxy is the accurate bill if you can point the CLI's endpoint at it. |
| OpenAI Agents SDK | `OPENAI_BASE_URL=http://127.0.0.1:8791/v1` | Same as the proxy, because the SDK uses the OpenAI client. | A process that still calls `api.openai.com` directly is invisible. |
| LangChain and LangGraph | `ChatOpenAI(base_url=…)` or `ChatAnthropic(anthropic_api_url=…)` | Same as the proxy for that client. | Other model classes (`ChatGoogleGenerativeAI`, Bedrock, Vertex) are covered only when their endpoint is the proxy. |
| CrewAI | `OPENAI_API_BASE` or `OPENAI_BASE_URL` | Same as the proxy for its OpenAI client. | Agents configured with a different provider are covered only if that provider's base URL is the proxy. |
| OpenClaw | Sample in `adapters/openclaw/` | Nothing is installed. | `model_call_ended` does not include token counts. |

## Proxy

One process, one upstream. The default listen address is `127.0.0.1:8791`. Do not publish it past localhost: it forwards your API key and does not store the key.

```bash
spendguard budget set --usd 5
spendguard proxy --provider openai
spendguard proxy --provider anthropic --port 8792
spendguard proxy --provider gemini --port 8793
spendguard proxy --provider xai --port 8794
```

`--upstream` replaces the default host (`https://api.openai.com`, `https://api.anthropic.com`, `https://generativelanguage.googleapis.com`, `https://api.x.ai`). Use it for any other OpenAI-compatible server and pass `--provider openai` or `--provider xai` so the response parser matches. Add the model's prices in `~/.spendguard/prices.json` or the call is priced as the Fable 5.2 fallback and marked estimated.

Send `x-spendguard-session` to keep one agent run on its own cap. Without it, every client of that proxy shares the session id `proxy`. `x-spendguard-project` selects the project cap. The directory you start the proxy in is the default.

A blocked call is HTTP 402. OpenAI-compatible clients get `insufficient_quota`. Anthropic clients get an error object. Gemini clients get `RESOURCE_EXHAUSTED`.

## Framework snippets

These are the settings that send traffic through the proxy. This repo does not install those SDKs.

OpenAI Agents SDK and any official OpenAI client:

```bash
export OPENAI_BASE_URL=http://127.0.0.1:8791/v1
export OPENAI_API_KEY=...   # the real key; the proxy forwards it
```

LangChain / LangGraph:

```python
from langchain_openai import ChatOpenAI

model = ChatOpenAI(model="gpt-5.4", base_url="http://127.0.0.1:8791/v1")
```

```python
from langchain_anthropic import ChatAnthropic

model = ChatAnthropic(model="claude-sonnet-5", anthropic_api_url="http://127.0.0.1:8792")
```

CrewAI, when it is using the OpenAI client:

```bash
export OPENAI_API_BASE=http://127.0.0.1:8791/v1
export OPENAI_BASE_URL=http://127.0.0.1:8791/v1
```

Google Gen AI SDK:

```python
from google import genai
from google.genai import types

client = genai.Client(
    api_key="...",
    http_options=types.HttpOptions(base_url="http://127.0.0.1:8793"),
)
```

xAI's OpenAI-compatible client:

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8794/v1", api_key="...")
```

Gemini CLI hooks, separate from the proxy:

```bash
spendguard init --adapter gemini
```

That writes `~/.gemini/settings.json`. `BeforeModel` runs before the LLM request and can skip it. `BeforeTool` can deny a tool. Both set `continue: false` when the cap is already spent, which stops the loop instead of asking the model to try again.
