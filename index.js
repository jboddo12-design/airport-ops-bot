const axios = require("axios");

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const FLIGHTAWARE_API_KEY = process.env.FLIGHTAWARE_API_KEY;

const KFLL_LAT = 26.0726;
const KFLL_LON = -80.1527;

// Keep this tight around the airport
const RADIUS_NM = 8;

// Check ADS-B frequently
const POLL_INTERVAL = 5000;

// Aircraft state
const aircraftState = new Map();

// Prevent duplicate landing alerts
const announcedLandings = new Map();

function clean(value) {
  if (value === null || value === undefined || value === "") {
    return "N/A";
  }

  return String(value).trim();
}

function isJetBlue(plane) {
  const flight = clean(plane.flight).toUpperCase();

  return flight.startsWith("JBU");
}

function distanceNM(lat1, lon1, lat2, lon2) {
  const R = 3440.065;

  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) *
    Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;

  return R * 2 * Math.atan2(
    Math.sqrt(a),
    Math.sqrt(1 - a)
  );
}

function formatTime(timestamp) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date(timestamp)) + " EDT";
}

function formatAltitude(value) {
  if (value === "ground" || value === null || value === undefined) {
    return "GROUND";
  }

  return `${Number(value).toLocaleString()} ft`;
}

async function getAircraft() {
  const url =
    `https://api.adsb.lol/v2/point/${KFLL_LAT}/${KFLL_LON}/${RADIUS_NM}`;

  const response = await axios.get(url, {
    timeout: 10000
  });

  return response.data.ac || [];
}

async function getFlightDetails(callsign) {
  if (!FLIGHTAWARE_API_KEY || !callsign || callsign === "N/A") {
    return null;
  }

  try {
    const url =
      `https://aeroapi.flightaware.com/aeroapi/flights/${encodeURIComponent(callsign)}`;

    const response = await axios.get(url, {
      headers: {
        "x-apikey": FLIGHTAWARE_API_KEY
      },
      params: {
        start: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
        end: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString()
      },
      timeout: 10000
    });

    return response.data?.flights?.[0] || null;

  } catch (error) {
    console.error(
      "FlightAware lookup:",
      error.response?.data || error.message
    );

    return null;
  }
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

async function announceLanding(plane) {

  const callsign =
    clean(plane.flight).toUpperCase();

  const hex =
    clean(plane.hex);

  const registration =
    clean(plane.r);

  const aircraftType =
    clean(plane.t);

  const landingId =
    `${hex}-${callsign}`;

  // Don't announce the same landing repeatedly
  if (announcedLandings.has(landingId)) {
    return;
  }

  announcedLandings.set(
    landingId,
    Date.now()
  );

  console.log(
    `🛬 TOUCHDOWN DETECTED: ${callsign}`
  );

  // Get FlightAware information after touchdown
  const flight =
    await getFlightDetails(callsign);

  let origin = "N/A";
  let gate = "Pending";
  let terminal = "Pending";
  let finalAircraft = aircraftType;
  let finalRegistration = registration;

  if (flight) {

    if (flight.origin) {
      origin =
        flight.origin.code ||
        flight.origin;
    }

    finalAircraft =
      flight.aircraft_type ||
      finalAircraft;

    finalRegistration =
      flight.registration ||
      flight.tailnumber ||
      finalRegistration;

    gate =
      flight.gate_dest ||
      flight.gate ||
      "Pending";

    terminal =
      flight.terminal_dest ||
      flight.terminal ||
      "Pending";
  }

  const message =
    `🛬 **JETBLUE ARRIVAL — KFLL**\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🔵 **JETBLUE AIRWAYS**\n\n` +
    `✈️ **Flight:** ${callsign}\n` +
    `📍 **Origin:** ${origin}\n` +
    `🛩️ **Aircraft:** ${finalAircraft}\n` +
    `🏷️ **Registration:** ${finalRegistration}\n` +
    `🛬 **Status:** LANDED\n` +
    `🚪 **Gate:** ${gate}\n` +
    `🏢 **Terminal:** ${terminal}\n` +
    `⏱️ **Touchdown:** ${formatTime(Date.now())}\n` +
    `📡 **Detection:** Live ADS-B\n` +
    `━━━━━━━━━━━━━━━━━━━━`;

  await sendDiscord(message);
}

async function checkKFLL() {

  try {

    const aircraft =
      await getAircraft();

    const jetblue =
      aircraft.filter(isJetBlue);

    console.log(
      `🔵 JBU aircraft near KFLL: ${jetblue.length}`
    );
jetblue.forEach((plane) => {
  console.log(
    `   ✈️ ${clean(plane.flight).toUpperCase()} | ` +
    `ALT: ${plane.alt_baro} | ` +
    `DIST: ${distanceNM(
      Number(plane.lat),
      Number(plane.lon),
      KFLL_LAT,
      KFLL_LON
    ).toFixed(1)} NM`
  );
});
    const now = Date.now();

    for (const plane of jetblue) {

      if (
        plane.lat === undefined ||
        plane.lon === undefined
      ) {
        continue;
      }

      const lat =
        Number(plane.lat);

      const lon =
        Number(plane.lon);

      const distance =
        distanceNM(
          lat,
          lon,
          KFLL_LAT,
          KFLL_LON
        );

      const altitude =
        plane.alt_baro === "ground"
          ? 0
          : Number(plane.alt_baro || 0);

      const verticalRate =
        Number(plane.baro_rate || 0);

      const id =
        `${clean(plane.hex)}-${clean(plane.flight).toUpperCase()}`;

      const previous =
        aircraftState.get(id);

      const current = {
        distance,
        altitude,
        verticalRate,
        lat,
        lon,
        timestamp: now
      };

      aircraftState.set(id, current);

      if (!previous) {
        continue;
      }

      /*
       * TOUCHDOWN DETECTION
       *
       * Aircraft must:
       *
       * 1. Previously be airborne
       * 2. Be approaching KFLL
       * 3. Be extremely close to the airport
       * 4. Transition to ground / very low altitude
       */

      const wasAirborne =
        previous.altitude > 500;

      const wasApproaching =
        previous.distance > distance;

      const isAtAirport =
        distance <= 1.5;

      const isGround =
        plane.alt_baro === "ground" ||
        altitude <= 100;

      if (
        wasAirborne &&
        wasApproaching &&
        isAtAirport &&
        isGround
      ) {

        await announceLanding(plane);
      }
    }

    // Remove old aircraft states
    for (
      const [id, state]
      of aircraftState.entries()
    ) {

      if (
        now - state.timestamp >
        15 * 60 * 1000
      ) {
        aircraftState.delete(id);
      }
    }

    // Remove old landing alerts
    for (
      const [id, timestamp]
      of announcedLandings.entries()
    ) {

      if (
        now - timestamp >
        6 * 60 * 60 * 1000
      ) {
        announcedLandings.delete(id);
      }
    }

  } catch (error) {

    console.error(
      "KFLL ADS-B error:",
      error.response?.data ||
      error.message
    );
  }
}

console.log(
  "🔵 JETBLUE KFLL REAL-TIME ARRIVAL MONITOR"
);

console.log(
  "🛬 TOUCHDOWN DETECTION ENABLED"
);

console.log(
  "🔵 JETBLUE ONLY"
);

console.log(
  "⚡ 5 SECOND POLLING"
);

console.log(
  "📢 Discord:",
  !!WEBHOOK_URL
);

console.log(
  "🔑 FlightAware:",
  !!FLIGHTAWARE_API_KEY
);

checkKFLL();

setInterval(
  checkKFLL,
  POLL_INTERVAL
);
