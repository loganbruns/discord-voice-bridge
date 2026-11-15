# discord-voice-bridge

A small bridge that gives one Discord voice channel a spoken conversation
loop, fully local if you want it that way:

```
Discord voice (Opus 48k) → @discordjs/opus decode → ffmpeg 16k mono
  → whisper.cpp STT → any OpenAI-compatible chat endpoint (streamed)
  → sentence-split → piper TTS → ffmpeg 48k stereo → @discordjs/voice playback
```

The bot joins the channel when a human does, transcribes what people say
(each utterance is prefixed with the speaker's Discord name), answers
through the model, and speaks the reply sentence by sentence as it streams
in. It leaves when the channel empties.

**What this is:** working reference code from a personal project, shared to
save you time. It is not a framework, not a product, and not battle-tested
beyond one home server — expect to read the code and adjust it. Everything
runs on your machine: no audio or text leaves it unless you point the chat
endpoint at a remote API.

**What it is good for:** a local voice chatbot in your own server, or a
starting point for your own variant (different STT, different TTS, a
different chat backend — the seams are simple).

## Read this first: the DAVE pin

Discord now requires the DAVE (E2EE) protocol on voice connections. With
`@discordjs/voice` 0.18 or older the bot silently never joins: the
connection sits in Signalling and the voice websocket closes with code
**4017** ("E2EE/DAVE protocol required"). The fix is version pinning:

- `@discordjs/voice >= 0.19` (brings in the `@snazzah/davey` binding)
- `discord.js >= 14.28`

This repo's `package.json` already pins both. If you are wiring voice into
an existing project and the bot never joins, check these versions before
anything else — `tools/debug-join.mjs` prints the close code.

## Requirements

- Node.js >= 20.6 (for `node --env-file`)
- ffmpeg on PATH
- [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (`whisper-cli`) and
  a ggml model from its releases (`ggml-base.en` is a good start; pick a
  multilingual model for non-English)
- [piper](https://github.com/rhasspy/piper) and a voice from its
  [VOICES list](https://github.com/rhasspy/piper/blob/master/VOICES.md)
  (download the `.onnx` **and** the `.onnx.json` sidecar)
- Any OpenAI-compatible `/v1/chat/completions` endpoint — Ollama,
  llama.cpp's server, vLLM, LM Studio, LiteLLM, or a hosted API

## Discord setup

1. Create an application at <https://discord.com/developers/applications>,
   add a Bot, and copy the token.
2. The bot needs the **Guilds** and **GuildVoiceStates** intents (no
   privileged intents) and **Connect** + **Speak** permissions in the
   target channel.
3. Invite it with the `bot` scope (e.g. the URL generator in the developer
   portal), then move it — or yourself — into the voice channel.
4. Enable Developer Mode in Discord (Settings → Advanced), right-click the
   voice channel, "Copy Channel ID".

## Configure and run

```sh
npm install
cp example.env .env     # then fill it in — VOICE_CHANNEL_ID, LLM_MODEL,
                        # WHISPER_MODEL, PIPER_MODEL, and the bot token
node --env-file=.env server.mjs
```

Join the voice channel; the bot joins a moment later. Say something, pause
for about a second, and it answers. `example.env` documents every knob;
the ones you will actually touch:

| Variable | Meaning |
| --- | --- |
| `VOICE_CHANNEL_ID` | the one channel this bot lives in |
| `DISCORD_TOKEN` / `DISCORD_TOKEN_FILE` | bot token, inline or in a 0600 file |
| `LLM_BASE_URL` | OpenAI-compatible endpoint (default: local Ollama) |
| `LLM_MODEL` | model name as the endpoint knows it |
| `LLM_KEEP_HISTORY` | `1` bridge keeps the conversation (default, for stateless endpoints); `0` endpoint keeps it (openclaw's gateway, keyed on `LLM_USER`) |
| `WHISPER_MODEL` | ggml model path |
| `PIPER_MODEL` | piper `.onnx` voice path |
| `VOICE_HINT` | the speaking-style prompt (short spoken replies, no markdown) |

### npm install gotchas

- npm 11+ blocks native-module install scripts by default. If
  `@discordjs/opus` fails to load, approve its prebuilt binding:
  `npm install-scripts approve @discordjs/opus`.
- `@discordjs/opus` is CommonJS behind a dynamic require, so ESM named
  imports fail — the code imports the namespace and destructures
  (`server.mjs` does this already; keep it if you copy).

## Test it without a second person

```sh
FORCE_JOIN=1 node --env-file=.env server.mjs   # join, say one line, leave
VOICE_TEST_QUESTION="Say one short sentence about pineapples." \
  FORCE_JOIN=1 node --env-file=.env server.mjs # one full turn: STT-side chat
                                               # -> stream -> TTS -> playback
node --env-file=.env tools/pcm-check.mjs       # TTS PCM path is byte-clean
node --env-file=.env tools/stt-test.mjs        # opus round-trip + whisper
node --env-file=.env tools/debug-join.mjs      # raw connection log (4017 check)
```

`DEBUG_VOICE=1` turns on verbose connection and stream logging in the
server itself. Run under systemd with `systemd/discord-voice-bridge.service`
as a starting point.

## How it works

- **Segmentation** is heuristic: Discord's speaking events start a capture,
  ~1.1s of silence ends it, 25s caps it, captures under 400ms are dropped.
  Tunable via `STT_*`.
- **One turn at a time.** While the bot is thinking or speaking, new
  utterances replace a single pending slot — say the latest thing again if
  it missed you. You can talk over it; it just won't answer until done.
- **Playback starts early**: the streamed reply is split into sentences
  (forced break at ~500 chars for unpunctuated runs) and spoken as they
  arrive.
- **History**: with `LLM_KEEP_HISTORY=1` (default) the bridge keeps the
  last 40 exchanges and sends the full list — the normal mode for stateless
  endpoints. With `0`, it sends only the newest message and expects the
  endpoint to remember (this is how it runs against
  [openclaw](https://github.com/openclaw/openclaw)'s gateway, which keys
  sessions on the `user` field and carries the persona/tools itself).
  History resets whenever the bot leaves the channel.

## Limitations (honest list)

- No wake word: it transcribes **everyone** in the channel whenever it is
  joined, and there is no push-to-talk gate. Use a private channel.
- No true barge-in — it finishes its current reply before the next turn.
- One channel, one conversation, one TTS voice per process.
- English-shaped defaults (`ggml-base.en`, the hint text); swap the whisper
  model and hint for other languages.
- Speaker identity comes from Discord's speaking events (name prefixes in
  the prompt), not from voice diarization.
- Not hardened: run it on a machine you trust with your voice channel, and
  keep the token file 0600.

## Bugs we already hit, so you don't have to

- **4017 / DAVE** — see the pin section above.
- **Replies are static noise**: binary PCM was being concatenated into a JS
  string (every byte >= 0x80 mangled). `run()` in `server.mjs` collects
  stdout as Buffers — don't "simplify" it back to strings.
- **Bot hears you, stays silent**: SSE chunks from `fetch` are
  `Uint8Array`s; `.toString()` on them joins byte values ("100,97,116,")
  instead of decoding. Must be `Buffer.from(chunk).toString("utf8")`.
- Both of the above are why `tools/pcm-check.mjs` and the `packetsPlayed`
  logging exist — they fail loudly instead of guessing.

## License

MIT — see [LICENSE](LICENSE).
