#!/usr/bin/env node
// discord-voice-bridge — a small bridge that gives one Discord voice channel
// a voice conversation loop, fully local:
//
//   voice channel Opus (48k stereo) -> @discordjs/opus decode -> ffmpeg 16k mono
//     -> whisper.cpp STT -> any OpenAI-compatible /v1/chat/completions endpoint
//     (streamed) -> sentence-split -> piper TTS -> ffmpeg 48k stereo PCM
//     -> @discordjs/voice playback
//
// The bot joins VOICE_CHANNEL_ID when a human joins it and leaves when the
// channel empties. Each finished utterance becomes one chat turn; the reply
// is spoken sentence by sentence as it streams in.
//
// This is a small working reference, not a framework. Configuration is
// entirely via environment variables — see example.env.

import {
  Client,
  GatewayIntentBits,
  Events,
  Partials,
} from "discord.js";
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  NoSubscriberBehavior,
  VoiceConnectionStatus,
  AudioPlayerStatus,
  entersState,
} from "@discordjs/voice";
// @discordjs/opus resolves its binding through a dynamic require(), so ESM
// can't statically detect named exports — import the namespace and destructure.
import opusPkg from "@discordjs/opus";
const { OpusEncoder } = opusPkg;
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const env = (k, d) => process.env[k] ?? d;
const num = (k, d) => {
  const v = Number(env(k, ""));
  return Number.isFinite(v) && v > 0 ? v : d;
};

const GUILD_ID = env("GUILD_ID", ""); // optional if VOICE_CHANNEL_ID is set
const VOICE_CHANNEL_ID = env("VOICE_CHANNEL_ID", "");
const DISCORD_TOKEN = env("DISCORD_TOKEN", "");
const DISCORD_TOKEN_FILE = env("DISCORD_TOKEN_FILE", ""); // takes priority over DISCORD_TOKEN

// Chat backend: any OpenAI-compatible endpoint (Ollama, llama.cpp server,
// vLLM, LM Studio, LiteLLM, openclaw's gateway, or the real OpenAI API).
// Both "http://host:port" and the OpenAI-client convention "http://host:port/v1"
// are accepted — a trailing /v1 is normalized away and the path appended below.
const LLM_BASE_URL = env("LLM_BASE_URL", "http://127.0.0.1:11434")
  .replace(/\/+$/, "")
  .replace(/\/v1$/, "");
const LLM_API_KEY = env("LLM_API_KEY", "");
const LLM_API_KEY_FILE = env("LLM_API_KEY_FILE", ""); // takes priority over LLM_API_KEY
const LLM_MODEL = env("LLM_MODEL", "");
// Sent as the OpenAI `user` field. Backends that key sessions on it (e.g.
// openclaw) get a stable, separate session for this bridge; others ignore it.
const LLM_USER = env("LLM_USER", "discord-voice");
// Who remembers the conversation?
//   1 (default): this bridge keeps the last HISTORY_MAX_MESSAGES exchanges in
//      memory and sends the full message list with each request — for
//      stateless endpoints (Ollama, llama.cpp server, vLLM, LM Studio, OpenAI).
//   0: the endpoint maintains the session itself (e.g. openclaw's gateway,
//      keyed on the `user` field) — only the newest message is sent.
const LLM_KEEP_HISTORY = env("LLM_KEEP_HISTORY", "1") === "1";
const HISTORY_MAX_MESSAGES = num("HISTORY_MAX_MESSAGES", 40);

const VOICE_HINT = env(
  "VOICE_HINT",
  "You are speaking aloud in a Discord voice channel. Each message is prefixed with the speaker's name. " +
    "Answer in 1-3 short conversational sentences of plain text — no markdown, no lists, no code, no emoji. " +
    "Only use tools when the request genuinely needs them; for idle chatter just reply."
);

const FFMPEG_BIN = env("FFMPEG_BIN", "ffmpeg");
const WHISPER_BIN = env("WHISPER_BIN", "whisper-cli");
const WHISPER_MODEL = env("WHISPER_MODEL", "");
// piper command. "piper" (a binary on PATH) by default; a command with
// arguments like "python3 -m piper" also works.
const PIPER_BIN = env("PIPER_BIN", "piper");
const PIPER_MODEL = env("PIPER_MODEL", "");
const TTS_MAX_CHARS = num("TTS_MAX_CHARS", 1200);

// STT segmentation tuning (ms)
const STT_MIN_MS = num("STT_MIN_MS", 400);      // ignore clicks / sub-word noise
const STT_DRAIN_MS = num("STT_DRAIN_MS", 1100); // silence after last activity -> end utterance
const STT_MAX_MS = num("STT_MAX_MS", 25000);    // hard cap per utterance

// LLM turn tuning
const TURN_IDLE_MS = num("TURN_IDLE_MS", 120000); // no stream chunk for this long -> abort
const TURN_MAX_MS = num("TURN_MAX_MS", 420000);

// Verbose connection/DAVE + stream debug (env DEBUG_VOICE=1)
const DEBUG_VOICE = env("DEBUG_VOICE", "") === "1";
// Test mode: join immediately (even with nobody there), say HELLO_LINE, leave.
const FORCE_JOIN = env("FORCE_JOIN", "") === "1";
const HELLO_LINE = env("HELLO_LINE", "Discord voice bridge online.");
// With FORCE_JOIN=1: run one full turn through this question instead of
// HELLO_LINE (streamed reply -> sentence split -> TTS -> playback).
const VOICE_TEST_QUESTION = env("VOICE_TEST_QUESTION", "");
const VOICE_TEST_NAME = env("VOICE_TEST_NAME", "test");

// ---------------------------------------------------------------- startup checks

const missing = [];
if (!VOICE_CHANNEL_ID) missing.push("VOICE_CHANNEL_ID");
if (!DISCORD_TOKEN && !DISCORD_TOKEN_FILE) missing.push("DISCORD_TOKEN or DISCORD_TOKEN_FILE");
if (!LLM_MODEL) missing.push("LLM_MODEL");
if (!WHISPER_MODEL) missing.push("WHISPER_MODEL");
if (!PIPER_MODEL) missing.push("PIPER_MODEL");
if (missing.length) {
  console.error(`missing required configuration: ${missing.join(", ")}`);
  console.error("copy example.env to .env (or your EnvironmentFile) and fill it in");
  process.exit(1);
}

const TMP = path.join(os.tmpdir(), "discord-voice-bridge");
fs.mkdirSync(TMP, { recursive: true });

const log = (...a) => console.log(new Date().toISOString(), ...a);
const tmpName = (p) => `${TMP}/${p}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function readToken(value, file, what) {
  if (file) return (await fsp.readFile(file, "utf8")).trim();
  if (value) return value;
  throw new Error(`no ${what} configured`);
}
const llmApiKey = async () => {
  if (LLM_API_KEY_FILE) return (await fsp.readFile(LLM_API_KEY_FILE, "utf8")).trim();
  if (LLM_API_KEY) return LLM_API_KEY;
  return null; // no auth header (most local servers don't need one)
};
const discordToken = () => readToken(DISCORD_TOKEN, DISCORD_TOKEN_FILE, "Discord token");

function run(cmd, args, { stdin = null, timeoutMs = 300_000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: stdin == null ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"] });
    // stdout is collected as Buffers and returned as a Buffer — callers that
    // want text .toString("utf8") it. (String concatenation here utf8-decodes
    // binary output: passing the TTS PCM through a string mangles every byte
    // >= 0x80, and replies come out as static.)
    const out = [];
    let err = "";
    const timer = setTimeout(() => {
      p.kill("SIGKILL");
      reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    p.stdout.on("data", (d) => out.push(d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`${cmd} exited ${code}: ${err.slice(0, 500)}`));
    });
    if (stdin != null) {
      p.stdin.write(stdin);
      p.stdin.end();
    }
  });
}

// piper may be a bare command or a command with arguments ("python3 -m piper")
const piperCmd = PIPER_BIN.split(/\s+/).filter(Boolean);
async function runPiper(args, opts) {
  return run(piperCmd[0], [...piperCmd.slice(1), ...args], opts);
}

// ---------------------------------------------------------------- discord

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  partials: [Partials.Channel],
});

let connection = null;
let player = null;
const receiverSubs = new Map(); // userId -> AudioReceiveStream
const utterances = new Map(); // userId -> active utterance
const opusDecoder = new OpusEncoder(48000, 2);

function botIds() {
  const ids = new Set([client.user?.id].filter(Boolean));
  return ids;
}

function humansInChannel(channel) {
  return [...channel.members.values()].filter(
    (m) => !botIds().has(m.id) && !m.user?.bot
  );
}

// ---------------------------------------------------------------- STT

class Utterance {
  constructor(userId, displayName) {
    this.userId = userId;
    this.name = displayName;
    this.wavPath = `${tmpName("utt")}.16k.wav`;
    this.startedAt = Date.now();
    this.lastActivity = Date.now();
    this.bytes = 0;
    this.closed = false;
    this.timer = null;
    // 48k stereo s16le from the decoder -> 16k mono wav for whisper
    this.proc = spawn(FFMPEG_BIN, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "s16le", "-ar", "48000", "-ac", "2", "-i", "-",
      "-ar", "16000", "-ac", "1", this.wavPath,
    ]);
    this.proc.stdin.on("error", () => {}); // user stopped mid-buffer etc.
    this.tick = setInterval(() => this.checkDrain(), 250);
    this.tick.unref?.();
  }

  feed(pcm) {
    if (this.closed) return;
    this.lastActivity = Date.now();
    this.bytes += pcm.length;
    if (!this.proc.stdin.write(pcm)) {
      // backpressure: drop rather than block the UDP path
      this.proc.stdin.once("drain", () => {});
    }
  }

  checkDrain() {
    const age = Date.now() - this.startedAt;
    if (age > STT_MAX_MS || Date.now() - this.lastActivity > STT_DRAIN_MS) {
      this.finalize();
    }
  }

  finalize() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.tick);
    clearTimeout(this.timer);
    const durMs = Date.now() - this.startedAt;
    utterances.delete(this.userId);
    this.proc.stdin.end();
    this.proc.stdin.destroy?.();
    this.proc.on("close", async () => {
      try {
        if (durMs < STT_MIN_MS || this.bytes < 48000 * 2 * (STT_MIN_MS / 1000) * 0.3) {
          return; // too short to be speech — drop without ASR
        }
        const t0 = Date.now();
        const out = await run(WHISPER_BIN, ["-m", WHISPER_MODEL, "-np", "-nt", "-f", this.wavPath], { timeoutMs: 240_000 });
        const text = out.toString("utf8").trim();
        if (!text || text === "[BLANK_AUDIO]") return;
        log(`asr ${((Date.now() - t0) / 1000).toFixed(1)}s <${this.name}>:`, text.slice(0, 160));
        queueTurn(this.name, text);
      } catch (e) {
        log("asr error:", e.message);
      } finally {
        fsp.unlink(this.wavPath).catch(() => {});
      }
    });
  }
}

function handleSpeaking(userId, displayName, started) {
  if (botIds().has(userId)) return;
  let utt = utterances.get(userId);
  if (started) {
    if (!utt) {
      utt = new Utterance(userId, displayName);
      utterances.set(userId, utt);
    }
    utt.lastActivity = Date.now();
  }
  // 'end' is handled by the drain timer; the flag is only a hint.
}

function subscribeUser(userId, displayName) {
  if (!connection || receiverSubs.has(userId)) return;
  const stream = connection.receiver.subscribe(userId);
  receiverSubs.set(userId, stream);
  stream.on("data", (buf) => {
    const utt = utterances.get(userId);
    if (!utt) return; // no active utterance (pre-start packet or post-drain)
    let pcm;
    try {
      pcm = opusDecoder.decode(buf);
    } catch {
      return; // malformed/dropped packet
    }
    utt.feed(pcm);
  });
}

function unsubscribeUser(userId) {
  const stream = receiverSubs.get(userId);
  if (stream) {
    stream.destroy?.();
    receiverSubs.delete(userId);
  }
  utterances.get(userId)?.finalize();
}

// ---------------------------------------------------------------- turn / LLM

// Conversation memory for LLM_KEEP_HISTORY mode. Cleared when the bot leaves
// the channel — one conversation per channel visit.
let history = [];
function remember(userMsg, assistantText) {
  history.push(userMsg);
  if (assistantText) history.push({ role: "assistant", content: assistantText });
  const cap = HISTORY_MAX_MESSAGES * 2;
  if (history.length > cap) history = history.slice(-cap);
}

let turnBusy = false;
let pendingTurn = null; // keep only the latest utterance said while busy

function queueTurn(name, text) {
  if (turnBusy) {
    if (pendingTurn) log("turn drop (busy):", pendingTurn.text.slice(0, 80));
    pendingTurn = { name, text };
    return;
  }
  runTurn(name, text);
}

async function runTurn(name, text) {
  turnBusy = true;
  const t0 = Date.now();
  try {
    await chatAndSpeak(name, text);
  } catch (e) {
    log("turn error:", e.message);
    try {
      await speakText("Sorry, something went wrong on that one. Try again?");
    } catch {}
  } finally {
    log(`turn done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    turnBusy = false;
    if (pendingTurn) {
      const p = pendingTurn;
      pendingTurn = null;
      runTurn(p.name, p.text);
    }
  }
}

// Split streamed text into speakable sentences, forcing a break on long
// unpunctuated runs so audio starts early.
class SentenceSink {
  constructor(onSentence) {
    this.buf = "";
    this.onSentence = onSentence;
    this.done = false;
  }
  push(text) {
    this.buf += text;
    for (;;) {
      const m = this.buf.match(/^[\s\S]{1,400}?[.!?…]["')\]]?\s+/);
      if (m) {
        this.onSentence(m[0].trim());
        this.buf = this.buf.slice(m[0].length);
        continue;
      }
      if (this.buf.length > 500) {
        this.onSentence(this.buf.slice(0, 500).trim());
        this.buf = this.buf.slice(500);
        continue;
      }
      break;
    }
  }
  finish() {
    if (this.buf.trim()) this.onSentence(this.buf.trim());
    this.done = true;
  }
}

async function chatAndSpeak(name, text) {
  const apiKey = await llmApiKey();
  const headers = { "content-type": "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const userMsg = { role: "user", content: `${name}: ${text}` };
  const payload = {
    model: LLM_MODEL,
    user: LLM_USER,
    stream: true,
    messages: LLM_KEEP_HISTORY
      ? [{ role: "system", content: VOICE_HINT }, ...history, userMsg]
      : // stateful endpoint: the hint rides along on each message instead
        [{ role: "user", content: `${VOICE_HINT}\n\n${name}: ${text}` }],
  };
  log("chat ->", `<${name}> ${text.replace(/\s+/g, " ").slice(0, 160)}`);

  const abort = new AbortController();
  const hardTimer = setTimeout(() => abort.abort(), TURN_MAX_MS);
  const idleTimer = { t: null };
  const armIdle = () => {
    clearTimeout(idleTimer.t);
    idleTimer.t = setTimeout(() => abort.abort(), TURN_IDLE_MS);
  };
  armIdle();

  const ttsQueue = [];
  let ttsDone = false;
  const sink = new SentenceSink((s) => {
    log("sentence queued:", s.replace(/\s+/g, " ").slice(0, 120));
    ttsQueue.push(s.slice(0, TTS_MAX_CHARS));
  });
  const pumpTts = (async () => {
    while (!(ttsDone && ttsQueue.length === 0)) {
      if (ttsQueue.length === 0) {
        await new Promise((r) => setTimeout(r, 150));
        continue;
      }
      const s = ttsQueue.shift();
      try {
        await speakText(s);
      } catch (e) {
        log("tts error:", e.message);
      }
    }
  })();

  let gw;
  try {
    gw = await fetch(`${LLM_BASE_URL}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: abort.signal,
    });
  } catch (e) {
    clearTimeout(hardTimer);
    clearTimeout(idleTimer.t);
    sink.finish();
    ttsDone = true;
    await pumpTts;
    throw new Error(`chat endpoint unreachable: ${e.message}`);
  }
  if (!gw.ok || !gw.body) {
    const body = await gw.text().catch(() => "");
    clearTimeout(hardTimer);
    clearTimeout(idleTimer.t);
    sink.finish();
    ttsDone = true;
    await pumpTts;
    throw new Error(`chat endpoint ${gw.status}: ${body.slice(0, 200)}`);
  }

  let carry = "";
  let fullText = "";
  try {
    for await (const chunk of gw.body) {
      armIdle();
      // chunk is a plain Uint8Array — .toString() on a typed array joins the
      // byte values as "100,97,116,..." instead of decoding; wrap in Buffer.
      if (DEBUG_VOICE) log("[chunk]", JSON.stringify(Buffer.from(chunk).toString("utf8").slice(0, 200)));
      carry += Buffer.from(chunk).toString("utf8");
      let idx;
      while ((idx = carry.indexOf("\n")) >= 0) {
        const line = carry.slice(0, idx).trim();
        carry = carry.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        try {
          const delta = JSON.parse(data).choices?.[0]?.delta?.content;
          if (delta) {
            if (DEBUG_VOICE) log("[delta]", JSON.stringify(delta));
            fullText += delta;
            sink.push(delta);
          }
        } catch {}
      }
    }
  } finally {
    clearTimeout(hardTimer);
    clearTimeout(idleTimer.t);
    sink.finish();
    ttsDone = true;
    await pumpTts;
    if (LLM_KEEP_HISTORY) remember(userMsg, fullText.trim());
    log(`chat <- done`);
  }
}

// ---------------------------------------------------------------- TTS + playback

function playerIdle() {
  if (player.state.status === AudioPlayerStatus.Idle) return Promise.resolve();
  return new Promise((r) => player.once(AudioPlayerStatus.Idle, r));
}

async function speakText(text) {
  // both are nulled together in teardownConnection(); checking both closes
  // the race where the channel empties mid-reply between this check and
  // playerIdle()'s player.state access
  if (!connection || !player) throw new Error("not connected");
  // piper -> 22.05k mono wav -> 48k stereo s16le for @discordjs/voice
  const pwav = `${tmpName("tts")}.wav`;
  await runPiper(["--model", PIPER_MODEL, "--output_file", pwav], { stdin: text, timeoutMs: 120_000 });

  // binary stdout — run() returns a Buffer (see the comment there)
  const pcm = await run(
    FFMPEG_BIN,
    ["-hide_banner", "-loglevel", "error", "-i", pwav, "-ar", "48000", "-ac", "2", "-f", "s16le", "-"],
    { timeoutMs: 60_000 }
  );
  await fsp.unlink(pwav).catch(() => {});
  log(`tts speak ${text.length} chars -> ${(pcm.length / 192000).toFixed(1)}s pcm`);
  const readable = new ReadableStreamSink(pcm);
  // StreamType.Raw = 48kHz s16le stereo PCM; @discordjs/voice opus-encodes it.
  const resource = createAudioResource(readable, { inputType: StreamType.Raw });
  await playerIdle();
  const before = connection.state.networking?.state?.connectionData?.packetsPlayed;
  player.play(resource);
  await playerIdle();
  const after = connection.state.networking?.state?.connectionData?.packetsPlayed;
  log(`tts done: packets ${before ?? "?"} -> ${after ?? "?"}`);
}

// Minimal Readable that pushes one buffer (createAudioResource needs a stream).
import { Readable } from "node:stream";
class ReadableStreamSink extends Readable {
  constructor(buf) {
    super();
    this.buf = buf;
    this.sent = false;
  }
  _read() {
    if (this.sent) {
      this.push(null);
      return;
    }
    this.sent = true;
    this.push(this.buf);
  }
}

// ---------------------------------------------------------------- voice channel lifecycle

async function joinChannel() {
  if (connection) return;
  const channel = await client.channels.fetch(VOICE_CHANNEL_ID);
  connection = joinVoiceChannel({
    channelId: VOICE_CHANNEL_ID,
    guildId: GUILD_ID || channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false,
    debug: DEBUG_VOICE,
  });
  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      teardownConnection();
    }
  });
  await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
  player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
  connection.subscribe(player);

  // playback diagnostics: player failures are otherwise invisible (and
  // unhandled 'error' events on the player crash the process)
  player.on("error", (e) => log("player error:", e.message));
  player.on("stateChange", (o, n) => {
    if (o.status !== n.status) log(`player ${o.status} -> ${n.status}`);
  });
  connection.on("stateChange", (o, n) => {
    if (o.status !== n.status) log(`connection ${o.status} -> ${n.status}`);
  });
  if (DEBUG_VOICE) connection.on("debug", (m) => log("[debug]", m));
  const cd = connection.state.networking?.state?.connectionData;
  log(`voice ready: enc=${cd?.encryptionMode} ssrc=${cd?.ssrc}`);

  connection.receiver.speaking.on("start", (userId) => {
    const member = channel.members.get(userId);
    handleSpeaking(userId, member?.displayName ?? userId, true);
    subscribeUser(userId, member?.displayName ?? userId);
  });
  connection.receiver.speaking.on("end", (userId) => handleSpeaking(userId, "", false));

  // subscribe everyone already in the channel
  for (const m of channel.members.values()) {
    if (!botIds().has(m.id) && !m.user?.bot) subscribeUser(m.id, m.displayName);
  }
  log("voice: joined", channel.name);
}

function teardownConnection() {
  for (const uid of [...receiverSubs.keys()]) unsubscribeUser(uid);
  if (connection) {
    try {
      connection.destroy();
    } catch {}
    log("voice: left channel");
  }
  connection = null;
  player = null;
  history = []; // one conversation per channel visit
}

async function maybeJoin(channelId) {
  try {
    if (channelId !== VOICE_CHANNEL_ID || connection) return;
    const channel = await client.channels.fetch(VOICE_CHANNEL_ID);
    if (humansInChannel(channel).length > 0) await joinChannel();
  } catch (e) {
    log("join error:", e.message);
  }
}

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  const uid = newState.id;
  if (botIds().has(uid)) return;
  const member = newState.member ?? oldState.member;
  if (member?.user?.bot) return;

  if (newState.channelId === VOICE_CHANNEL_ID && oldState.channelId !== VOICE_CHANNEL_ID) {
    await maybeJoin(VOICE_CHANNEL_ID);
  }
  if (oldState.channelId === VOICE_CHANNEL_ID && newState.channelId !== VOICE_CHANNEL_ID) {
    unsubscribeUser(uid);
    try {
      const channel = await client.channels.fetch(VOICE_CHANNEL_ID);
      if (connection && humansInChannel(channel).length === 0) teardownConnection();
    } catch {}
  }
});

client.once(Events.ClientReady, async () => {
  log(`discord voice bridge ready as ${client.user.tag} (model=${LLM_MODEL} user=${LLM_USER})`);
  if (FORCE_JOIN) {
    try {
      await joinChannel();
      if (VOICE_TEST_QUESTION) {
        // one full production turn (stream -> sentences -> TTS -> playback)
        await runTurn(VOICE_TEST_NAME, VOICE_TEST_QUESTION);
      } else {
        await speakText(HELLO_LINE);
      }
      await new Promise((r) => setTimeout(r, 2000));
      teardownConnection();
      log("force-join smoke test complete");
    } catch (e) {
      log("force-join test failed:", e.message);
    }
    return;
  }
  await maybeJoin(VOICE_CHANNEL_ID).catch((e) => log("initial join:", e.message));
});

const shutdown = () => {
  teardownConnection();
  client.destroy();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

const token = await discordToken();
await client.login(token);
