const axios = require("axios");
const {
  Client,
  GatewayIntentBits,
  ActivityType
} = require("discord.js");

// ======================================================
// ENVIRONMENT VARIABLES
// ======================================================

const DISCORD_BOT_TOKEN =
  process.env.DISCORD_BOT_TOKEN;

const ARRIVALS_WEBHOOK =
  process.env.DISCORD_ARRIVALS_WEBHOOK;

const DEPARTURES_WEBHOOK =
  process.env.DISCORD_DEPARTURES_WEBHOOK;

const ALERTS_WEBHOOK =
  process.env.DISCORD_ALERTS_WEBHOOK;

const STATUS_WEBHOOK =
  process.env.DISCORD_FLIGHT_STATUS_WEBHOOK;

const FLIGHTAWARE_API_KEY =
  process.env.FLIGHTAWARE_API_KEY;

// ======================================================
// KFLL
// ======================================================

const KFLL_LAT = 26.0726;
const KFLL_LON = -80.1527;

const RADIUS_NM = 8;

// ADS-B polling
const POLL_INTERVAL = 5000;

// Recent-arrival recovery polling
const RECENT_ARRIVAL_INTERVAL = 60000;

// ======================================================
// DISCORD BOT
// ======================================================

const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds
  ]
});

discordClient.once(
  "clientReady",
  () => {

    console.log(
      `🟢 Discord bot online as ${discordClient.user.tag}`
    );

    discordClient.user.setPresence({
      activities: [
        {
          name: "JetBlue operations at KFLL",
          type: ActivityType.Watching
        }
      ],
      status: "online"
    });

  }
);

if (DISCORD_BOT_TOKEN) {

  discordClient
    .login(DISCORD_BOT_TOKEN)
    .catch(error => {

      console.error(
        "❌ Discord login failed:",
        error.message
      );

    });

} else {

  console.error(
    "❌ DISCORD_BOT_TOKEN is missing"
  );
}

// ======================================================
// MEMORY
// ======================================================

const aircraftState = new Map();

const announcedLandings = new Map();

const announcedDepartures = new Map();

// ======================================================
// HELPERS
// ======================================================

function clean(value) {

  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {

    return "N/A";
  }

  return String(value).trim();
}

// ------------------------------------------------------

function isJetBlueCallsign(callsign) {

  return clean(
    callsign
  )
    .toUpperCase()
    .startsWith("JBU");

}

// ------------------------------------------------------

function isJetBlue(plane) {

  return isJetBlueCallsign(
    plane.flight
  );

}

// ------------------------------------------------------

function distanceNM(
  lat1,
  lon1,
  lat2,
  lon2
) {

  const R = 3440.065;

  const dLat =
    (lat2 - lat1) *
    Math.PI /
    180;

  const dLon =
    (lon2 - lon1) *
    Math.PI /
    180;

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(
      lat1 * Math.PI / 180
    ) *
    Math.cos(
      lat2 * Math.PI / 180
    ) *
    Math.sin(dLon / 2) ** 2;

  return (
    R *
    2 *
    Math.atan2(
      Math.sqrt(a),
      Math.sqrt(1 - a)
    )
  );

}

// ------------------------------------------------------

function formatTime(timestamp) {

  return (
    new Intl.DateTimeFormat(
      "en-US",
      {
        timeZone:
          "America/New_York",

        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",

        hour12: false
      }
    ).format(
      new Date(timestamp)
    ) + " EDT"
  );

}

// ======================================================
// ADS-B
// ======================================================

async function getAircraft() {

  const url =
    `https://api.adsb.lol/v2/point/` +
    `${KFLL_LAT}/` +
    `${KFLL_LON}/` +
    `${RADIUS_NM}`;

  const response =
    await axios.get(
      url,
      {
        timeout: 10000
      }
    );

  return response.data.ac || [];

}

// ======================================================
// FLIGHTAWARE
// ======================================================

async function getFlightDetails(
  callsign
) {

  if (
    !FLIGHTAWARE_API_KEY ||
    !callsign ||
    callsign === "N/A"
  ) {

    return null;
  }

  try {

    const url =
      `https://aeroapi.flightaware.com/` +
      `aeroapi/flights/` +
      `${encodeURIComponent(callsign)}`;

    const response =
      await axios.get(
        url,
        {
          headers: {
            "x-apikey":
              FLIGHTAWARE_API_KEY
          },

          params: {

            start:
              new Date(
                Date.now() -
                12 *
                60 *
                60 *
                1000
              ).toISOString(),

            end:
              new Date(
                Date.now() +
                6 *
                60 *
                60 *
                1000
              ).toISOString()

          },

          timeout: 10000
        }
      );

    const flights =
      response.data?.flights || [];

    if (!flights.length) {

      return null;
    }

    // Prefer a flight that actually involves KFLL

    const relevant =
      flights.find(
        flight => {

          const origin =
            flight.origin?.code ||
            flight.origin?.airport_code;

          const destination =
            flight.destination?.code ||
            flight.destination?.airport_code;

          return (
            origin === "KFLL" ||
            origin === "FLL" ||
            destination === "KFLL" ||
            destination === "FLL"
          );

        }
      );

    return relevant || flights[0];

  } catch (error) {

    console.error(
      `FlightAware ${callsign}:`,
      error.response?.data ||
      error.message
    );

    return null;
  }

}

// ======================================================
// DISCORD WEBHOOK
// ======================================================

async function sendDiscord(
  webhook,
  message
) {

  if (!webhook) {

    console.error(
      "❌ Discord webhook missing"
    );

    return false;
  }

  try {

    await axios.post(
      webhook,
      {
        content: message
      },
      {
        timeout: 10000
      }
    );

    console.log(
      "📢 Discord message sent"
    );

    return true;

  } catch (error) {

    console.error(
      "❌ Discord webhook error:",
      error.response?.data ||
      error.message
    );

    return false;
  }

}

// ======================================================
// FLIGHT INFORMATION
// ======================================================

function extractFlightInfo(
  flight,
  plane = {}
) {

  let origin = "N/A";
  let destination = "N/A";
  let gate = "Pending";
  let terminal = "Pending";

  let aircraft =
    clean(plane.t);

  let registration =
    clean(plane.r);

  if (flight) {

    origin =
      flight.origin?.code ||
      flight.origin?.airport_code ||
      flight.origin ||
      "N/A";

    destination =
      flight.destination?.code ||
      flight.destination?.airport_code ||
      flight.destination ||
      "N/A";

    aircraft =
      flight.aircraft_type ||
      flight.aircraft ||
      aircraft;

    registration =
      flight.registration ||
      flight.tailnumber ||
      registration;

    gate =
      flight.gate_dest ||
      flight.gate ||
      "Pending";

    terminal =
      flight.terminal_dest ||
      flight.terminal ||
      "Pending";
  }

  return {
    origin,
    destination,
    gate,
    terminal,
    aircraft,
    registration
  };

}

// ======================================================
// ARRIVAL
// ======================================================

async function announceArrival(
  plane,
  source = "LIVE ADS-B"
) {

  const callsign =
    clean(
      plane.flight
    ).toUpperCase();

  const hex =
    clean(plane.hex);

  if (
    !isJetBlueCallsign(
      callsign
    )
  ) {
    return;
  }

  const landingId =
    `${hex}-${callsign}`;

  // Prevent duplicate arrival alerts
  if (
    announcedLandings.has(
      landingId
    )
  ) {
    return;
  }

  announcedLandings.set(
    landingId,
    Date.now()
  );

  console.log(
    `🛬 ARRIVAL: ${callsign} (${source})`
  );

  // Get FlightAware information
  const flight =
    await getFlightDetails(
      callsign
    );

  // --------------------------------------------------
  // AIRCRAFT INFORMATION
  // --------------------------------------------------

  let origin = "N/A";

  let aircraft =
    clean(plane.t);

  let registration =
    clean(plane.r);

  if (flight) {

    // FlightAware origin
    origin =
      flight.origin?.code ||
      flight.origin?.airport_code ||
      flight.origin?.iata ||
      "N/A";

    // Aircraft
    aircraft =
      flight.aircraft_type ||
      flight.aircraft ||
      aircraft;

    // Registration
    registration =
      flight.registration ||
      flight.tailnumber ||
      registration;
  }

  // --------------------------------------------------
  // DISCORD MESSAGE
  // --------------------------------------------------

  const message =
    `🛬 **JETBLUE ARRIVAL — KFLL**\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🔵 **JETBLUE AIRWAYS**\n\n` +
    `✈️ **Flight:** ${callsign}\n` +
    `📍 **Origin:** ${origin}\n` +
    `🛩️ **Aircraft:** ${aircraft}\n` +
    `🏷️ **Registration:** ${registration}\n` +
    `🛬 **Status:** LANDED\n` +
    `⏱️ **Touchdown:** ${formatTime(
      Date.now()
    )}\n` +
    `📡 **Detection:** ${source}\n` +
    `━━━━━━━━━━━━━━━━━━━━`;

  await sendDiscord(
    ARRIVALS_WEBHOOK,
    message
  );
}

  const callsign =
    clean(
      plane.flight
    ).toUpperCase();

  const hex =
    clean(plane.hex);

  if (
    !isJetBlueCallsign(
      callsign
    )
  ) {

    return;
  }

  const landingId =
    `${hex}-${callsign}`;

  if (
    announcedLandings.has(
      landingId
    )
  ) {

    return;
  }

  // Mark immediately to prevent duplicates

  announcedLandings.set(
    landingId,
    Date.now()
  );

  console.log(
    `🛬 ARRIVAL: ${callsign} (${source})`
  );

  const flight =
    await getFlightDetails(
      callsign
    );

  const info =
    extractFlightInfo(
      flight,
      plane
    );

  const message =
    `🛬 **JETBLUE ARRIVAL — KFLL**\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🔵 **JETBLUE AIRWAYS**\n\n` +
    `✈️ **Flight:** ${callsign}\n` +
    `📍 **Origin:** ${info.origin}\n` +
    `🛩️ **Aircraft:** ${info.aircraft}\n` +
    `🏷️ **Registration:** ${info.registration}\n` +
    `🛬 **Status:** LANDED\n` +
    `🚪 **Gate:** ${info.gate}\n` +
    `🏢 **Terminal:** ${info.terminal}\n` +
    `⏱️ **Touchdown:** ${formatTime(
      Date.now()
    )}\n` +
    `📡 **Detection:** ${source}\n` +
    `━━━━━━━━━━━━━━━━━━━━`;

  await sendDiscord(
    ARRIVALS_WEBHOOK,
    message
  );

}

// ======================================================
// DEPARTURE
// ======================================================

async function announceDeparture(
  plane
) {

  const callsign =
    clean(
      plane.flight
    ).toUpperCase();

  const hex =
    clean(plane.hex);

  if (
    !isJetBlueCallsign(
      callsign
    )
  ) {

    return;
  }

  const departureId =
    `${hex}-${callsign}`;

  if (
    announcedDepartures.has(
      departureId
    )
  ) {

    return;
  }

  announcedDepartures.set(
    departureId,
    Date.now()
  );

  console.log(
    `🛫 DEPARTURE: ${callsign}`
  );

  const flight =
    await getFlightDetails(
      callsign
    );

  const info =
    extractFlightInfo(
      flight,
      plane
    );

  const message =
    `🛫 **JETBLUE DEPARTURE — KFLL**\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🔵 **JETBLUE AIRWAYS**\n\n` +
    `✈️ **Flight:** ${callsign}\n` +
    `📍 **Destination:** ${info.destination}\n` +
    `🛩️ **Aircraft:** ${info.aircraft}\n` +
    `🏷️ **Registration:** ${info.registration}\n` +
    `🛫 **Status:** AIRBORNE\n` +
    `🚪 **Gate:** ${info.gate}\n` +
    `🏢 **Terminal:** ${info.terminal}\n` +
    `⏱️ **Takeoff:** ${formatTime(
      Date.now()
    )}\n` +
    `📡 **Detection:** Live ADS-B\n` +
    `━━━━━━━━━━━━━━━━━━━━`;

  await sendDiscord(
    DEPARTURES_WEBHOOK,
    message
  );

}

// ======================================================
// LIVE TOUCHDOWN MONITOR
// ======================================================

async function checkKFLL() {

  try {

    const aircraft =
      await getAircraft();

    const jetblue =
      aircraft.filter(
        isJetBlue
      );

    console.log(
      `🔵 JBU aircraft near KFLL: ${jetblue.length}`
    );

    const now =
      Date.now();

    for (
      const plane of jetblue
    ) {

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
          : Number(
              plane.alt_baro || 0
            );

      const id =
        `${clean(
          plane.hex
        )}-${clean(
          plane.flight
        ).toUpperCase()}`;

      console.log(
        `   ✈️ ${clean(
          plane.flight
        ).toUpperCase()} | ` +
        `ALT: ${plane.alt_baro} | ` +
        `DIST: ${distance.toFixed(1)} NM`
      );

      const previous =
        aircraftState.get(id);

      // ----------------------------------------------
      // First observation
      // ----------------------------------------------

      if (!previous) {

        aircraftState.set(
          id,
          {
            distance,
            altitude,
            timestamp: now,

            wasAirborne:
              altitude > 500,

            wasNearAirport:
              distance <= 2
          }
        );

        continue;
      }

      // ----------------------------------------------
      // ARRIVAL
      // ----------------------------------------------

      const wasAirborne =
        previous.altitude > 500 ||
        previous.wasAirborne === true;

      const wasApproaching =
        distance <
        previous.distance;

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

        await announceArrival(
          plane,
          "LIVE ADS-B TOUCHDOWN"
        );

      }

      // ----------------------------------------------
      // DEPARTURE
      // ----------------------------------------------

      const wasGround =
        previous.altitude <= 100;

      const nowAirborne =
        altitude > 500;

      const wasAtAirport =
        previous.distance <= 1.5;

      const movingAway =
        distance >
        previous.distance;

      if (
        wasGround &&
        nowAirborne &&
        wasAtAirport &&
        movingAway
      ) {

        await announceDeparture(
          plane
        );

      }

      // ----------------------------------------------
      // Update state
      // ----------------------------------------------

      aircraftState.set(
        id,
        {
          distance,
          altitude,
          timestamp: now,

          wasAirborne:
            previous.wasAirborne ||
            altitude > 500,

          wasNearAirport:
            distance <= 2
        }
      );

    }

    // ----------------------------------------------
    // Clean old aircraft
    // ----------------------------------------------

    for (
      const [
        id,
        state
      ]
      of aircraftState.entries()
    ) {

      if (
        now -
        state.timestamp >
        15 *
        60 *
        1000
      ) {

        aircraftState.delete(
          id
        );
      }

    }

  } catch (error) {

    console.error(
      "❌ KFLL ADS-B error:",
      error.response?.data ||
      error.message
    );

  }

}

// ======================================================
// RECENT FLIGHTAWARE ARRIVAL RECOVERY
// ======================================================

async function checkRecentArrivals() {

  if (!FLIGHTAWARE_API_KEY) {

    return;
  }

  try {

    console.log(
      "🔎 Checking recent JetBlue KFLL arrivals..."
    );

    /*
     * We use FlightAware's airport flights endpoint
     * to recover arrivals that may have happened while
     * the bot was restarting or temporarily offline.
     */

    const url =
      "https://aeroapi.flightaware.com/" +
      "aeroapi/airports/KFLL/flights/arrivals";

    const response =
      await axios.get(
        url,
        {
          headers: {
            "x-apikey":
              FLIGHTAWARE_API_KEY
          },

          params: {

            start:
              new Date(
                Date.now() -
                30 *
                60 *
                1000
              ).toISOString(),

            end:
              new Date().toISOString(),

            max_pages: 1

          },

          timeout: 15000
        }
      );

    const flights =
      response.data?.arrivals ||
      response.data?.flights ||
      [];

    console.log(
      `🔎 FlightAware returned ${flights.length} recent arrivals`
    );

    for (
      const flight of flights
    ) {

      const ident =
        clean(
          flight.ident ||
          flight.callsign ||
          flight.flight
        ).toUpperCase();

      if (
        !ident.startsWith("JBU")
      ) {

        continue;
      }

      const destination =
        flight.destination?.code ||
        flight.destination?.airport_code;

      if (
        destination &&
        destination !== "KFLL" &&
        destination !== "FLL"
      ) {

        continue;
      }

      /*
       * Only recover flights that FlightAware
       * indicates have actually arrived.
       */

      const actualArrival =
        flight.actual_on ||
        flight.actual_arrival_time ||
        flight.actual_arrival;

      if (!actualArrival) {

        continue;
      }

      const hex =
        clean(
          flight.registration ||
          flight.tailnumber ||
          ident
        );

      const landingId =
        `FA-${hex}-${ident}`;

      if (
        announcedLandings.has(
          landingId
        )
      ) {

        continue;
      }

      /*
       * Build a plane-like object so the normal
       * arrival formatter can be reused.
       */

      const plane = {

        flight: ident,

        hex,

        r:
          flight.registration ||
          flight.tailnumber ||
          "N/A",

        t:
          flight.aircraft_type ||
          "N/A"

      };

      announcedLandings.set(
        landingId,
        Date.now()
      );

      const info =
        extractFlightInfo(
          flight,
          plane
        );

      const message =
        `🛬 **JETBLUE ARRIVAL — KFLL**\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `🔵 **JETBLUE AIRWAYS**\n\n` +
        `✈️ **Flight:** ${ident}\n` +
        `📍 **Origin:** ${info.origin}\n` +
        `🛩️ **Aircraft:** ${info.aircraft}\n` +
        `🏷️ **Registration:** ${info.registration}\n` +
        `🛬 **Status:** LANDED\n` +
        `🚪 **Gate:** ${info.gate}\n` +
        `🏢 **Terminal:** ${info.terminal}\n` +
        `⏱️ **Arrival:** ${formatTime(
          new Date(
            actualArrival
          ).getTime()
        )}\n` +
        `📡 **Detection:** FlightAware recovery\n` +
        `━━━━━━━━━━━━━━━━━━━━`;

      await sendDiscord(
        ARRIVALS_WEBHOOK,
        message
      );

      console.log(
        `📋 Recovered arrival: ${ident}`
      );

    }

  } catch (error) {

    console.error(
      "❌ Recent arrival check:",
      error.response?.data ||
      error.message
    );

  }

}

// ======================================================
// STARTUP
// ======================================================

console.log(
  "🔵 JETBLUE KFLL OPERATIONS"
);

console.log(
  "🛬 ARRIVALS ENABLED"
);

console.log(
  "🛫 DEPARTURES ENABLED"
);

console.log(
  "🚨 ALERTS ENABLED"
);

console.log(
  "📋 FLIGHT STATUS ENABLED"
);

console.log(
  "⚡ 5 SECOND POLLING"
);

console.log(
  "📢 Arrivals:",
  !!ARRIVALS_WEBHOOK
);

console.log(
  "📢 Departures:",
  !!DEPARTURES_WEBHOOK
);

console.log(
  "📢 Alerts:",
  !!ALERTS_WEBHOOK
);

console.log(
  "📢 Flight Status:",
  !!STATUS_WEBHOOK
);

console.log(
  "🔑 FlightAware:",
  !!FLIGHTAWARE_API_KEY
);

// ======================================================
// START MONITORS
// ======================================================

checkKFLL();

checkRecentArrivals();

setInterval(
  checkKFLL,
  POLL_INTERVAL
);

setInterval(
  checkRecentArrivals,
  RECENT_ARRIVAL_INTERVAL
);
