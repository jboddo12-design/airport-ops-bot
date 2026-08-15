const axios = require("axios");

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

// KFLL — Fort Lauderdale-Hollywood International Airport
const KFLL_LAT = 26.0726;
const KFLL_LON = -80.1527;

// Search radius in nautical miles
const RADIUS_NM = 25;

let lastAircraft = new Set();

async function getAircraft() {
  const url =
    `https://api.adsb.one/v2/point/${KFLL_LAT}/${KFLL_LON}/${RADIUS_NM}`;

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

async function checkKFLL() {
  try {
    const aircraft = await getAircraft();

    console.log(`✈️ Aircraft detected around KFLL: ${aircraft.length}`);

    for (const plane of aircraft) {
      const callsign = clean(plane.flight);
      const registration = clean(plane.r);
      const type = clean(plane.t);
      const altitude = plane.alt_baro ?? "N/A";
      const speed = plane.gs ?? "N/A";

      const id = `${plane.hex}-${callsign}`;

      if (lastAircraft.has(id)) {
        continue;
      }

      lastAircraft.add(id);

      // Keep memory from growing forever
      if (lastAircraft.size > 500) {
        lastAircraft = new Set(
          Array.from(lastAircraft).slice(-250)
        );
      }

      const message =
        `✈️ **KFLL AIRPORT OPERATIONS**\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `🛩️ **Flight:** ${callsign}\n` +
        `🏷️ **Registration:** ${registration}\n` +
        `✈️ **Aircraft:** ${type}\n` +
        `📏 **Altitude:** ${altitude} ft\n` +
        `💨 **Speed:** ${speed} kt\n` +
        `📡 **Status:** Live ADS-B contact\n` +
        `━━━━━━━━━━━━━━━━━━━━`;

      await sendDiscord(message);

      console.log(`📡 Posted: ${callsign}`);
    }
  } catch (error) {
    console.error(
      "KFLL data error:",
      error.response?.data || error.message
    );
  }
}

console.log("✈️ KFLL Airport Operations Bot starting...");
console.log("📡 Connecting to Airplanes.live...");
console.log("📢 Discord webhook configured:", !!WEBHOOK_URL);

// Check immediately
checkKFLL();

// Airplanes.live documents a 1 request/second limit.
// We poll every 15 seconds to stay comfortably below that.
setInterval(checkKFLL, 15000);
