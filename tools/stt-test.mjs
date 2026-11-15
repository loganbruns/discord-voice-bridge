#!/usr/bin/env node
// stt-test — verify the full receive pipeline without touching Discord:
// Opus decode, the ffmpeg 16k-mono conversion, and whisper.
//
// piper speaks a known sentence -> 48k stereo PCM -> @discordjs/opus
// encode/decode round-trip (what every received packet goes through) ->
// the exact utterance conversion -> whisper. PASS only on an exact match.
//
//   node --env-file=.env tools/stt-test.mjs

import fsp from "node:fs/promises";
import opusPkg from "@discordjs/opus";
const { OpusEncoder } = opusPkg;
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

const wav = `${tmpPath("stt")}.wav`;
await piperToWav(LINE, wav);
const pcm = await run(
  FFMPEG_BIN,
  ["-hide_banner", "-loglevel", "error", "-i", wav, "-ar", "48000", "-ac", "2", "-f", "s16le", "-"],
  { timeoutMs: 60_000 }
);
await fsp.unlink(wav).catch(() => {});

// round-trip through the same OpusEncoder settings the receiver uses.
// 20ms frames: 960 samples * 2 channels * 2 bytes = 3840 bytes; pad the tail.
const enc = new OpusEncoder(48000, 2);
const dec = new OpusEncoder(48000, 2);
const FRAME = 960 * 2 * 2;
const chunks = [];
for (let i = 0; i < pcm.length; i += FRAME) {
  const frame = pcm.subarray(i, i + FRAME);
  const padded = frame.length === FRAME ? frame : Buffer.concat([frame, Buffer.alloc(FRAME - frame.length)]);
  chunks.push(dec.decode(enc.encode(padded)));
}
const roundtrip = Buffer.concat(chunks);

// exact utterance conversion from server.mjs
const mono = `${tmpPath("mono")}.wav`;
await run(
  FFMPEG_BIN,
  ["-hide_banner", "-loglevel", "error", "-y", "-f", "s16le", "-ar", "48000", "-ac", "2", "-i", "-", "-ar", "16000", "-ac", "1", mono],
  { stdin: roundtrip, timeoutMs: 60_000 }
);

const got = await whisper(mono);
await fsp.unlink(mono).catch(() => {});

console.log(`spoke : ${LINE}`);
console.log(`heard : ${got}`);
if (transcriptsMatch(got, LINE)) {
  console.log("PASS — opus round-trip + whisper receive path is clean");
  process.exit(0);
} else {
  console.log("FAIL — transcript mismatch after the opus round-trip; check the whisper model and the ffmpeg args against server.mjs");
  process.exit(1);
}
