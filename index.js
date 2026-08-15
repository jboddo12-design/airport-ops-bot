const axios = require("axios");
const { Client, GatewayIntentBits, ActivityType } = require("discord.js");
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;

const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds
  ]
});

discordClient.once("ready", () => {
  console.log(`🟢 Discord bot online as ${discordClient.user.tag}`);

  discordClient.user.setPresence({
    activities: [
      {
        name: "JetBlue operations at KFLL",
        type: ActivityType.Watching
      }
    ],
    status: "online"
  });
});

discordClient.login(DISCORD_BOT_TOKEN).catch((error) => {
  console.error("❌ Discord login failed:", error.message);
});

// ===============================
// DISCORD WEBHOOKS
// ===============================

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

// ===============================
// KFLL SETTINGS
// ===============================

const KFLL_LAT = 26.0726;
const KFLL_LON = -80.1527;

const RADIUS_NM = 8;

const POLL_INTERVAL = 5000;

// ===============================
// AIRCRAFT MEMORY
// ===============================

const aircraftState = new Map();
const announcedLandings = new Map();
const announcedDepartures = new Map();

// ===============================
// HELPERS
// ===============================

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
  const flight =
    clean(plane.flight).toUpperCase();

  return (
    flight.startsWith("JBU") ||
    flight.startsWith("B6")
  );
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
    ) +
    " EDT"
  );
}

// ===============================
// GET AIRCRAFT FROM ADS-B
// ===============================

async function getAircraft() {
  const url =
    `https://api.adsb.lol/v2/point/` +
    `${KFLL_LAT}/${KFLL_LON}/${RADIUS_NM}`;

  const response =
    await axios.get(url, {
      timeout: 10000
    });

  return response.data.ac || [];
}

// ===============================
// FLIGHTAWARE LOOKUP
// ===============================

async function getFlightDetails(callsign) {
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
      await axios.get(url, {
        headers: {
          "x-apikey":
            FLIGHTAWARE_API_KEY
        },
        params: {
          start:
            new Date(
              Date.now() -
              6 * 60 * 60 * 1000
            ).toISOString(),

          end:
            new Date(
              Date.now() +
              6 * 60 * 60 * 1000
            ).toISOString()
        },
        timeout: 10000
      });

    return (
      response.data?.flights?.[0] ||
      null
    );

  } catch (error) {
    console.error(
      "FlightAware lookup:",
      error.response?.data ||
      error.message
    );

    return null;
  }
}

// ===============================
// SEND DISCORD MESSAGE
// ===============================

async function sendDiscord(
  webhook,
  message
) {
  if (!webhook) {
    console.error(
      "Discord webhook missing."
    );
    return;
  }

  try {
    await axios.post(
      webhook,
      {
        content: message
      }
    );

  } catch (error) {
    console.error(
      "Discord webhook error:",
      error.response?.data ||
      error.message
    );
  }
}

// ===============================
// ARRIVAL ANNOUNCEMENT
// ===============================

async function announceArrival(
  plane
) {
  const callsign =
    clean(
      plane.flight
    ).toUpperCase();

  const hex =
    clean(plane.hex);

  const registration =
    clean(plane.r);

  const aircraftType =
    clean(plane.t);

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

  const flight =
    await getFlightDetails(
      callsign
    );

  let origin = "N/A";
  let gate = "Pending";
  let terminal = "Pending";

  let finalAircraft =
    aircraftType;

  let finalRegistration =
    registration;

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
    `⏱️ **Touchdown:** ${formatTime(
      Date.now()
    )}\n` +
    `📡 **Detection:** Live ADS-B\n` +
    `━━━━━━━━━━━━━━━━━━━━`;

  await sendDiscord(
    ARRIVALS_WEBHOOK,
    message
  );
}

// ===============================
// DEPARTURE ANNOUNCEMENT
// ===============================

async function announceDeparture(
  plane
) {
  const callsign =
    clean(
      plane.flight
    ).toUpperCase();

  const hex =
    clean(plane.hex);

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

  const flight =
    await getFlightDetails(
      callsign
    );

  let destination = "N/A";
  let gate = "Pending";
  let terminal = "Pending";

  let aircraftType =
    clean(plane.t);

  let registration =
    clean(plane.r);

  if (flight) {
    if (flight.destination) {
      destination =
        flight.destination.code ||
        flight.destination;
    }

    aircraftType =
      flight.aircraft_type ||
      aircraftType;

    registration =
      flight.registration ||
      flight.tailnumber ||
      registration;

    gate =
      flight.gate_orig ||
      flight.gate ||
      "Pending";

    terminal =
      flight.terminal_orig ||
      flight.terminal ||
      "Pending";
  }

  const message =
    `🛫 **JETBLUE DEPARTURE — KFLL**\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🔵 **JETBLUE AIRWAYS**\n\n` +
    `✈️ **Flight:** ${callsign}\n` +
    `📍 **Destination:** ${destination}\n` +
    `🛩️ **Aircraft:** ${aircraftType}\n` +
    `🏷️ **Registration:** ${registration}\n` +
    `🛫 **Status:** AIRBORNE\n` +
    `🚪 **Gate:** ${gate}\n` +
    `🏢 **Terminal:** ${terminal}\n` +
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

// ===============================
// MAIN KFLL MONITOR
// ===============================

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

    // Show aircraft being tracked
    jetblue.forEach(
      (plane) => {
        if (
          plane.lat === undefined ||
          plane.lon === undefined
        ) {
          return;
        }

        const distance =
          distanceNM(
            Number(plane.lat),
            Number(plane.lon),
            KFLL_LAT,
            KFLL_LON
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
      }
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
        aircraftState.get(id);

      const current = {
        distance,
        altitude,
        verticalRate,
        lat,
        lon,
        timestamp: now
      };

      aircraftState.set(
        id,
        current
      );

      if (!previous) {
        continue;
      }

      // ===========================
      // ARRIVAL DETECTION
      // ===========================

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
        await announceArrival(
          plane
        );
      }

      // ===========================
      // DEPARTURE DETECTION
      // ===========================

      const wasOnGround =
        previous.altitude <= 100;

      const isAirborne =
        altitude > 500;

      const wasAtAirport =
        previous.distance <= 1.5;

      const leavingAirport =
        distance >
        previous.distance;

      if (
        wasOnGround &&
        isAirborne &&
        wasAtAirport &&
        leavingAirport
      ) {
        await announceDeparture(
          plane
        );
      }
    }

    // ===========================
    // CLEAN OLD AIRCRAFT
    // ===========================

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
        15 * 60 * 1000
      ) {
        aircraftState.delete(
          id
        );
      }
    }

    // ===========================
    // CLEAN OLD ARRIVALS
    // ===========================

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
        6 * 60 * 60 * 1000
      ) {
        announcedLandings.delete(
          id
        );
      }
    }

    // ===========================
    // CLEAN OLD DEPARTURES
    // ===========================

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
        6 * 60 * 60 * 1000
      ) {
        announcedDepartures.delete(
          id
        );
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

// ===============================
// START BOT
// ===============================

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

checkKFLL();

setInterval(
  checkKFLL,
  POLL_INTERVAL
);
