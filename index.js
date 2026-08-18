const axios = require("axios");

const {
  Client,
  GatewayIntentBits,
  ActivityType,
  REST,
  Routes,
  SlashCommandBuilder
} = require("discord.js");

// ======================================================
// ENVIRONMENT VARIABLES
// ======================================================

const DISCORD_BOT_TOKEN =
  process.env.DISCORD_BOT_TOKEN;

const ARRIVALS_WEBHOOK =
  process.env.DISCORD_ARRIVALS_WEBHOOK;

const ALERTS_WEBHOOK =
  process.env.DISCORD_ALERTS_WEBHOOK;

const TRACKING_WEBHOOK =
  process.env.DISCORD_TRACKING_WEBHOOK;

const WEATHER_WEBHOOK =
  process.env.DISCORD_WEATHER_WEBHOOK;

const OPERATIONS_WEBHOOK =
  process.env.DISCORD_OPERATIONS_WEBHOOK ||
  process.env.DISCORD_FLIGHT_STATUS_WEBHOOK;

const FLIGHTAWARE_API_KEY =
  process.env.FLIGHTAWARE_API_KEY;

// ======================================================
// KFLL SETTINGS
// ======================================================

const KFLL_LAT = 26.0726;
const KFLL_LON = -80.1527;

const ARRIVAL_RADIUS_NM = 8;
const ARRIVAL_POLL_INTERVAL = 10000;

const TRACKING_RADIUS_NM = 160;
const TRACKING_POLL_INTERVAL = 60000;

const OPS_POLL_INTERVAL = 120000;

const WEATHER_POLL_INTERVAL = 300000;

const MAJOR_DELAY_SECONDS = 45 * 60;
const SEVERE_DELAY_SECONDS = 90 * 60;

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
const scheduledWeatherUpdatesSent = new Map();

const recentlyDeparted = new Map();

let opsWarmupComplete = false;

// ======================================================
// DISCORD CLIENT
// ======================================================

const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds
  ]
});

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

  return clean(
    plane.flight
  )
    .toUpperCase()
    .startsWith("JBU");
}

function isJetBlueFlight(flight) {

  const ident =
    clean(
      flight.ident_icao ||
      flight.ident ||
      flight.ident_iata
    ).toUpperCase();

  const operator =
    clean(
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

  if (!airport) {
    return "N/A";
  }

  return clean(
    airport.code_iata ||
    airport.iata ||
    airport.code ||
    airport.airport_code ||
    airport.code_icao ||
    airport.icao
  ).toUpperCase();
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
    Math.cos(lat1 * Math.PI / 180) *
    Math.cos(lat2 * Math.PI / 180) *
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

  if (
    Number.isNaN(
      date.getTime()
    )
  ) {

    return "N/A";
  }

  return (
    new Intl.DateTimeFormat(
      "en-US",
      {
        timeZone:
          "America/New_York",

        hour:
          "2-digit",

        minute:
          "2-digit",

        hour12:
          true
      }
    ).format(date) +
    " ET"
  );
}

function formatMinutes(seconds) {

  const value =
    Number(seconds);

  if (
    !Number.isFinite(value)
  ) {

    return "N/A";
  }

  return Math.round(
    value / 60
  );
}

function getGroundSpeed(plane) {

  const gs =
    Number(
      plane.gs
    );

  if (
    !Number.isFinite(gs) ||
    gs < 30
  ) {

    return null;
  }

  return gs;
}

function estimatedMinutesOut(
  distance,
  plane
) {

  const gs =
    getGroundSpeed(
      plane
    );

  if (!gs) {
    return null;
  }

  return (
    distance /
    gs *
    60
  );
}

function normalizeFlightInput(input) {

  let value =
    clean(input)
      .toUpperCase()
      .replace(/\s+/g, "");

  if (
    value === "N/A"
  ) {

    return null;
  }

  if (/^\d+$/.test(value)) {

    value =
      `JBU${value}`;
  }

  if (
    value.startsWith("B6")
  ) {

    value =
      `JBU${value.substring(2)}`;
  }

  return value;
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

  try {

    const response =
      await axios.get(
        url,
        {
          timeout:
            10000
        }
      );

    return (
      response.data?.ac ||
      []
    );

  } catch (error) {

    if (
      error.response?.status === 420 ||
      error.response?.status === 429
    ) {

      console.log(
        `ADS-B rate limited (${radius} NM) - skipping this poll`
      );

      return null;
    }

    console.error(
      `ADS-B request error (${radius} NM):`,
      error.response?.status ||
      error.message
    );

    return null;
  }
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

          timeout:
            15000
        }
      );

    return response.data;

  } catch (error) {

    console.error(
      `FlightAware ${path}:`,
      error.response?.data ||
      error.message
    );

    return null;
  }
}

// ======================================================
// FLIGHT DETAILS
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

  const data =
    await flightAwareGet(
      `/flights/${encodeURIComponent(
        callsign
      )}`
    );

  const flights =
    data?.flights ||
    [];

  if (
    !Array.isArray(flights) ||
    flights.length === 0
  ) {

    return null;
  }

  const fllFlight =
    flights.find(
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

  if (fllFlight) {
    return fllFlight;
  }

  const withOrigin =
    flights.find(
      flight =>
        airportCode(
          flight.origin
        ) !== "N/A"
    );

  if (withOrigin) {
    return withOrigin;
  }

  return flights[0];
}

// ======================================================
// FLIGHT LOOKUP FOR /flight
// ======================================================

async function lookupFlight(
  input
) {

  const callsign =
    normalizeFlightInput(
      input
    );

  if (!callsign) {
    return null;
  }

  const data =
    await flightAwareGet(
      `/flights/${encodeURIComponent(
        callsign
      )}`
    );

  const flights =
    data?.flights ||
    [];

  if (
    !Array.isArray(flights) ||
    flights.length === 0
  ) {

    return null;
  }

  const active =
    flights.find(
      flight =>
        flight.actual_off &&
        !flight.actual_on
    );

  if (active) {
    return active;
  }

  const fllRelated =
    flights.find(
      flight => {

        const origin =
          airportCode(
            flight.origin
          );

        const destination =
          airportCode(
            flight.destination
          );

        return (
          origin === "FLL" ||
          origin === "KFLL" ||
          destination === "FLL" ||
          destination === "KFLL"
        );
      }
    );

  if (fllRelated) {
    return fllRelated;
  }

  return flights[0];
}

// ======================================================
// KFLL FLIGHTAWARE FLIGHTS
// ======================================================

async function getKFLLFlights() {

  if (!FLIGHTAWARE_API_KEY) {
    return null;
  }

  return await flightAwareGet(
    "/airports/KFLL/flights",
    {
      airline:
        "JBU",

      max_pages:
        1
    }
  );
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
      "Discord webhook missing"
    );

    return;
  }

  try {

    await axios.post(
      webhook,
      {
        content:
          message
      },
      {
        timeout:
          10000
      }
    );

    console.log(
      "📢 Discord message sent"
    );

  } catch (error) {

    console.error(
      "Discord webhook error:",
      error.response?.data ||
      error.message
    );
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

    const foundOrigin =
      airportCode(
        flight.origin
      );

    if (
      foundOrigin !== "N/A"
    ) {

      origin =
        foundOrigin;
    }

    aircraft =
      flight.aircraft_type ||
      aircraft;

    registration =
      flight.registration ||
      flight.tailnumber ||
      registration;

    console.log(
      `📍 ${callsign} origin: ${origin}`
    );

  } else {

    console.log(
      `No FlightAware details found for ${callsign}`
    );
  }

  announcedLandings.set(
    landingId,
    Date.now()
  );

  console.log(
    `🛬 TOUCHDOWN DETECTED: ${callsign}`
  );

  const message =
    `🛬 **JETBLUE ARRIVAL — ${callsign}**\n` +
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
    `━━━━━━━━━━━━━━━━━━━━`;

  await sendDiscord(
    ARRIVALS_WEBHOOK,
    message
  );
}

// ======================================================
// LAST DEPARTURE
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
    `🛫 **LAST DEPARTURE — ${callsign}**\n` +
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

  const age =
    Date.now() -
    departed.departedAt;

  if (
    age >
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

  await sendDiscord(
    ALERTS_WEBHOOK,

    `↩️ **RETURN TO FLL — ${departed.callsign}**\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `✈️ **Flight:** ${departed.callsign}\n` +
    `🚨 **Status:** RETURNED TO KFLL\n` +
    `⏱️ **Time:** ${formatTime(
      Date.now()
    )}\n` +
    `━━━━━━━━━━━━━━━━━━━━`
  );

  recentlyDeparted.delete(
    hex
  );
}

// ======================================================
// LONG RANGE TRACKING
// ======================================================

async function checkAircraftTracking() {

  if (!TRACKING_WEBHOOK) {
    return;
  }

  try {

    const aircraft =
      await getAircraft(
        TRACKING_RADIUS_NM
      );

    if (
      aircraft === null
    ) {

      console.log(
        "📡 Tracking poll skipped"
      );

      return;
    }

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

      const approaching =
        distance <
        previous.distance;

      if (!approaching) {
        continue;
      }

      const etaMinutes =
        estimatedMinutesOut(
          distance,
          plane
        );

      let origin =
       
