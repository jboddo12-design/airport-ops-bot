const axios = require("axios");

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const FLIGHTAWARE_API_KEY = process.env.FLIGHTAWARE_API_KEY;

const AIRPORT = "KFLL";

// Remember flights we've already announced
const announcedFlights = new Set();

function clean(value) {
  if (value === null || value === undefined || value === "") {
    return "N/A";
  }

  return String(value).trim();
}

function isJetBlue(flight) {
  const ident = clean(flight.ident).toUpperCase();

  // FlightAware may return B6/JBU identifiers depending on the record.
  return (
    ident.startsWith("B6") ||
    ident.startsWith("JBU")
  );
}

function formatTime(unixTime) {
  if (!unixTime || Number(unixTime) <= 0) {
    return "N/A";
  }

  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(Number(unixTime) * 1000)) + " EDT";
}

function formatDateTime(unixTime) {
  if (!unixTime || Number(unixTime) <= 0) {
    return "N/A";
  }

  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(Number(unixTime) * 1000)) + " EDT";
}

async function getRecentArrivals() {
  const url =
    `https://aeroapi.flightaware.com/aeroapi/airports/${AIRPORT}/flights/arrivals`;

  const response = await axios.get(url, {
    headers: {
      "x-apikey": FLIGHTAWARE_API_KEY
    },
    params: {
      max_pages: 1
    },
    timeout: 15000
  });

  return response.data.arrivals || [];
}

async function getFlightDetails(faFlightId) {
  if (!faFlightId) {
    return null;
  }

  try {
    const url =
      `https://aeroapi.flightaware.com/aeroapi/flights/${encodeURIComponent(faFlightId)}`;

    const response = await axios.get(url, {
      headers: {
        "x-apikey": FLIGHTAWARE_API_KEY
      },
      timeout: 15000
    });

    return response.data;
  } catch (error) {
    console.error(
      "Flight details error:",
      error.response?.data || error.message
    );

    return null;
  }
}

async function getAirlineInfo(faFlightId) {
  if (!faFlightId) {
    return null;
  }

  try {
    const url =
      `https://aeroapi.flightaware.com/aeroapi/flights/${encodeURIComponent(faFlightId)}/airline`;

    const response = await axios.get(url, {
      headers: {
        "x-apikey": FLIGHTAWARE_API_KEY
      },
      timeout: 15000
    });

    return response.data;
  } catch (error) {
    // Gate information isn't available for every flight.
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

async function checkKFLL() {
  try {
    if (!FLIGHTAWARE_API_KEY) {
      console.error("FLIGHTAWARE_API_KEY is missing.");
      return;
    }

    const arrivals = await getRecentArrivals();

    console.log(
      `✈️ KFLL recent arrivals: ${arrivals.length}`
    );

    // JetBlue only
    const jetblueArrivals =
      arrivals.filter(isJetBlue);

    console.log(
      `🔵 JetBlue arrivals found: ${jetblueArrivals.length}`
    );

    for (const arrival of jetblueArrivals) {

      const ident =
        clean(arrival.ident).toUpperCase();

      const flightId =
        clean(arrival.fa_flight_id);

      /*
       * We use the FlightAware flight ID when available
       * so the same flight doesn't get announced twice.
       */
      const uniqueId =
        flightId !== "N/A"
          ? flightId
          : `${ident}-${arrival.actualarrivaltime}`;

      if (announcedFlights.has(uniqueId)) {
        continue;
      }

      // Only announce flights that actually arrived.
      if (
        !arrival.actualarrivaltime ||
        Number(arrival.actualarrivaltime) <= 0
      ) {
        continue;
      }

      /*
       * Make sure KFLL is actually the destination.
       */
      const destination =
        clean(arrival.destination).toUpperCase();

      if (
        destination !== "KFLL" &&
        destination !== "FLL"
      ) {
        continue;
      }

      announcedFlights.add(uniqueId);

      // Get more detailed information
      const details =
        await getFlightDetails(flightId);

      const airlineInfo =
        await getAirlineInfo(flightId);

      const flight =
        details?.flights?.[0] || arrival;

      const gate =
        airlineInfo?.gate_dest ||
        flight?.gate_dest ||
        "Pending";

      const terminal =
        airlineInfo?.terminal_dest ||
        flight?.terminal_dest ||
        "Pending";

      const registration =
        airlineInfo?.tailnumber ||
        flight?.registration ||
        flight?.tailnumber ||
        "N/A";

      const aircraftType =
        flight?.aircraft_type ||
        flight?.aircrafttype ||
        arrival.aircrafttype ||
        "N/A";

      const origin =
        clean(
          flight?.origin?.code ||
          flight?.origin
        );

      const originName =
        clean(
          flight?.origin?.name ||
          arrival.originName ||
          arrival.origin
        );

      const landingTime =
        formatDateTime(
          arrival.actualarrivaltime
        );

      const message =
        `🛬 **JETBLUE ARRIVAL — KFLL**\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `🔵 **JETBLUE AIRWAYS**\n\n` +
        `✈️ **Flight:** ${ident}\n` +
        `📍 **Origin:** ${origin} — ${originName}\n` +
        `🛩️ **Aircraft:** ${aircraftType}\n` +
        `🏷️ **Registration:** ${registration}\n` +
        `🛬 **Status:** LANDED\n` +
        `🚪 **Gate:** ${gate}\n` +
        `🏢 **Terminal:** ${terminal}\n` +
        `⏱️ **Landing:** ${landingTime}\n` +
        `📡 **Source:** FlightAware AeroAPI\n` +
        `━━━━━━━━━━━━━━━━━━━━`;

      await sendDiscord(message);

      console.log(
        `🛬 JETBLUE LANDED: ${ident} | Gate: ${gate}`
      );
    }

  } catch (error) {
    console.error(
      "KFLL JetBlue arrival error:",
      error.response?.data ||
      error.message
    );
  }
}

console.log(
  "🔵 JETBLUE KFLL OPERATIONS FEED"
);

console.log(
  "🛬 ACTUAL ARRIVALS ONLY"
);

console.log(
  "🚪 GATE DATA ENABLED"
);

console.log(
  "📢 Discord webhook:",
  !!WEBHOOK_URL
);

console.log(
  "🔑 FlightAware API:",
  !!FLIGHTAWARE_API_KEY
);

checkKFLL();

// Check every 60 seconds.
// AeroAPI is usage-based, so we don't want to hammer the API.
setInterval(checkKFLL, 60000);
