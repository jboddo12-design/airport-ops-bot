const axios = require("axios");

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

// KFLL — Fort Lauderdale-Hollywood International Airport
const KFLL_LAT = 26.0726;
const KFLL_LON = -80.1527;
const RADIUS_NM = 25;

// JetBlue ICAO callsign prefix
const JETBLUE_PREFIX = "JBU";

// Remember aircraft we've already posted
const postedAircraft = new Map();

async function getAircraft() {
  const url =
    `https://api.adsb.lol/v2/point/${KFLL_LAT}/${KFLL_LON}/${RADIUS_NM}`;

  const response = await axios.get(url, {
    timeout: 15000
  });

  return response.data.ac || [];
}

async function sendDiscord(message) {
  if (!WEBHOOK_URL) {
    console.error("DISCORD_WEBHOOK_URL is missing.");
    return;
  }

  await axios.post(WEBHOOK_URL, {
    content: message
  });
}

function clean(value) {
  return value ? String(value).trim() : "N/A";
}

function isJetBlue(plane) {
  const callsign = clean(plane.flight).toUpperCase();

  return callsign.startsWith(JETBLUE_PREFIX);
}

function formatAltitude(altitude) {
  if (altitude === null || altitude === undefined) {
    return "N/A";
  }

  return `${Number(altitude).toLocaleString()} ft`;
}

function formatSpeed(speed) {
  if (speed === null || speed === undefined) {
    return "N/A";
  }

  return `${Math.round(Number(speed))} kt`;
}

async function checkKFLL() {
  try {
    const aircraft = await getAircraft();

    const jetblueAircraft = aircraft.filter(isJetBlue);

    console.log(
      `🔵 JetBlue aircraft around KFLL: ${jetblueAircraft.length}`
    );

    for (const plane of jetblueAircraft) {
      const callsign = clean(plane.flight).toUpperCase();
      const registration = clean(plane.r);
      const aircraftType = clean(plane.t);
      const altitude = formatAltitude(plane.alt_baro);
      const speed = formatSpeed(plane.gs);

      const hex = clean(plane.hex);

      // Unique ID for this aircraft/flight
      const aircraftId = `${hex}-${callsign}`;

      // Don't post the same flight repeatedly
      if (postedAircraft.has(aircraftId)) {
        continue;
      }

      postedAircraft.set(aircraftId, Date.now());

      const message =
        `🔵 **JETBLUE | KFLL OPERATIONS**\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `✈️ **Flight:** ${callsign}\n` +
        `🏷️ **Registration:** ${registration}\n` +
        `🛩️ **Aircraft:** ${aircraftType}\n` +
        `📏 **Altitude:** ${altitude}\n` +
        `💨 **Speed:** ${speed}\n` +
        `📡 **Status:** Live KFLL ADS-B contact\n` +
        `📍 **Area:** KFLL / South Florida\n` +
        `━━━━━━━━━━━━━━━━━━━━`;

      await sendDiscord(message);

      console.log(`🔵 JetBlue posted: ${callsign}`);
    }

    // Clean old entries after 6 hours
    const sixHours = 6 * 60 * 60 * 1000;
    const now = Date.now();

    for (const [id, timestamp] of postedAircraft.entries()) {
      if (now - timestamp > sixHours) {
        postedAircraft.delete(id);
      }
    }

  } catch (error) {
    console.error(
      "KFLL JetBlue data error:",
      error.response?.data || error.message
    );
  }
}

console.log("🔵 KFLL JetBlue Operations Bot starting...");
console.log("📡 Connecting to ADSB.lol...");
console.log("📢 Discord webhook configured:", !!WEBHOOK_URL);

checkKFLL();

// Check every 15 seconds
setInterval(checkKFLL, 15000);
