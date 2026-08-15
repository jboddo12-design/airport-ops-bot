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

// ======================================================
// MEMORY
// ======================================================

const aircraftState = new Map();

const announcedLandings = new Map();

const announcedDepartures = new Map();

const announcedAlerts = new Map();

const announcedStatuses = new Map();

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

function isJetBlue(plane) {

  const flight =
    clean(
      plane.flight
    ).toUpperCase();

  return flight.startsWith("JBU");
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
    !callsign
  ) {
    return null;
  }

  try {

    const url =
      `https://aeroapi.flightaware.com/` +
      `aeroapi/flights/` +
      `${encodeURIComponent(callsign)}`;

    /*
     * IMPORTANT:
     * We intentionally do NOT send the old
     * broken start/end parameters here.
     */

    const response =
      await axios.get(
        url,
        {
          headers: {
            "x-apikey":
              FLIGHTAWARE_API_KEY
          },

          timeout: 10000
        }
      );

    return (
      response.data?.flights?.[0] ||
      null
    );

  } catch (error) {

    console.error(
      `⚠️ FlightAware ${callsign}:`,
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
// ARRIVAL
// ======================================================

async function announceArrival(
  plane
) {

  const callsign =
    clean(
      plane.flight
    ).toUpperCase();

  const hex =
    clean(
      plane.hex
    );

  const landingId =
    `${hex}-${callsign}`;

  // Duplicate protection
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
    `🛬 TOUCHDOWN DETECTED: ${callsign}`
  );

  let origin =
    "N/A";

  let aircraft =
    clean(plane.t);

  let registration =
    clean(plane.r);

  // FlightAware lookup
  const flight =
    await getFlightDetails(
      callsign
    );

  if (flight) {

    origin =
      flight.origin?.code ||
      flight.origin?.airport_code ||
      flight.origin?.iata ||
      "N/A";

    aircraft =
      flight.aircraft_type ||
      aircraft;

    registration =
      flight.registration ||
      flight.tailnumber ||
      registration;

  }

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
    `📡 **Detection:** LIVE ADS-B\n` +
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
    clean(
      plane.hex
    );

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
    `🛫 DEPARTURE DETECTED: ${callsign}`
  );

  let destination =
    "N/A";

  let aircraft =
    clean(plane.t);

  let registration =
    clean(plane.r);

  const flight =
    await getFlightDetails(
      callsign
    );

  if (flight) {

    destination =
      flight.destination?.code ||
      flight.destination?.airport_code ||
      flight.destination?.iata ||
      "N/A";

    aircraft =
      flight.aircraft_type ||
      aircraft;

    registration =
      flight.registration ||
      flight.tailnumber ||
      registration;

  }

  const message =
    `🛫 **JETBLUE DEPARTURE — KFLL**\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🔵 **JETBLUE AIRWAYS**\n\n` +
    `✈️ **Flight:** ${callsign}\n` +
    `📍 **Destination:** ${destination}\n` +
    `🛩️ **Aircraft:** ${aircraft}\n` +
    `🏷️ **Registration:** ${registration}\n` +
    `🛫 **Status:** AIRBORNE\n` +
    `⏱️ **Takeoff:** ${formatTime(
      Date.now()
    )}\n` +
    `📡 **Detection:** LIVE ADS-B\n` +
    `━━━━━━━━━━━━━━━━━━━━`;

  await sendDiscord(
    DEPARTURES_WEBHOOK,
    message
  );

}

// ======================================================
// FLIGHT STATUS
// ======================================================

async function announceFlightStatus(
  plane,
  status
) {

  const callsign =
    clean(
      plane.flight
    ).toUpperCase();

  const hex =
    clean(
      plane.hex
    );

  const statusId =
    `${hex}-${callsign}-${status}`;

  // Don't repeat same status
  if (
    announcedStatuses.has(
      statusId
    )
  ) {
    return;
  }

  announcedStatuses.set(
    statusId,
    Date.now()
  );

  console.log(
    `📋 FLIGHT STATUS: ${callsign} → ${status}`
  );

  let origin =
    "N/A";

  let destination =
    "N/A";

  let aircraft =
    clean(plane.t);

  let registration =
    clean(plane.r);

  const flight =
    await getFlightDetails(
      callsign
    );

  if (flight) {

    origin =
      flight.origin?.code ||
      flight.origin?.airport_code ||
      flight.origin?.iata ||
      "N/A";

    destination =
      flight.destination?.code ||
      flight.destination?.airport_code ||
      flight.destination?.iata ||
      "N/A";

    aircraft =
      flight.aircraft_type ||
      aircraft;

    registration =
      flight.registration ||
      flight.tailnumber ||
      registration;

  }

  const message =
    `📋 **JETBLUE FLIGHT STATUS — KFLL**\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🔵 **JETBLUE AIRWAYS**\n\n` +
    `✈️ **Flight:** ${callsign}\n` +
    `📍 **Origin:** ${origin}\n` +
    `📍 **Destination:** ${destination}\n` +
    `🛩️ **Aircraft:** ${aircraft}\n` +
    `🏷️ **Registration:** ${registration}\n` +
    `📋 **Status:** ${status}\n` +
    `⏱️ **Updated:** ${formatTime(
      Date.now()
    )}\n` +
    `📡 **Source:** LIVE ADS-B\n` +
    `━━━━━━━━━━━━━━━━━━━━`;

  await sendDiscord(
    STATUS_WEBHOOK,
    message
  );

}

// ======================================================
// ALERTS
// ======================================================

async function announceAlert(
  plane,
  alertType,
  details
) {

  const callsign =
    clean(
      plane.flight
    ).toUpperCase();

  const hex =
    clean(
      plane.hex
    );

  const alertId =
    `${hex}-${callsign}-${alertType}`;

  if (
    announcedAlerts.has(
      alertId
    )
  ) {
    return;
  }

  announcedAlerts.set(
    alertId,
    Date.now()
  );

  console.log(
    `🚨 ALERT: ${callsign} — ${alertType}`
  );

  const message =
    `🚨 **JETBLUE OPERATIONS ALERT — KFLL**\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🔵 **JETBLUE AIRWAYS**\n\n` +
    `✈️ **Flight:** ${callsign}\n` +
    `🚨 **Alert:** ${alertType}\n` +
    `📋 **Details:** ${details}\n` +
    `⏱️ **Time:** ${formatTime(
      Date.now()
    )}\n` +
    `📡 **Detection:** LIVE ADS-B\n` +
    `━━━━━━━━━━━━━━━━━━━━`;

  await sendDiscord(
    ALERTS_WEBHOOK,
    message
  );

}

// ======================================================
// KFLL MONITOR
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
        Number(
          plane.lat
        );

      const lon =
        Number(
          plane.lon
        );

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

      const verticalRate =
        Number(
          plane.baro_rate || 0
        );

      const id =
        `${clean(
          plane.hex
        )}-${clean(
          plane.flight
        ).toUpperCase()}`;

      const previous =
        aircraftState.get(
          id
        );

      console.log(
        `   ✈️ ${clean(
          plane.flight
        ).toUpperCase()} | ` +
        `ALT: ${plane.alt_baro} | ` +
        `DIST: ${distance.toFixed(
          1
        )} NM`
      );

      // ==================================================
      // FIRST OBSERVATION
      // ==================================================

      if (!previous) {

        aircraftState.set(
          id,
          {
            distance,
            altitude,
            verticalRate,
            timestamp: now,

            wasAirborne:
              altitude > 500,

            wasGround:
              altitude <= 100,

            lowestAltitude:
              altitude,

            highestAltitude:
              altitude
          }
        );

        continue;
      }

      // ==================================================
      // ARRIVAL DETECTION
      // ==================================================

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
          plane
        );

        await announceFlightStatus(
          plane,
          "LANDED"
        );

      }

      // ==================================================
      // DEPARTURE DETECTION
      // ==================================================

      const wasGround =
        previous.altitude <= 100 ||
        previous.wasGround === true;

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

        await announceFlightStatus(
          plane,
          "AIRBORNE"
        );

      }

      // ==================================================
      // GO-AROUND DETECTION
      // ==================================================

      const nearRunway =
        distance <= 3;

      const lowAltitude =
        altitude >= 100 &&
        altitude <= 1500;

      const climbing =
        verticalRate > 500;

      const previouslyDescending =
        previous.verticalRate < -300;

      if (
        nearRunway &&
        lowAltitude &&
        climbing &&
        previouslyDescending
      ) {

        await announceAlert(
          plane,
          "GO-AROUND / MISSED APPROACH",
          "Aircraft was descending near KFLL and is now climbing."
        );

        await announceFlightStatus(
          plane,
          "GO-AROUND"
        );

      }

      // ==================================================
      // LOW ALTITUDE ALERT
      // ==================================================

      if (
        distance <= 2 &&
        altitude > 100 &&
        altitude < 500 &&
        verticalRate < -1000
      ) {

        await announceAlert(
          plane,
          "LOW ALTITUDE",
          `Aircraft is approximately ${altitude} ft and descending rapidly.`
        );

      }

      // ==================================================
      // UPDATE STATE
      // ==================================================

      aircraftState.set(
        id,
        {
          distance,
          altitude,
          verticalRate,
          timestamp: now,

          wasAirborne:
            previous.wasAirborne ||
            altitude > 500,

          wasGround:
            altitude <= 100,

          lowestAltitude:
            Math.min(
              previous.lowestAltitude ??
              altitude,
              altitude
            ),

          highestAltitude:
            Math.max(
              previous.highestAltitude ??
              altitude,
              altitude
            )
        }
      );

    }

    // ====================================================
    // CLEAN AIRCRAFT MEMORY
    // ====================================================

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

    // ====================================================
    // CLEAN ARRIVALS
    // ====================================================

    for (
      const [
        id,
        timestamp
      ]
      of announcedLandings.entries()
    ) {

      if (
        now -
        timestamp >
        6 *
        60 *
        60 *
        1000
      ) {

        announcedLandings.delete(
          id
        );

      }

    }

    // ====================================================
    // CLEAN DEPARTURES
    // ====================================================

    for (
      const [
        id,
        timestamp
      ]
      of announcedDepartures.entries()
    ) {

      if (
        now -
        timestamp >
        6 *
        60 *
        60 *
        1000
      ) {

        announcedDepartures.delete(
          id
        );

      }

    }

    // ====================================================
    // CLEAN ALERTS
    // ====================================================

    for (
      const [
        id,
        timestamp
      ]
      of announcedAlerts.entries()
    ) {

      if (
        now -
        timestamp >
        6 *
        60 *
        60 *
        1000
      ) {

        announcedAlerts.delete(
          id
        );

      }

    }

    // ====================================================
    // CLEAN STATUSES
    // ====================================================

    for (
      const [
        id,
        timestamp
      ]
      of announcedStatuses.entries()
    ) {

      if (
        now -
        timestamp >
        6 *
        60 *
        60 *
        1000
      ) {

        announcedStatuses.delete(
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
// START
// ======================================================

checkKFLL();

setInterval(
  checkKFLL,
  POLL_INTERVAL
);
