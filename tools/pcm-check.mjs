#!/usr/bin/env node
// pcm-check — verify the TTS -> PCM capture path without touching Discord.
//
// piper speaks a known sentence, ffmpeg turns it into the 48k stereo s16le
// stream the server actually plays (captured from stdout as Buffers, the
// production path), that goes back through the exact utterance conversion
// (16k mono wav) into whisper. PASS only on an exact transcript match, so
// any byte-corrupting capture bug shows up as FAIL/static.
//
//   node --env-file=.env tools/pcm-check.mjs

import fsp from "node:fs/promises";
import {
  requireEnv,
  run,
  piperToWav,
  whisper,
  transcriptsMatch,
  tmpPath,
  FFMPEG_BIN,
} from "./common.mjs";

const LINE = "The quick brown fox jumps over the lazy dog.";

requireEnv("WHISPER_MODEL", "PIPER_MODEL");

const wav = `${tmpPath("pcm")}.wav`;
await piperToWav(LINE, wav);

// production capture path: binary stdout as a Buffer (NOT a string)
const pcm = await run(
  FFMPEG_BIN,
  ["-hide_banner", "-loglevel", "error", "-i", wav, "-ar", "48000", "-ac", "2", "-f", "s16le", "-"],
  { timeoutMs: 60_000 }
);
await fsp.unlink(wav).catch(() => {});

// same conversion the receiver applies before whisper
const mono = `${tmpPath("mono")}.wav`;
await run(
  FFMPEG_BIN,
  ["-hide_banner", "-loglevel", "error", "-y", "-f", "s16le", "-ar", "48000", "-ac", "2", "-i", "-", "-ar", "16000", "-ac", "1", mono],
  { stdin: pcm, timeoutMs: 60_000 }
);

const got = await whisper(mono);
await fsp.unlink(mono).catch(() => {});

console.log(`spoke : ${LINE}`);
console.log(`heard : ${got}`);
if (transcriptsMatch(got, LINE)) {
  console.log("PASS — TTS PCM path is byte-clean");
  process.exit(0);
} else {
  console.log("FAIL — transcript mismatch; the PCM stream is likely being corrupted on the way through (string concatenation of binary stdout is the usual cause)");
  process.exit(1);
}
