const axios = require("axios");
const { Client, GatewayIntentBits, ActivityType } = require("discord.js");

// ======================================================
// ENVIRONMENT VARIABLES
// ======================================================
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const ARRIVALS_WEBHOOK = process.env.DISCORD_ARRIVALS_WEBHOOK;
const ALERTS_WEBHOOK = process.env.DISCORD_ALERTS_WEBHOOK;
const TRACKING_WEBHOOK = process.env.DISCORD_TRACKING_WEBHOOK;
const WEATHER_WEBHOOK = process.env.DISCORD_WEATHER_WEBHOOK;
const OPERATIONS_WEBHOOK =
  process.env.DISCORD_OPERATIONS_WEBHOOK ||
  process.env.DISCORD_FLIGHT_STATUS_WEBHOOK;
const FLIGHTAWARE_API_KEY = process.env.FLIGHTAWARE_API_KEY;

// ======================================================
// KFLL SETTINGS
// ======================================================
const KFLL_LAT = 26.0726;
const KFLL_LON = -80.1527;

// Keep the proven arrival monitor fast and local.
const ARRIVAL_RADIUS_NM = 8;
const ARRIVAL_POLL_INTERVAL = 5000;

// Separate long-range tracking so it does not interfere with arrivals.
const TRACKING_RADIUS_NM = 80;
const TRACKING_POLL_INTERVAL = 60000;

const OPS_POLL_INTERVAL = 120000;
const WEATHER_POLL_INTERVAL = 300000;
const DELAY_THRESHOLD_SECONDS = 30 * 60;

// ======================================================
// MEMORY
// ======================================================
const aircraftState = new Map();
const announcedLandings = new Map();
const announcedDepartures = new Map();
const trackingState = new Map();
const announcedTracking = new Map();
const opsState = new Map();
const weatherAlertsSeen = new Map();
const recentlyDeparted = new Map();

// ======================================================
// DISCORD BOT
// ======================================================
const discordClient = new Client({
  intents: [GatewayIntentBits.Guilds]
});

discordClient.once("clientReady", () => {
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

if (DISCORD_BOT_TOKEN) {
  discordClient.login(DISCORD_BOT_TOKEN).catch(error => {
    console.error("❌ Discord login failed:", error.message);
  });
} else {
  console.error("❌ DISCORD_BOT_TOKEN is missing");
}

// ======================================================
// HELPERS
// ======================================================
function clean(value) {
  if (value === null || value === undefined || value === "") {
    return "N/A";
  }

  return String(value).trim();
}

function isJetBlue(plane) {
  return clean(plane.flight).toUpperCase().startsWith("JBU");
}

function isJetBlueFlight(flight) {
  const ident = clean(
    flight.ident_icao ||
    flight.ident ||
    flight.ident_iata
  ).toUpperCase();

  const operator = clean(
    flight.operator_icao ||
    flight.operator ||
    flight.operator_iata
  ).toUpperCase();

  return (
    ident.startsWith("JBU") ||
    ident.startsWith("B6") ||
    operator === "JBU" ||
    operator === "B6"
  );
}

function flightCallsign(flight) {
  return clean(
    flight.ident_icao ||
    flight.ident ||
    flight.ident_iata
  ).toUpperCase();
}

function airportCode(airport) {
  return clean(
    airport?.code_iata ||
    airport?.code ||
    airport?.airport_code ||
    airport?.iata ||
    airport?.code_icao
  ).toUpperCase();
}

function distanceNM(lat1, lon1, lat2, lon2) {
  const R = 3440.065;

  const dLat =
    ((lat2 - lat1) * Math.PI) /
    180;

  const dLon =
    ((lon2 - lon1) * Math.PI) /
    180;

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
    Math.cos((lat2 * Math.PI) / 180) *
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
  if (!timestamp) {
    return "N/A";
  }

  const date =
    timestamp instanceof Date
      ? timestamp
      : new Date(timestamp);

  if (Number.isNaN(date.getTime())) {
    return "N/A";
  }

  return (
    new Intl.DateTimeFormat(
      "en-US",
      {
        timeZone: "America/New_York",
        hour: "2-digit",
        minute: "2-digit",
        hour12: true
      }
    ).format(date) +
    " ET"
  );
}

function formatMinutes(seconds) {
  if (
    !Number.isFinite(
      Number(seconds)
    )
  ) {
    return "N/A";
  }

  return Math.round(
    Number(seconds) /
    60
  );
}

function estimatedMinutesOut(
  distance,
  plane
) {
  const speed =
    Number(plane.gs);

  if (
    !Number.isFinite(speed) ||
    speed < 30
  ) {
    return null;
  }

  return (
    distance /
    speed *
    60
  );
}

function flightTimeValue(flight) {
  const value =
    flight.estimated_on ||
    flight.estimated_in ||
    flight.scheduled_on ||
    flight.scheduled_in ||
    flight.estimated_off ||
    flight.scheduled_off;

  const time =
    value
      ? new Date(value).getTime()
      : Date.now();

  return Number.isFinite(time)
    ? time
    : Date.now();
}

// ======================================================
// ADS-B
// ======================================================
async function getAircraft(radius) {
  const url =
    `https://api.adsb.lol/v2/point/` +
    `${KFLL_LAT}/` +
    `${KFLL_LON}/` +
    `${radius}`;

  const response =
    await axios.get(
      url,
      {
        timeout: 10000
      }
    );

  return (
    response.data.ac ||
    []
  );
}

// ======================================================
// FLIGHTAWARE
// ======================================================
async function flightAwareGet(
  path,
  params = {}
) {
  if (!FLIGHTAWARE_API_KEY) {
    return null;
  }

  try {
    const response =
      await axios.get(
        `https://aeroapi.flightaware.com/aeroapi${path}`,
        {
          headers: {
            "x-apikey":
              FLIGHTAWARE_API_KEY
          },

          params,

          timeout: 15000
        }
      );

    return response.data;

  } catch (error) {
    console.error(
      `❌ FlightAware ${path}:`,
      error.response?.data ||
      error.message
    );

    return null;
  }
}

// ======================================================
// FLIGHT DETAILS
//
// Picks the current flight instance actually headed to FLL.
// This should fix tracking showing N/A for the origin.
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

  const data =
    await flightAwareGet(
      `/flights/${encodeURIComponent(callsign)}`
    );

  const flights =
    data?.flights ||
    [];

  if (!flights.length) {
    return null;
  }

  const fllFlights =
    flights.filter(
      flight => {
        const destination =
          airportCode(
            flight.destination
          );

        return (
          destination === "FLL" ||
          destination === "KFLL"
        );
      }
    );

  const choices =
    fllFlights.length
      ? fllFlights
      : flights;

  const now =
    Date.now();

  choices.sort(
    (a, b) =>
      Math.abs(
        flightTimeValue(a) -
        now
      ) -
      Math.abs(
        flightTimeValue(b) -
        now
      )
  );

  return (
    choices[0] ||
    null
  );
}

// ======================================================
// KFLL FLIGHT LIST
//
// No start/end bounds.
// This avoids the previous FlightAware 400 error.
// ======================================================
async function getKFLLFlights() {
  if (!FLIGHTAWARE_API_KEY) {
    return null;
  }

  return flightAwareGet(
    "/airports/KFLL/flights",
    {
      airline: "JBU",
      max_pages: 1
    }
  );
}

// ======================================================
// DISCORD
// ======================================================
async function sendDiscord(
  webhook,
  message
) {
  if (!webhook) {
    console.error(
      "❌ Discord webhook missing"
    );

    return;
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

  } catch (error) {
    console.error(
      "❌ Discord webhook error:",
      error.response?.data ||
      error.message
    );
  }
}

// ======================================================
// ARRIVAL
//
// SAME WORKING ARRIVAL LOGIC.
//
// REMOVED:
// 🔵 JETBLUE AIRWAYS
// 📡 Detection
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
    clean(
      plane.t
    );

  let registration =
    clean(
      plane.r
    );

  const flight =
    await getFlightDetails(
      callsign
    );

  if (flight) {
    origin =
      airportCode(
        flight.origin
      );

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
    `✈️ **Flight:** ${callsign}\n` +
    `📍 **Origin:** ${origin}\n` +
    `🛩️ **Aircraft:** ${aircraft}\n` +
    `🏷️ **Registration:** ${registration}\n` +
    `🛬 **Status:** LANDED\n` +
    `⏱️ **Touchdown:** ${formatTime(
      Date.now()
    )}\n` +
    `━━━━━━━━━━━━━━━━━━━━`;

  await sendDiscord(
    ARRIVALS_WEBHOOK,
    message
  );
}

// ======================================================
// LAST DEPARTURE -> OPERATIONS
//
// NO NORMAL DEPARTURES CHANNEL POSTS
// ======================================================
async function announceLastDeparture(
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

  recentlyDeparted.set(
    hex,
    {
      callsign,
      departedAt:
        Date.now()
    }
  );

  console.log(
    `🛫 DEPARTURE DETECTED: ${callsign}`
  );

  const flight =
    await getFlightDetails(
      callsign
    );

  let destination =
    "N/A";

  let aircraft =
    clean(
      plane.t
    );

  let registration =
    clean(
      plane.r
    );

  if (flight) {
    destination =
      airportCode(
        flight.destination
      );

    aircraft =
      flight.aircraft_type ||
      aircraft;

    registration =
      flight.registration ||
      flight.tailnumber ||
      registration;
  }

  const message =
    `🛫 **LAST DEPARTURE — KFLL**\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `✈️ **Flight:** ${callsign}\n` +
    `📍 **Destination:** ${destination}\n` +
    `🛩️ **Aircraft:** ${aircraft}\n` +
    `🏷️ **Registration:** ${registration}\n` +
    `🛫 **Status:** AIRBORNE\n` +
    `⏱️ **Takeoff:** ${formatTime(
      Date.now()
    )}\n` +
    `━━━━━━━━━━━━━━━━━━━━`;

  await sendDiscord(
    OPERATIONS_WEBHOOK,
    message
  );
}

// ======================================================
// RETURN TO FLL
// ======================================================
async function checkReturnToFLL(
  plane,
  distance,
  altitude
) {
  const hex =
    clean(
      plane.hex
    );

  const departed =
    recentlyDeparted.get(
      hex
    );

  if (!departed) {
    return;
  }

  if (
    Date.now() -
    departed.departedAt >
    2 *
    60 *
    60 *
    1000
  ) {
    recentlyDeparted.delete(
      hex
    );

    return;
  }

  const returned =
    distance <= 1.5 &&
    (
      plane.alt_baro === "ground" ||
      altitude <= 100
    );

  if (!returned) {
    return;
  }

  const alertId =
    `RETURN-${hex}-${departed.callsign}`;

  if (
    announcedTracking.has(
      alertId
    )
  ) {
    return;
  }

  announcedTracking.set(
    alertId,
    Date.now()
  );

  const message =
    `↩️ **RETURN TO FLL**\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `✈️ **Flight:** ${departed.callsign}\n` +
    `🛬 **Status:** RETURNED TO KFLL\n` +
    `⏱️ **Time:** ${formatTime(
      Date.now()
    )}\n` +
    `━━━━━━━━━━━━━━━━━━━━`;

  await sendDiscord(
    ALERTS_WEBHOOK,
    message
  );

  recentlyDeparted.delete(
    hex
  );
}

// ======================================================
// AIRCRAFT TRACKING
//
// 20 MIN OUT
// 15 MIN OUT
// ON APPROACH
// ======================================================
async function getTrackingInfo(
  callsign,
  plane
) {
  let origin =
    "N/A";

  let registration =
    clean(
      plane.r
    );

  const flight =
    await getFlightDetails(
      callsign
    );

  if (!flight) {
    return {
      validForFLL: true,
      origin,
      registration
    };
  }

  const destination =
    airportCode(
      flight.destination
    );

  const validForFLL =
    destination === "FLL" ||
    destination === "KFLL";

  origin =
    airportCode(
      flight.origin
    );

  registration =
    flight.registration ||
    flight.tailnumber ||
    registration;

  return {
    validForFLL,
    origin,
    registration
  };
}

async function sendTrackingAlert(
  type,
  callsign,
  plane,
  distance,
  altitude,
  etaMinutes,
  now
) {
  const hex =
    clean(
      plane.hex
    );

  const id =
    `${hex}-${callsign}`;

  const alertId =
    `${id}-${type}`;

  if (
    announcedTracking.has(
      alertId
    )
  ) {
    return;
  }

  const info =
    await getTrackingInfo(
      callsign,
      plane
    );

  if (
    !info.validForFLL
  ) {
    return;
  }

  let message;

  if (
    type === "20MIN"
  ) {
    message =
      `🕒 **20 MIN OUT — ${callsign}**\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `📍 **Route:** ${info.origin} → FLL\n` +
      `🏷️ **Registration:** ${info.registration}\n` +
      `📏 **Distance:** ${distance.toFixed(1)} NM\n` +
      `⏱️ **Estimated:** ${Math.round(
        etaMinutes
      )} min\n` +
      `━━━━━━━━━━━━━━━━━━━━`;
  }

  else if (
    type === "15MIN"
  ) {
    message =
      `🕒 **15 MIN OUT — ${callsign}**\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `📍 **Route:** ${info.origin} → FLL\n` +
      `🏷️ **Registration:** ${info.registration}\n` +
      `📏 **Distance:** ${distance.toFixed(1)} NM\n` +
      `⏱️ **Estimated:** ${Math.round(
        etaMinutes
      )} min\n` +
      `━━━━━━━━━━━━━━━━━━━━`;
  }

  else {
    message =
      `🛬 **ON APPROACH — ${callsign}**\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `📍 **Route:** ${info.origin} → FLL\n` +
      `🏷️ **Registration:** ${info.registration}\n` +
      `📏 **Distance:** ${distance.toFixed(1)} NM\n` +
      `⬇️ **Altitude:** ${Math.round(
        altitude
      ).toLocaleString()} ft\n` +
      `━━━━━━━━━━━━━━━━━━━━`;
  }

  announcedTracking.set(
    alertId,
    now
  );

  await sendDiscord(
    TRACKING_WEBHOOK,
    message
  );
}

async function checkAircraftTracking() {
  if (
    !TRACKING_WEBHOOK
  ) {
    return;
  }

  try {
    const aircraft =
      await getAircraft(
        TRACKING_RADIUS_NM
      );

    const jetblue =
      aircraft.filter(
        isJetBlue
      );

    const now =
      Date.now();

    console.log(
      `📡 JBU tracking aircraft: ${jetblue.length}`
    );

    for (
      const plane of jetblue
    ) {
      if (
        plane.lat === undefined ||
        plane.lon === undefined
      ) {
        continue;
      }

      const distance =
        distanceNM(
          Number(
            plane.lat
          ),
          Number(
            plane.lon
          ),
          KFLL_LAT,
          KFLL_LON
        );

      const altitude =
        plane.alt_baro === "ground"
          ? 0
          : Number(
              plane.alt_baro ||
              0
            );

      if (
        altitude <= 500 ||
        distance <= 1.5
      ) {
        continue;
      }

      const callsign =
        clean(
          plane.flight
        ).toUpperCase();

      const hex =
        clean(
          plane.hex
        );

      const id =
        `${hex}-${callsign}`;

      const previous =
        trackingState.get(
          id
        );

      trackingState.set(
        id,
        {
          distance,
          altitude,
          timestamp:
            now
        }
      );

      if (!previous) {
        continue;
      }

      if (
        distance >=
        previous.distance
      ) {
        continue;
      }

      const etaMinutes =
        estimatedMinutesOut(
          distance,
          plane
        );

      if (
        etaMinutes !== null &&
        etaMinutes <= 21 &&
        etaMinutes > 17
      ) {
        await sendTrackingAlert(
          "20MIN",
          callsign,
          plane,
          distance,
          altitude,
          etaMinutes,
          now
        );
      }

      if (
        etaMinutes !== null &&
        etaMinutes <= 16 &&
        etaMinutes > 12
      ) {
        await sendTrackingAlert(
          "15MIN",
          callsign,
          plane,
          distance,
          altitude,
          etaMinutes,
          now
        );
      }

      if (
        distance <= 8 &&
        altitude > 500 &&
        altitude <= 5000
      ) {
        await sendTrackingAlert(
          "APPROACH",
          callsign,
          plane,
          distance,
          altitude,
          etaMinutes,
          now
        );
      }
    }

    for (
      const [
        id,
        state
      ]
      of trackingState.entries()
    ) {
      if (
        now -
        state.timestamp >
        30 *
        60 *
        1000
      ) {
        trackingState.delete(
          id
        );
      }
    }

  } catch (error) {
    console.error(
      "❌ Tracking error:",
      error.response?.data ||
      error.message
    );
  }
}

// ======================================================
// OPS ALERTS
//
// DELAYS
// CANCELLATIONS
// DIVERSIONS
// ======================================================
async function checkOpsAlerts() {
  if (
    !ALERTS_WEBHOOK ||
    !FLIGHTAWARE_API_KEY
  ) {
    return;
  }

  try {
    const data =
      await getKFLLFlights();

    if (!data) {
      return;
    }

    const flights = [
      ...(data.scheduled_arrivals || []),
      ...(data.scheduled_departures || []),
      ...(data.arrivals || []),
      ...(data.departures || [])
    ].filter(
      isJetBlueFlight
    );

    const uniqueFlights =
      new Map();

    for (
      const flight of flights
    ) {
      const key =
        flight.fa_flight_id ||
        `${flightCallsign(
          flight
        )}-${
          flight.scheduled_off ||
          flight.scheduled_on ||
          ""
        }`;

      uniqueFlights.set(
        key,
        flight
      );
    }

    for (
      const [
        key,
        flight
      ]
      of uniqueFlights.entries()
    ) {
      const previous =
        opsState.get(
          key
        ) ||
        {};

      const callsign =
        flightCallsign(
          flight
        );

      const origin =
        airportCode(
          flight.origin
        );

      const destination =
        airportCode(
          flight.destination
        );

      const registration =
        clean(
          flight.registration
        );

      // CANCELLED
      if (
        flight.cancelled === true &&
        previous.cancelled !== true
      ) {
        await sendDiscord(
          ALERTS_WEBHOOK,
          `❌ **CANCELLED — ${callsign}**\n` +
          `━━━━━━━━━━━━━━━━━━━━\n` +
          `📍 **Route:** ${origin} → ${destination}\n` +
          `🏷️ **Registration:** ${registration}\n` +
          `📋 **Status:** ${clean(
            flight.status
          )}\n` +
          `━━━━━━━━━━━━━━━━━━━━`
        );
      }

      // DIVERTED
      if (
        flight.diverted === true &&
        previous.diverted !== true
      ) {
        await sendDiscord(
          ALERTS_WEBHOOK,
          `↪️ **DIVERTED — ${callsign}**\n` +
          `━━━━━━━━━━━━━━━━━━━━\n` +
          `📍 **Route:** ${origin} → ${destination}\n` +
          `🏷️ **Registration:** ${registration}\n` +
          `📋 **Status:** ${clean(
            flight.status
          )}\n` +
          `━━━━━━━━━━━━━━━━━━━━`
        );
      }

      // ARRIVAL DELAY
      const arrivalDelay =
        Number(
          flight.arrival_delay ||
          0
        );

      if (
        (
          destination === "FLL" ||
          destination === "KFLL"
        ) &&
        arrivalDelay >=
        DELAY_THRESHOLD_SECONDS
      ) {
        const delayBucket =
          Math.floor(
            arrivalDelay /
            (15 * 60)
          );

        if (
          previous.arrivalDelayBucket !==
          delayBucket
        ) {
          await sendDiscord(
            ALERTS_WEBHOOK,
            `⚠️ **ARRIVAL DELAY — ${callsign}**\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `📍 **${origin} → FLL**\n` +
            `⏱️ **Delay:** +${formatMinutes(
              arrivalDelay
            )} min\n` +
            `🕒 **Estimated Arrival:** ${formatTime(
              flight.estimated_on ||
              flight.estimated_in
            )}\n` +
            `🏷️ **Registration:** ${registration}\n` +
            `━━━━━━━━━━━━━━━━━━━━`
          );
        }

        previous.arrivalDelayBucket =
          delayBucket;
      }

      // DEPARTURE DELAY
      const departureDelay =
        Number(
          flight.departure_delay ||
          0
        );

      if (
        (
          origin === "FLL" ||
          origin === "KFLL"
        ) &&
        departureDelay >=
        DELAY_THRESHOLD_SECONDS
      ) {
        const delayBucket =
          Math.floor(
            departureDelay /
            (15 * 60)
          );

        if (
          previous.departureDelayBucket !==
          delayBucket
        ) {
          await sendDiscord(
            ALERTS_WEBHOOK,
            `⚠️ **DEPARTURE DELAY — ${callsign}**\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `📍 **FLL → ${destination}**\n` +
            `⏱️ **Delay:** +${formatMinutes(
              departureDelay
            )} min\n` +
            `🕒 **Estimated Departure:** ${formatTime(
              flight.estimated_off ||
              flight.estimated_out
            )}\n` +
            `🏷️ **Registration:** ${registration}\n` +
            `━━━━━━━━━━━━━━━━━━━━`
          );
        }

        previous.departureDelayBucket =
          delayBucket;
      }

      previous.cancelled =
        flight.cancelled === true;

      previous.diverted =
        flight.diverted === true;

      previous.timestamp =
        Date.now();

      opsState.set(
        key,
        previous
      );
    }

    const now =
      Date.now();

    for (
      const [
        key,
        state
      ]
      of opsState.entries()
    ) {
      if (
        now -
        state.timestamp >
        24 *
        60 *
        60 *
        1000
      ) {
        opsState.delete(
          key
        );
      }
    }

  } catch (error) {
    console.error(
      "❌ Ops alert error:",
      error.response?.data ||
      error.message
    );
  }
}

// ======================================================
// WEATHER ALERTS
// ======================================================
async function checkWeatherAlerts() {
  if (
    !WEATHER_WEBHOOK
  ) {
    return;
  }

  try {
    const response =
      await axios.get(
        "https://api.weather.gov/alerts/active",
        {
          params: {
            point:
              `${KFLL_LAT},${KFLL_LON}`
          },

          headers: {
            "User-Agent":
              "KFLL-Discord-Ops/1.0"
          },

          timeout: 15000
        }
      );

    const importantEvents =
      new Set([
        "Severe Thunderstorm Warning",
        "Severe Thunderstorm Watch",
        "Tornado Warning",
        "Tornado Watch",
        "Flash Flood Warning",
        "Flood Warning",
        "Special Weather Statement",
        "Extreme Wind Warning",
        "Hurricane Warning",
        "Hurricane Watch",
        "Tropical Storm Warning",
        "Tropical Storm Watch"
      ]);

    for (
      const feature of
      response.data?.features ||
      []
    ) {
      const props =
        feature.properties ||
        {};

      const event =
        clean(
          props.event
        );

      if (
        !importantEvents.has(
          event
        )
      ) {
        continue;
      }

      const id =
        clean(
          feature.id ||
          props.id
        );

      if (
        weatherAlertsSeen.has(
          id
        )
      ) {
        continue;
      }

      weatherAlertsSeen.set(
        id,
        Date.now()
      );

      const message =
        `⛈️ **FLL WEATHER ALERT**\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `⚠️ **${event}**\n` +
        `📋 **${clean(
          props.headline
        )}**\n` +
        `🚨 **Severity:** ${clean(
          props.severity
        )}\n` +
        `⏱️ **Expires:** ${formatTime(
          props.expires
        )}\n` +
        `━━━━━━━━━━━━━━━━━━━━`;

      await sendDiscord(
        WEATHER_WEBHOOK,
        message
      );
    }

    const now =
      Date.now();

    for (
      const [
        id,
        timestamp
      ]
      of weatherAlertsSeen.entries()
    ) {
      if (
        now -
        timestamp >
        24 *
        60 *
        60 *
        1000
      ) {
        weatherAlertsSeen.delete(
          id
        );
      }
    }

  } catch (error) {
    console.error(
      "❌ Weather alert error:",
      error.response?.data ||
      error.message
    );
  }
}

// ======================================================
// MAIN KFLL MONITOR
//
// KEEP ARRIVAL DETECTION LOGIC THE SAME
// ======================================================
async function checkKFLL() {
  try {
    const aircraft =
      await getAircraft(
        ARRIVAL_RADIUS_NM
      );

    const jetblue =
      aircraft.filter(
        isJetBlue
      );

    const now =
      Date.now();

    console.log(
      `🔵 JBU aircraft near KFLL: ${jetblue.length}`
    );

    for (
      const plane of jetblue
    ) {
      if (
        plane.lat === undefined ||
        plane.lon === undefined
      ) {
        continue;
      }

      const distance =
        distanceNM(
          Number(
            plane.lat
          ),
          Number(
            plane.lon
          ),
          KFLL_LAT,
          KFLL_LON
        );

      const altitude =
        plane.alt_baro === "ground"
          ? 0
          : Number(
              plane.alt_baro ||
              0
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

      // FIRST OBSERVATION
      if (!previous) {
        aircraftState.set(
          id,
          {
            distance,
            altitude,
            timestamp:
              now,

            wasAirborne:
              altitude > 500
          }
        );

        continue;
      }

      // ==================================================
      // ARRIVAL DETECTION
      //
      // SAME WORKING LOGIC
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
      //
      // ONLY:
      // Operations last departure
      // Return-to-FLL detection
      // ==================================================
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
        await announceLastDeparture(
          plane
        );
      }

      await checkReturnToFLL(
        plane,
        distance,
        altitude
      );

      aircraftState.set(
        id,
        {
          distance,
          altitude,
          timestamp:
            now,

          wasAirborne:
            previous.wasAirborne ||
            altitude > 500
        }
      );
    }

    // Cleanup aircraft state
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

    // Cleanup landing alerts
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

    // Cleanup departure alerts
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

    // Cleanup tracking alerts
    for (
      const [
        id,
        timestamp
      ]
      of announcedTracking.entries()
    ) {
      if (
        now -
        timestamp >
        6 *
        60 *
        60 *
        1000
      ) {
        announcedTracking.delete(
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
  "🚨 OPS ALERTS ENABLED"
);

console.log(
  "📡 AIRCRAFT TRACKING ENABLED"
);

console.log(
  "⛈️ WEATHER ALERTS ENABLED"
);

console.log(
  "🔵 OPERATIONS / LAST DEPARTURE ENABLED"
);

console.log(
  "⚡ ARRIVAL POLLING: 5 SECONDS"
);

console.log(
  "📢 Arrivals:",
  !!ARRIVALS_WEBHOOK
);

console.log(
  "📢 Ops Alerts:",
  !!ALERTS_WEBHOOK
);

console.log(
  "📢 Tracking:",
  !!TRACKING_WEBHOOK
);

console.log(
  "📢 Weather:",
  !!WEATHER_WEBHOOK
);

console.log(
  "📢 Operations:",
  !!OPERATIONS_WEBHOOK
);

console.log(
  "🔑 FlightAware:",
  !!FLIGHTAWARE_API_KEY
);

// ======================================================
// START
// ======================================================

// ARRIVALS
checkKFLL();

setInterval(
  checkKFLL,
  ARRIVAL_POLL_INTERVAL
);

// TRACKING
// Starts 15 seconds later so it doesn't hit ADS-B
// at the exact same moment as the arrival request.
setTimeout(
  checkAircraftTracking,
  15000
);

setInterval(
  checkAircraftTracking,
  TRACKING_POLL_INTERVAL
);

// OPS ALERTS
checkOpsAlerts();

setInterval(
  checkOpsAlerts,
  OPS_POLL_INTERVAL
);

// WEATHER
checkWeatherAlerts();

setInterval(
  checkWeatherAlerts,
  WEATHER_POLL_INTERVAL
);
