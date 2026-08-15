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

const OPERATIONS_WEBHOOK =
  process.env.DISCORD_OPERATIONS_WEBHOOK;

const ARRIVALS_WEBHOOK =
  process.env.DISCORD_ARRIVALS_WEBHOOK;

const DEPARTURES_WEBHOOK =
  process.env.DISCORD_DEPARTURES_WEBHOOK;

const ALERTS_WEBHOOK =
  process.env.DISCORD_ALERTS_WEBHOOK;

const FLIGHTAWARE_API_KEY =
  process.env.FLIGHTAWARE_API_KEY;

// ======================================================
// KFLL SETTINGS
// ======================================================

const KFLL_LAT = 26.0726;
const KFLL_LON = -80.1527;

const RADIUS_NM = 8;

const POLL_INTERVAL = 5000;

const DASHBOARD_INTERVAL = 30000;

// ======================================================
// MEMORY
// ======================================================

const aircraftState = new Map();

const announcedLandings = new Map();

const announcedDepartures = new Map();

const announcedAlerts = new Map();

// Dashboard state
let dashboardMessageId = null;

let trackedJetBlueCount = 0;

let lastArrival = "None yet";
let lastDeparture = "None yet";

let lastArrivalTime = "N/A";
let lastDepartureTime = "N/A";

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
    "❌ DISCORD_BOT_TOKEN missing"
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

function isJetBlue(plane) {

  const callsign =
    clean(
      plane.flight
    ).toUpperCase();

  return callsign.startsWith("JBU");
}

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

function formatTime(timestamp) {

  return (
    new Intl.DateTimeFormat(
      "en-US",
      {
        timeZone: "America/New_York",
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
// OPERATIONS DASHBOARD
// ======================================================

function buildDashboard() {

  return (
    `🏢 **KFLL OPERATIONS CENTER**\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🟢 **SYSTEM STATUS:** OPERATIONAL\n\n` +

    `🔵 **AIRLINE:** JETBLUE AIRWAYS\n` +
    `📍 **AIRPORT:** KFLL / FLL\n` +
    `📡 **ADS-B:** CONNECTED\n` +
    `🔑 **FLIGHT DATA:** CONNECTED\n` +
    `⚡ **TRACKING:** 5 SECOND POLLING\n\n` +

    `✈️ **JETBLUE AIRCRAFT TRACKED:** ${trackedJetBlueCount}\n\n` +

    `🛬 **LAST ARRIVAL:** ${lastArrival}\n` +
    `⏱️ ${lastArrivalTime}\n\n` +

    `🛫 **LAST DEPARTURE:** ${lastDeparture}\n` +
    `⏱️ ${lastDepartureTime}\n\n` +

    `🕒 **DASHBOARD UPDATED:** ${formatTime(
      Date.now()
    )}\n` +

    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🤖 KFLL OPERATIONS`
  );
}

async function updateOperationsDashboard() {

  if (!OPERATIONS_WEBHOOK) {

    console.error(
      "❌ DISCORD_OPERATIONS_WEBHOOK missing"
    );

    return;
  }

  const content =
    buildDashboard();

  try {

    // First run creates the dashboard message
    if (!dashboardMessageId) {

      const separator =
        OPERATIONS_WEBHOOK.includes("?")
          ? "&"
          : "?";

      const response =
        await axios.post(
          `${OPERATIONS_WEBHOOK}${separator}wait=true`,
          {
            content
          },
          {
            timeout: 10000
          }
        );

      dashboardMessageId =
        response.data.id;

      console.log(
        "🏢 Operations dashboard created"
      );

      return;
    }

    // Future runs edit the same message
    await axios.patch(
      `${OPERATIONS_WEBHOOK}/messages/${dashboardMessageId}`,
      {
        content
      },
      {
        timeout: 10000
      }
    );

    console.log(
      "🏢 Operations dashboard updated"
    );

  } catch (error) {

    console.error(
      "❌ Dashboard error:",
      error.response?.data ||
      error.message
    );

    // Recreate if Discord message was deleted
    if (
      error.response?.status === 404
    ) {
      dashboardMessageId = null;
    }
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

  const eventTime =
    Date.now();

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
      eventTime
    )}\n` +
    `📡 **Detection:** LIVE ADS-B\n` +
    `━━━━━━━━━━━━━━━━━━━━`;

  await sendDiscord(
    ARRIVALS_WEBHOOK,
    message
  );

  lastArrival =
    callsign;

  lastArrivalTime =
    formatTime(
      eventTime
    );

  await updateOperationsDashboard();
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

  const eventTime =
    Date.now();

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
      eventTime
    )}\n` +
    `📡 **Detection:** LIVE ADS-B\n` +
    `━━━━━━━━━━━━━━━━━━━━`;

  await sendDiscord(
    DEPARTURES_WEBHOOK,
    message
  );

  lastDeparture =
    callsign;

  lastDepartureTime =
    formatTime(
      eventTime
    );

  await updateOperationsDashboard();
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
// MAIN KFLL MONITOR
// ======================================================

async function checkKFLL() {

  try {

    const aircraft =
      await getAircraft();

    const jetblue =
      aircraft.filter(
        isJetBlue
      );

    trackedJetBlueCount =
      jetblue.length;

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
        `DIST: ${distance.toFixed(1)} NM`
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
              altitude <= 100
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
      }

      // ==================================================
      // POSSIBLE GO-AROUND DETECTION
      // ==================================================

      const nearAirport =
        distance <= 3;

      const approachAltitude =
        altitude >= 100 &&
        altitude <= 1500;

      const nowClimbing =
        verticalRate > 700;

      const wasDescending =
        previous.verticalRate < -300;

      if (
        nearAirport &&
        approachAltitude &&
        nowClimbing &&
        wasDescending
      ) {

        await announceAlert(
          plane,
          "POSSIBLE GO-AROUND",
          "Aircraft transitioned from descent to a strong climb near KFLL."
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
            altitude <= 100
        }
      );
    }

    // ====================================================
    // CLEAN STALE AIRCRAFT
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
    // CLEAN DUPLICATE LOCKS
    // ====================================================

    const sixHours =
      6 *
      60 *
      60 *
      1000;

    for (
      const map of [
        announcedLandings,
        announcedDepartures,
        announcedAlerts
      ]
    ) {

      for (
        const [
          id,
          timestamp
        ]
        of map.entries()
      ) {

        if (
          now -
          timestamp >
          sixHours
        ) {

          map.delete(
            id
          );
        }
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
  "🏢 OPERATIONS DASHBOARD ENABLED"
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
  "⚡ 5 SECOND POLLING"
);

console.log(
  "📢 Operations:",
  !!OPERATIONS_WEBHOOK
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
  "🔑 FlightAware:",
  !!FLIGHTAWARE_API_KEY
);

// ======================================================
// START
// ======================================================

checkKFLL();

updateOperationsDashboard();

setInterval(
  checkKFLL,
  POLL_INTERVAL
);

setInterval(
  updateOperationsDashboard,
  DASHBOARD_INTERVAL
);
