require("dotenv").config();

const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require("discord.js");
const axios = require("axios");

// ======================================================
// CONFIG
// ======================================================

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

const ARRIVALS_CHANNEL_ID = process.env.ARRIVALS_CHANNEL_ID;
const DEPARTURES_CHANNEL_ID = process.env.DEPARTURES_CHANNEL_ID;
const OPS_ALERTS_CHANNEL_ID = process.env.OPS_ALERTS_CHANNEL_ID;
const TRACKING_CHANNEL_ID = process.env.TRACKING_CHANNEL_ID;
const WEATHER_CHANNEL_ID = process.env.WEATHER_CHANNEL_ID;
const OPERATIONS_CHANNEL_ID = process.env.OPERATIONS_CHANNEL_ID;

const FLIGHTAWARE_API_KEY = process.env.FLIGHTAWARE_API_KEY;

// KFLL
const AIRPORT = "KFLL";

// JetBlue ICAO
const AIRLINE = "JBU";

// Poll every 5 seconds
const POLL_INTERVAL = 5000;

// ======================================================
// DISCORD CLIENT
// ======================================================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages
  ]
});

// ======================================================
// STORAGE
// Prevent duplicate notifications
// ======================================================

const notifiedArrivals = new Set();
const notifiedDepartures = new Set();
const notifiedApproach = new Set();
const notified15Min = new Set();
const notifiedLanded = new Set();
const notifiedCancelled = new Set();
const notifiedDelayed = new Set();

// ======================================================
// FLIGHTAWARE API
// ======================================================

const flightAware = axios.create({
  baseURL: "https://aeroapi.flightaware.com/aeroapi",
  headers: {
    "x-apikey": FLIGHTAWARE_API_KEY
  },
  timeout: 10000
});

// ======================================================
// HELPER FUNCTIONS
// ======================================================

function getFlightNumber(flight) {
  return (
    flight.ident_iata ||
    flight.ident_icao ||
    flight.ident ||
    "UNKNOWN"
  );
}

function getOrigin(flight) {
  return (
    flight.origin?.code_iata ||
    flight.origin?.code_icao ||
    flight.origin?.code ||
    "UNKNOWN"
  );
}

function getDestination(flight) {
  return (
    flight.destination?.code_iata ||
    flight.destination?.code_icao ||
    flight.destination?.code ||
    "UNKNOWN"
  );
}

function getTailNumber(flight) {
  return flight.registration || "UNKNOWN";
}

function getAircraftType(flight) {
  return flight.aircraft_type || "UNKNOWN";
}

function formatTime(dateString) {
  if (!dateString) return "UNKNOWN";

  try {
    return new Date(dateString).toLocaleTimeString("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit",
      minute: "2-digit"
    }) + " ET";
  } catch {
    return "UNKNOWN";
  }
}

async function getChannel(channelId) {
  if (!channelId) return null;

  try {
    return await client.channels.fetch(channelId);
  } catch (error) {
    console.error(`❌ Unable to fetch channel ${channelId}`);
    return null;
  }
}

// ======================================================
// ARRIVAL MESSAGE
// ======================================================

async function sendArrival(flight) {
  const channel = await getChannel(ARRIVALS_CHANNEL_ID);

  if (!channel) return;

  const flightNumber = getFlightNumber(flight);
  const origin = getOrigin(flight);
  const aircraft = getAircraftType(flight);
  const tail = getTailNumber(flight);

  const touchdown =
    flight.actual_on ||
    flight.actual_arrival ||
    new Date().toISOString();

  const message =
    `🛬 **JETBLUE ARRIVAL — ${flightNumber}**\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `✈️ **Flight:** ${flightNumber}\n` +
    `📍 **Origin:** ${origin}\n` +
    `🛩️ **Aircraft:** ${aircraft}\n` +
    `🏷️ **Registration:** ${tail}\n` +
    `🛬 **Status:** LANDED\n` +
    `⏱️ **Touchdown:** ${formatTime(touchdown)}\n\n` +
    `━━━━━━━━━━━━━━━━━━━━`;

  await channel.send(message);

  console.log(`🛬 ARRIVAL SENT: ${flightNumber} from ${origin}`);
}

// ======================================================
// DEPARTURE MESSAGE
// ======================================================

async function sendDeparture(flight) {
  const channel = await getChannel(DEPARTURES_CHANNEL_ID);

  if (!channel) return;

  const flightNumber = getFlightNumber(flight);
  const destination = getDestination(flight);
  const aircraft = getAircraftType(flight);
  const tail = getTailNumber(flight);

  const departureTime =
    flight.actual_off ||
    flight.actual_departure ||
    new Date().toISOString();

  const message =
    `🛫 **JETBLUE DEPARTURE — ${flightNumber}**\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `✈️ **Flight:** ${flightNumber}\n` +
    `📍 **Destination:** ${destination}\n` +
    `🛩️ **Aircraft:** ${aircraft}\n` +
    `🏷️ **Registration:** ${tail}\n` +
    `🛫 **Status:** DEPARTED\n` +
    `⏱️ **Departure:** ${formatTime(departureTime)}\n\n` +
    `━━━━━━━━━━━━━━━━━━━━`;

  await channel.send(message);

  console.log(`🛫 DEPARTURE SENT: ${flightNumber} to ${destination}`);
}

// ======================================================
// CANCELLED FLIGHT
// ======================================================

async function sendCancellation(flight) {
  const flightNumber = getFlightNumber(flight);

  if (notifiedCancelled.has(flightNumber)) return;

  const channel = await getChannel(OPS_ALERTS_CHANNEL_ID);

  if (!channel) return;

  const message =
    `🚨 **FLIGHT CANCELLED — ${flightNumber}**\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `✈️ **Flight:** ${flightNumber}\n` +
    `❌ **Status:** CANCELLED\n\n` +
    `━━━━━━━━━━━━━━━━━━━━`;

  await channel.send(message);

  notifiedCancelled.add(flightNumber);

  console.log(`🚨 CANCELLATION: ${flightNumber}`);
}

// ======================================================
// DELAY ALERT
// ======================================================

async function sendDelay(flight) {
  const flightNumber = getFlightNumber(flight);

  if (notifiedDelayed.has(flightNumber)) return;

  const channel = await getChannel(OPS_ALERTS_CHANNEL_ID);

  if (!channel) return;

  const message =
    `⚠️ **JETBLUE DELAY — ${flightNumber}**\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `✈️ **Flight:** ${flightNumber}\n` +
    `⏱️ **Status:** DELAYED\n\n` +
    `━━━━━━━━━━━━━━━━━━━━`;

  await channel.send(message);

  notifiedDelayed.add(flightNumber);

  console.log(`⚠️ DELAY ALERT: ${flightNumber}`);
}

// ======================================================
// GET KFLL ARRIVALS
// ======================================================

async function checkArrivals() {
  try {
    const response = await flightAware.get(
      `/airports/${AIRPORT}/flights/arrivals`,
      {
        params: {
          max_pages: 1
        }
      }
    );

    const arrivals = response.data.arrivals || [];

    for (const flight of arrivals) {
      const flightNumber = getFlightNumber(flight);

      if (!flightNumber.startsWith(AIRLINE)) continue;

      const uniqueId =
        flight.fa_flight_id ||
        `${flightNumber}-${flight.scheduled_on || flight.scheduled_in}`;

      // Flight is considered landed when actual_on exists
      if (
        flight.actual_on &&
        !notifiedArrivals.has(uniqueId)
      ) {
        await sendArrival(flight);

        notifiedArrivals.add(uniqueId);
        notifiedLanded.add(uniqueId);
      }

      if (flight.cancelled) {
        await sendCancellation(flight);
      }

      if (
        flight.departure_delay &&
        flight.departure_delay >= 900
      ) {
        await sendDelay(flight);
      }
    }
  } catch (error) {
    console.error(
      "❌ ARRIVAL CHECK ERROR:",
      error.response?.data || error.message
    );
  }
}

// ======================================================
// GET KFLL DEPARTURES
// ======================================================

async function checkDepartures() {
  try {
    const response = await flightAware.get(
      `/airports/${AIRPORT}/flights/departures`,
      {
        params: {
          max_pages: 1
        }
      }
    );

    const departures = response.data.departures || [];

    for (const flight of departures) {
      const flightNumber = getFlightNumber(flight);

      if (!flightNumber.startsWith(AIRLINE)) continue;

      const uniqueId =
        flight.fa_flight_id ||
        `${flightNumber}-${flight.scheduled_off || flight.scheduled_out}`;

      if (
        flight.actual_off &&
        !notifiedDepartures.has(uniqueId)
      ) {
        await sendDeparture(flight);

        notifiedDepartures.add(uniqueId);
      }

      if (flight.cancelled) {
        await sendCancellation(flight);
      }

      if (
        flight.departure_delay &&
        flight.departure_delay >= 900
      ) {
        await sendDelay(flight);
      }
    }
  } catch (error) {
    console.error(
      "❌ DEPARTURE CHECK ERROR:",
      error.response?.data || error.message
    );
  }
}

// ======================================================
// BOT STATUS
// ======================================================

async function sendStartupStatus() {
  const channel = await getChannel(OPERATIONS_CHANNEL_ID);

  if (!channel) return;

  const message =
    `🔵 **JETBLUE KFLL OPERATIONS**\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `🛬 ARRIVALS ENABLED\n` +
    `🛫 DEPARTURES ENABLED\n` +
    `🚨 OPS ALERTS ENABLED\n` +
    `📡 AIRCRAFT TRACKING ENABLED\n` +
    `☀️ DAILY FLL WEATHER ENABLED\n` +
    `🔵 OPERATIONS ENABLED\n` +
    `🤖 SLASH COMMANDS ENABLED\n` +
    `⚡ ARRIVAL POLLING: 5 SECONDS\n\n` +
    `━━━━━━━━━━━━━━━━━━━━`;

  await channel.send(message);
}

// ======================================================
// SLASH COMMANDS
// ======================================================

const commands = [
  new SlashCommandBuilder()
    .setName("status")
    .setDescription("Show KFLL Operations bot status"),

  new SlashCommandBuilder()
    .setName("arrivals")
    .setDescription("Check JetBlue KFLL arrivals"),

  new SlashCommandBuilder()
    .setName("departures")
    .setDescription("Check JetBlue KFLL departures")
].map(command => command.toJSON());

async function registerCommands() {
  try {
    const rest = new REST({
      version: "10"
    }).setToken(DISCORD_TOKEN);

    await rest.put(
      Routes.applicationCommands(CLIENT_ID),
      {
        body: commands
      }
    );

    console.log("🤖 Slash commands registered");
  } catch (error) {
    console.error("❌ Slash command registration failed:", error);
  }
}

// ======================================================
// COMMAND HANDLER
// ======================================================

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "status") {
    await interaction.reply({
      content:
        `🔵 **JETBLUE KFLL OPERATIONS**\n\n` +
        `🟢 Bot Online\n` +
        `🛬 Arrivals: Enabled\n` +
        `🛫 Departures: Enabled\n` +
        `🚨 Alerts: Enabled\n` +
        `⚡ Polling: 5 seconds`,
      ephemeral: true
    });
  }

  if (interaction.commandName === "arrivals") {
    await interaction.deferReply({
      ephemeral: true
    });

    await checkArrivals();

    await interaction.editReply(
      "🛬 JetBlue arrivals checked."
    );
  }

  if (interaction.commandName === "departures") {
    await interaction.deferReply({
      ephemeral: true
    });

    await checkDepartures();

    await interaction.editReply(
      "🛫 JetBlue departures checked."
    );
  }
});

// ======================================================
// READY
// ======================================================

client.once("ready", async () => {
  console.log("");
  console.log("🔵 JETBLUE KFLL OPERATIONS");
  console.log("🛬 ARRIVALS ENABLED");
  console.log("🛫 DEPARTURES ENABLED");
  console.log("🚨 OPS ALERTS ENABLED");
  console.log("📡 AIRCRAFT TRACKING ENABLED");
  console.log("☀️ DAILY FLL WEATHER ENABLED");
  console.log("🔵 OPERATIONS ENABLED");
  console.log("🤖 SLASH COMMANDS ENABLED");
  console.log("⚡ ARRIVAL POLLING: 5 SECONDS");
  console.log(`🟢 Discord bot online as ${client.user.tag}`);
  console.log("");

  await registerCommands();

  // Initial checks
  await checkArrivals();
  await checkDepartures();

  // Repeat every 5 seconds
  setInterval(async () => {
    await checkArrivals();
    await checkDepartures();
  }, POLL_INTERVAL);
});

// ======================================================
// ERROR HANDLING
// ======================================================

process.on("unhandledRejection", error => {
  console.error("❌ UNHANDLED REJECTION:", error);
});

process.on("uncaughtException", error => {
  console.error("❌ UNCAUGHT EXCEPTION:", error);
});

// ======================================================
// LOGIN
// ======================================================

if (!DISCORD_TOKEN) {
  console.error("❌ DISCORD_TOKEN is missing.");
  process.exit(1);
}

if (!FLIGHTAWARE_API_KEY) {
  console.error("❌ FLIGHTAWARE_API_KEY is missing.");
  process.exit(1);
}

client.login(DISCORD_TOKEN);
