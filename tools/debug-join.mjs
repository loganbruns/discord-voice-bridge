#!/usr/bin/env node
// debug-join — join the configured channel with everything logged, then leave.
// Use this when the bot never seems to join: it prints the raw state
// transitions and (via debug output) the voice websocket close code.
//
// The one everyone is hitting right now: close code 4017, "E2EE/DAVE
// protocol required". Discord now requires the DAVE protocol on voice
// connections; @discordjs/voice 0.18 and older can't speak it and the
// connection dies in Signalling. Fix: @discordjs/voice >= 0.19 with
// discord.js >= 14.28 (this repo's package.json already pins those).
//
//   node --env-file=.env tools/debug-join.mjs

import { Client, GatewayIntentBits, Partials } from "discord.js";
import { joinVoiceChannel, VoiceConnectionStatus, entersState } from "@discordjs/voice";
import { requireEnv, discordToken, VOICE_CHANNEL_ID, GUILD_ID } from "./common.mjs";

requireEnv("VOICE_CHANNEL_ID");

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  partials: [Partials.Channel],
});

const log = (...a) => console.log(new Date().toISOString(), ...a);

let connection = null;

client.once("ready", async () => {
  log(`logged in as ${client.user.tag}`);
  try {
    const channel = await client.channels.fetch(VOICE_CHANNEL_ID);
    log(`joining #${channel.name} in ${channel.guild.name} ...`);
    connection = joinVoiceChannel({
      channelId: VOICE_CHANNEL_ID,
      guildId: GUILD_ID || channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
      debug: true, // always verbose — this is the debugging tool
    });
    connection.on("stateChange", (o, n) => log(`connection ${o.status} -> ${n.status}`));
    connection.on("debug", (m) => log("[debug]", m));
    connection.on("error", (e) => log("[error]", e.message));
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    log("READY — connection is up (if audio still fails after this, the problem is STT/TTS, not the connection)");
  } catch (e) {
    log(`never reached Ready: ${e.message}`);
    log("If the debug output above shows the voice websocket closing with code 4017 (DAVE/E2EE),");
    log("your @discordjs/voice is too old — this repo needs >= 0.19 with discord.js >= 14.28.");
  }
  await new Promise((r) => setTimeout(r, 5000));
  try {
    connection?.destroy();
  } catch {}
  client.destroy();
  process.exit(0);
});

await client.login(await discordToken());
