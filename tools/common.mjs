// Shared helpers for the tools/ diagnostics. Run any tool with:
//
//   node --env-file=.env tools/<name>.mjs
//
// so it picks up the same configuration as server.mjs.

import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const env = (k, d) => process.env[k] ?? d;

export const FFMPEG_BIN = env("FFMPEG_BIN", "ffmpeg");
export const WHISPER_BIN = env("WHISPER_BIN", "whisper-cli");
export const WHISPER_MODEL = env("WHISPER_MODEL", "");
export const PIPER_BIN = env("PIPER_BIN", "piper");
export const PIPER_MODEL = env("PIPER_MODEL", "");
export const DISCORD_TOKEN = env("DISCORD_TOKEN", "");
export const DISCORD_TOKEN_FILE = env("DISCORD_TOKEN_FILE", "");
export const VOICE_CHANNEL_ID = env("VOICE_CHANNEL_ID", "");
export const GUILD_ID = env("GUILD_ID", "");

const TMP = path.join(os.tmpdir(), "discord-voice-bridge-tools");
fs.mkdirSync(TMP, { recursive: true });
export const tmpPath = (name) => `${TMP}/${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// Same contract as server.mjs's run(): stdout comes back as a Buffer, text
// callers .toString("utf8") it. Never concatenate binary stdout into a string.
export function run(cmd, args, { stdin = null, timeoutMs = 300_000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: stdin == null ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"] });
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

const piperCmd = PIPER_BIN.split(/\s+/).filter(Boolean);
export function piperToWav(text, wavPath) {
  return run(piperCmd[0], [...piperCmd.slice(1), "--model", PIPER_MODEL, "--output_file", wavPath], {
    stdin: text,
    timeoutMs: 120_000,
  });
}

export function whisper(wavPath) {
  return run(WHISPER_BIN, ["-m", WHISPER_MODEL, "-np", "-nt", "-f", wavPath], { timeoutMs: 240_000 })
    .then((out) => out.toString("utf8").trim());
}

export async function discordToken() {
  if (DISCORD_TOKEN_FILE) return (await fsp.readFile(DISCORD_TOKEN_FILE, "utf8")).trim();
  if (DISCORD_TOKEN) return DISCORD_TOKEN;
  throw new Error("set DISCORD_TOKEN or DISCORD_TOKEN_FILE");
}

export function requireEnv(...names) {
  const missing = names.filter((n) => !env(n, ""));
  if (missing.length) {
    console.error(`missing required configuration: ${missing.join(", ")} — run as: node --env-file=.env tools/...`);
    process.exit(1);
  }
}

// Compare a whisper transcript against the spoken line, ignoring case and
// punctuation (whisper drops/changes both freely).
export function transcriptsMatch(got, want) {
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
  return norm(got) === norm(want);
}
