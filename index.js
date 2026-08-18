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

const ROUTE_BOARD_WEBHOOK =
  process.env.DISCORD_ROUTE_BOARD_WEBHOOK;

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

// Route board can fetch up to 10 AeroAPI pages.
// At up to 15 records/page this provides room for
// approximately 150 records.
const ROUTE_BOARD_MAX_PAGES = 20;

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
const scheduledRouteBoardUpdatesSent = new Map();

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
// EASTERN TIME HELPERS
// ======================================================

function getEasternDateParts() {

  const parts =
    new Intl.DateTimeFormat(
      "en-US",
      {
        timeZone:
          "America/New_York",

        year:
          "numeric",

        month:
          "2-digit",

        day:
          "2-digit",

        hour:
          "2-digit",

        minute:
          "2-digit",

        hour12:
          false
      }
    ).formatToParts(
      new Date()
    );

  const values = {};

  for (
    const part of parts
  ) {

    if (
      part.type !==
      "literal"
    ) {
      values[
        part.type
      ] =
        part.value;
    }
  }

  return values;
}

function formatBoardDate() {

  return new Intl.DateTimeFormat(
    "en-US",
    {
      timeZone:
        "America/New_York",

      weekday:
        "long",

      month:
        "long",

      day:
        "numeric"
    }
  ).format(
    new Date()
  );
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
            20000
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
// Used by existing Ops alerts
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
        "N/A";

      let registration =
        clean(
          plane.r
        );

      // ==================================================
      // 20 MIN OUT
      // ==================================================

      if (
        etaMinutes !== null &&
        etaMinutes <= 21 &&
        etaMinutes > 17
      ) {

        const alertId =
          `${id}-20MIN`;

        if (
          !announcedTracking.has(
            alertId
          )
        ) {

          const flight =
            await getFlightDetails(
              callsign
            );

          if (flight) {

            const destination =
              airportCode(
                flight.destination
              );

            if (
              destination !== "FLL" &&
              destination !== "KFLL"
            ) {
              continue;
            }

            origin =
              airportCode(
                flight.origin
              );

            registration =
              flight.registration ||
              registration;
          }

          announcedTracking.set(
            alertId,
            now
          );

          await sendDiscord(
            TRACKING_WEBHOOK,

            `🕒 **20 MIN OUT — ${callsign}**\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `📍 **${origin} → FLL**\n` +
            `🏷️ **${registration}**\n` +
            `📏 **Distance:** ${distance.toFixed(1)} NM\n` +
            `⏱️ **Estimated:** ${Math.round(
              etaMinutes
            )} min\n` +
            `━━━━━━━━━━━━━━━━━━━━`
          );
        }
      }

      // ==================================================
      // 15 MIN OUT
      // ==================================================

      if (
        etaMinutes !== null &&
        etaMinutes <= 16 &&
        etaMinutes > 12
      ) {

        const alertId =
          `${id}-15MIN`;

        if (
          !announcedTracking.has(
            alertId
          )
        ) {

          const flight =
            await getFlightDetails(
              callsign
            );

          if (flight) {

            const destination =
              airportCode(
                flight.destination
              );

            if (
              destination !== "FLL" &&
              destination !== "KFLL"
            ) {
              continue;
            }

            origin =
              airportCode(
                flight.origin
              );

            registration =
              flight.registration ||
              registration;
          }

          announcedTracking.set(
            alertId,
            now
          );

          await sendDiscord(
            TRACKING_WEBHOOK,

            `🕒 **15 MIN OUT — ${callsign}**\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `📍 **${origin} → FLL**\n` +
            `🏷️ **${registration}**\n` +
            `📏 **Distance:** ${distance.toFixed(1)} NM\n` +
            `⏱️ **Estimated:** ${Math.round(
              etaMinutes
            )} min\n` +
            `━━━━━━━━━━━━━━━━━━━━`
          );
        }
      }

      // ==================================================
      // ON APPROACH
      // ==================================================

      if (
        distance <= 8 &&
        altitude > 500 &&
        altitude <= 5000
      ) {

        const alertId =
          `${id}-APPROACH`;

        if (
          !announcedTracking.has(
            alertId
          )
        ) {

          const flight =
            await getFlightDetails(
              callsign
            );

          if (flight) {

            const destination =
              airportCode(
                flight.destination
              );

            if (
              destination !== "FLL" &&
              destination !== "KFLL"
            ) {
              continue;
            }

            origin =
              airportCode(
                flight.origin
              );

            registration =
              flight.registration ||
              registration;
          }

          announcedTracking.set(
            alertId,
            now
          );

          await sendDiscord(
            TRACKING_WEBHOOK,

            `🛬 **ON APPROACH — ${callsign}**\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `📍 **${origin} → FLL**\n` +
            `🏷️ **${registration}**\n` +
            `📏 **Distance:** ${distance.toFixed(1)} NM\n` +
            `⬇️ **Altitude:** ${Math.round(
              altitude
            ).toLocaleString()} ft\n` +
            `━━━━━━━━━━━━━━━━━━━━`
          );
        }
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
      "Tracking processing error:",
      error.response?.data ||
      error.message
    );
  }
}

// ======================================================
// QUIET OPS ALERTS
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
        )}-${flight.scheduled_off || flight.scheduled_on || ""}`;

      uniqueFlights.set(
        key,
        flight
      );
    }

    // ==================================================
    // STARTUP WARM-UP
    // ==================================================

    if (
      !opsWarmupComplete
    ) {

      console.log(
        `🟡 Ops warm-up: baselining ${uniqueFlights.size} JetBlue flights`
      );

      for (
        const [
          key,
          flight
        ]
        of uniqueFlights.entries()
      ) {

        const destination =
          airportCode(
            flight.destination
          );

        const inboundFLL =
          destination === "FLL" ||
          destination === "KFLL";

        const arrivalDelay =
          Number(
            flight.arrival_delay ||
            0
          );

        opsState.set(
          key,
          {
            cancelledSent:
              flight.cancelled ===
              true,

            divertedSent:
              flight.diverted ===
              true,

            majorDelaySent:
              inboundFLL &&
              arrivalDelay >=
              MAJOR_DELAY_SECONDS,

            severeDelaySent:
              inboundFLL &&
              arrivalDelay >=
              SEVERE_DELAY_SECONDS,

            timestamp:
              Date.now()
          }
        );
      }

      opsWarmupComplete =
        true;

      console.log(
        "🟢 Ops warm-up complete - existing alerts suppressed"
      );

      return;
    }

    // ==================================================
    // LIVE OPS
    // ==================================================

    for (
      const [
        key,
        flight
      ]
      of uniqueFlights.entries()
    ) {

      let previous =
        opsState.get(
          key
        );

      if (!previous) {

        previous = {
          cancelledSent:
            false,

          divertedSent:
            false,

          majorDelaySent:
            false,

          severeDelaySent:
            false,

          timestamp:
            Date.now()
        };
      }

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

      // CANCELLATION

      if (
        flight.cancelled === true &&
        previous.cancelledSent !== true
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

        previous.cancelledSent =
          true;
      }

      // DIVERSION

      if (
        flight.diverted === true &&
        previous.divertedSent !== true
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

        previous.divertedSent =
          true;
      }

      // ARRIVAL DELAYS ONLY

      const inboundFLL =
        destination === "FLL" ||
        destination === "KFLL";

      const arrivalDelay =
        Number(
          flight.arrival_delay ||
          0
        );

      if (
        inboundFLL
      ) {

        if (
          arrivalDelay >=
          SEVERE_DELAY_SECONDS &&
          previous.severeDelaySent !==
          true
        ) {

          await sendDiscord(
            ALERTS_WEBHOOK,

            `🔴 **SEVERE ARRIVAL DELAY — ${callsign}**\n` +
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

          previous.severeDelaySent =
            true;

          previous.majorDelaySent =
            true;

        } else if (
          arrivalDelay >=
          MAJOR_DELAY_SECONDS &&
          previous.majorDelaySent !==
          true
        ) {

          await sendDiscord(
            ALERTS_WEBHOOK,

            `⚠️ **MAJOR ARRIVAL DELAY — ${callsign}**\n` +
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

          previous.majorDelaySent =
            true;
        }
      }

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
      "Ops processing error:",
      error.response?.data ||
      error.message
    );
  }
}

// ======================================================
// FLL DAILY WEATHER
// ======================================================

function getWeatherEmoji(forecast) {

  const text =
    String(
      forecast ||
      ""
    ).toLowerCase();

  if (
    text.includes("thunder") ||
    text.includes("storm")
  ) {
    return "⛈️";
  }

  if (
    text.includes("rain") ||
    text.includes("shower")
  ) {
    return "🌧️";
  }

  if (
    text.includes("partly") ||
    text.includes("mostly sunny")
  ) {
    return "🌤️";
  }

  if (
    text.includes("cloud") ||
    text.includes("overcast")
  ) {
    return "☁️";
  }

  return "☀️";
}

function formatWeatherDate() {

  return new Intl.DateTimeFormat(
    "en-US",
    {
      timeZone:
        "America/New_York",

      weekday:
        "long",

      month:
        "long",

      day:
        "numeric"
    }
  ).format(
    new Date()
  );
}

async function getDailyFLLWeather() {

  try {

    const headers = {
      "User-Agent":
        "JetBlue-KFLL-Discord-Ops/1.0",

      "Accept":
        "application/geo+json"
    };

    const pointResponse =
      await axios.get(
        `https://api.weather.gov/points/${KFLL_LAT},${KFLL_LON}`,
        {
          headers,

          timeout:
            15000
        }
      );

    const forecastUrl =
      pointResponse.data
        ?.properties
        ?.forecast;

    if (!forecastUrl) {

      throw new Error(
        "NWS forecast URL unavailable"
      );
    }

    const forecastResponse =
      await axios.get(
        forecastUrl,
        {
          headers,

          timeout:
            15000
        }
      );

    const periods =
      forecastResponse.data
        ?.properties
        ?.periods ||
      [];

    if (
      !Array.isArray(periods) ||
      periods.length === 0
    ) {

      throw new Error(
        "No NWS forecast periods available"
      );
    }

    const daytime =
      periods.find(
        period =>
          period.isDaytime ===
          true
      ) ||
      periods[0];

    const daytimeIndex =
      periods.indexOf(
        daytime
      );

    const nighttime =
      periods
        .slice(
          daytimeIndex +
          1
        )
        .find(
          period =>
            period.isDaytime ===
            false
        );

    const high =
      Number.isFinite(
        Number(
          daytime?.temperature
        )
      )
        ? `${Math.round(
            Number(
              daytime.temperature
            )
          )}°F`
        : "N/A";

    const low =
      Number.isFinite(
        Number(
          nighttime?.temperature
        )
      )
        ? `${Math.round(
            Number(
              nighttime.temperature
            )
          )}°F`
        : "N/A";

    const dayRain =
      Number(
        daytime
          ?.probabilityOfPrecipitation
          ?.value
      );

    const nightRain =
      Number(
        nighttime
          ?.probabilityOfPrecipitation
          ?.value
      );

    const rainValues = [
      dayRain,
      nightRain
    ].filter(
      Number.isFinite
    );

    const rainChance =
      rainValues.length
        ? `${Math.round(
            Math.max(
              ...rainValues
            )
          )}%`
        : "N/A";

    const windDirection =
      daytime?.windDirection ||
      "N/A";

    const windSpeed =
      daytime?.windSpeed ||
      "N/A";

    const forecast =
      daytime?.shortForecast ||
      "N/A";

    return {
      date:
        formatWeatherDate(),

      high,

      low,

      rainChance,

      windDirection,

      windSpeed,

      forecast,

      emoji:
        getWeatherEmoji(
          forecast
        )
    };

  } catch (error) {

    console.error(
      "FLL daily weather error:",
      error.response?.data ||
      error.message
    );

    return null;
  }
}

function buildDailyWeatherMessage(
  weather,
  title = "FLL DAILY WEATHER"
) {

  return (
    `${weather.emoji} **${title}**\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n\n` +

    `📅 **${weather.date}**\n\n` +

    `🌡️ **High:** ${weather.high}\n` +
    `🌙 **Low:** ${weather.low}\n` +
    `🌧️ **Rain Chance:** ${weather.rainChance}\n` +
    `💨 **Winds:** ${weather.windDirection} ${weather.windSpeed}\n` +
    `${weather.emoji} **Forecast:** ${weather.forecast}`
  );
}

async function sendDailyWeatherUpdate() {

  if (!WEATHER_WEBHOOK) {
    return;
  }

  const weather =
    await getDailyFLLWeather();

  if (!weather) {

    console.log(
      "☀️ FLL daily weather unavailable"
    );

    return;
  }

  await sendDiscord(
    WEATHER_WEBHOOK,

    buildDailyWeatherMessage(
      weather,
      "FLL DAILY WEATHER"
    )
  );
}

// ======================================================
// 6 AM / 1 PM / 6 PM WEATHER POSTS
// ======================================================

async function checkScheduledWeatherUpdate() {

  const now =
    getEasternDateParts();

  const hour =
    Number(
      now.hour
    );

  const minute =
    Number(
      now.minute
    );

  if (
    minute !== 0 ||
    ![
      6,
      13,
      18
    ].includes(
      hour
    )
  ) {
    return;
  }

  const scheduleId =
    `${now.year}-${now.month}-${now.day}-${hour}`;

  if (
    scheduledWeatherUpdatesSent.has(
      scheduleId
    )
  ) {
    return;
  }

  scheduledWeatherUpdatesSent.set(
    scheduleId,
    Date.now()
  );

  console.log(
    `☀️ Sending scheduled FLL weather update (${hour}:00 ET)`
  );

  await sendDailyWeatherUpdate();

  const cutoff =
    Date.now() -
    48 *
    60 *
    60 *
    1000;

  for (
    const [
      id,
      timestamp
    ]
    of scheduledWeatherUpdatesSent.entries()
  ) {

    if (
      timestamp <
      cutoff
    ) {

      scheduledWeatherUpdatesSent.delete(
        id
      );
    }
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
              "JetBlue-KFLL-Discord-Ops/1.0"
          },

          timeout:
            15000
        }
      );

    const features =
      response.data?.features ||
      [];

    const importantEvents = [
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
    ];

    for (
      const feature of features
    ) {

      const props =
        feature.properties ||
        {};

      const event =
        clean(
          props.event
        );

      if (
        !importantEvents.includes(
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

      await sendDiscord(
        WEATHER_WEBHOOK,

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
        `━━━━━━━━━━━━━━━━━━━━`
      );
    }

  } catch (error) {

    console.error(
      "Weather processing error:",
      error.response?.data ||
      error.message
    );
  }
}

// ======================================================
// ROUTE BOARD
// ======================================================

async function getRouteBoardFlights() {

  if (
    !FLIGHTAWARE_API_KEY
  ) {
    return null;
  }

  return await flightAwareGet(
    "/airports/KFLL/flights",
    {
      airline:
        "JBU",

      max_pages:
        ROUTE_BOARD_MAX_PAGES
    }
  );
}

function getRouteFlightKey(
  flight
) {

  const origin =
    airportCode(
      flight.origin
    );

  const destination =
    airportCode(
      flight.destination
    );

  return (
    flight.fa_flight_id ||
    `${flightCallsign(
      flight
    )}-${origin}-${destination}-${flight.scheduled_off || flight.scheduled_on || flight.scheduled_out || flight.scheduled_in || ""}`
  );
}

function mergeRouteFlight(
  oldFlight,
  newFlight
) {

  if (!oldFlight) {
    return newFlight;
  }

  return {
    ...oldFlight,
    ...Object.fromEntries(
      Object.entries(
        newFlight
      ).filter(
        ([
          key,
          value
        ]) =>
          value !==
          null &&
          value !==
          undefined
      )
    )
  };
}

function routeSeverity(
  route
) {

  if (
    route.cancelled >
      0 ||
    route.diverted >
      0
  ) {
    return 2;
  }

  if (
    route.delayed >
    0
  ) {
    return 1;
  }

  return 0;
}

function buildRouteStatus(
  route
) {

  const details = [];

  if (
    route.cancelled >
    0
  ) {

    details.push(
      `${route.cancelled} CANCELLED`
    );
  }

  if (
    route.diverted >
    0
  ) {

    details.push(
      `${route.diverted} DIVERTED`
    );
  }

  if (
    route.delayed >
    0
  ) {

    details.push(
      `${route.delayed} DELAYED`
    );
  }

  if (
    route.cancelled >
      0 ||
    route.diverted >
      0
  ) {

    return (
      `🔴 ${details.join(
        " • "
      )}`
    );
  }

  if (
    route.delayed >
    0
  ) {

    return (
      `🟡 ${details.join(
        " • "
      )}`
    );
  }

  return "🟢 NORMAL";
}

async function buildRouteBoard(
  remainingOnly = false,
  cutoffHour = null
) {

  const data =
    await getRouteBoardFlights();

  if (!data) {
    return null;
  }

  const allFlights = [
    ...(data.scheduled_arrivals || []),
    ...(data.scheduled_departures || []),
    ...(data.arrivals || []),
    ...(data.departures || [])
  ].filter(
    isJetBlueFlight
  );

  // ==================================================
  // TODAY IN EASTERN TIME
  // ==================================================

  function easternDateString(
    timestamp
  ) {

    if (!timestamp) {
      return null;
    }

    const date =
      new Date(
        timestamp
      );

    if (
      Number.isNaN(
        date.getTime()
      )
    ) {
      return null;
    }

    return new Intl.DateTimeFormat(
      "en-CA",
      {
        timeZone:
          "America/New_York",

        year:
          "numeric",

        month:
          "2-digit",

        day:
          "2-digit"
      }
    ).format(
      date
    );
  }

  function easternHour(
    timestamp
  ) {

    if (!timestamp) {
      return null;
    }

    const date =
      new Date(
        timestamp
      );

    if (
      Number.isNaN(
        date.getTime()
      )
    ) {
      return null;
    }

    const value =
      new Intl.DateTimeFormat(
        "en-US",
        {
          timeZone:
            "America/New_York",

          hour:
            "2-digit",

          hour12:
            false
        }
      ).format(
        date
      );

    return Number(
      value
    );
  }

  const today =
    easternDateString(
      new Date()
    );

  // ==================================================
  // UNIQUE TODAY FLIGHTS
  // ==================================================

  const uniqueFlights =
    new Map();

  for (
    const flight of allFlights
  ) {

    const origin =
      airportCode(
        flight.origin
      );

    const destination =
      airportCode(
        flight.destination
      );

    const isDeparture =
      origin === "FLL" ||
      origin === "KFLL";

    const isArrival =
      destination === "FLL" ||
      destination === "KFLL";

    if (
      !isDeparture &&
      !isArrival
    ) {
      continue;
    }

    const scheduledTime =
      isDeparture
        ? (
            flight.scheduled_out ||
            flight.scheduled_off
          )
        : (
            flight.scheduled_in ||
            flight.scheduled_on
          );

    const actualTime =
      isDeparture
        ? (
            flight.actual_out ||
            flight.actual_off
          )
        : (
            flight.actual_in ||
            flight.actual_on
          );

    const estimatedTime =
      isDeparture
        ? (
            flight.estimated_out ||
            flight.estimated_off
          )
        : (
            flight.estimated_in ||
            flight.estimated_on
          );

    const relevantTime =
      scheduledTime ||
      estimatedTime ||
      actualTime;

    if (
      easternDateString(
        relevantTime
      ) !== today
    ) {
      continue;
    }

    // ==================================================
    // REMAINING-FLIGHT FILTER
    // ==================================================

    if (
      remainingOnly &&
      cutoffHour !== null
    ) {

      const completed =
        Boolean(
          actualTime
        );

      // If already completed, don't show it
      if (completed) {
        continue;
      }

      const effectiveTime =
        estimatedTime ||
        scheduledTime;

      const effectiveHour =
        easternHour(
          effectiveTime
        );

      /*
        Keep a flight if:
        - estimated/scheduled time is cutoff hour or later
        OR
        - its scheduled time has already passed but it
          has NOT actually completed yet
      */

      const scheduledHour =
        easternHour(
          scheduledTime
        );

      const overdueButStillOpen =
        scheduledHour !== null &&
        scheduledHour <
          cutoffHour &&
        !completed;

      const upcoming =
        effectiveHour !== null &&
        effectiveHour >=
          cutoffHour;

      if (
        !overdueButStillOpen &&
        !upcoming
      ) {
        continue;
      }
    }

    const key =
      flight.fa_flight_id ||
      `${flightCallsign(
        flight
      )}-${origin}-${destination}-${scheduledTime || relevantTime}`;

    if (
      !uniqueFlights.has(
        key
      )
    ) {

      uniqueFlights.set(
        key,
        flight
      );

    } else {

      uniqueFlights.set(
        key,
        {
          ...uniqueFlights.get(
            key
          ),
          ...flight
        }
      );
    }
  }

  // ==================================================
  // ROUTE TOTALS
  // ==================================================

  const routes =
    new Map();

  let departures = 0;
  let arrivals = 0;

  let delayed = 0;
  let cancelled = 0;
  let diverted = 0;

  for (
    const flight of uniqueFlights.values()
  ) {

    const origin =
      airportCode(
        flight.origin
      );

    const destination =
      airportCode(
        flight.destination
      );

    const isDeparture =
      origin === "FLL" ||
      origin === "KFLL";

    const isArrival =
      destination === "FLL" ||
      destination === "KFLL";

    const routeCode =
      isDeparture
        ? destination
        : origin;

    if (
      !routeCode ||
      routeCode === "N/A" ||
      routeCode === "FLL" ||
      routeCode === "KFLL"
    ) {
      continue;
    }

    if (
      !routes.has(
        routeCode
      )
    ) {

      routes.set(
        routeCode,
        {
          code:
            routeCode,

          dep:
            0,

          arr:
            0,

          delayed:
            0,

          cancelled:
            0,

          diverted:
            0
        }
      );
    }

    const route =
      routes.get(
        routeCode
      );

    if (
      isDeparture
    ) {

      route.dep++;
      departures++;

    } else if (
      isArrival
    ) {

      route.arr++;
      arrivals++;
    }

    const isCancelled =
      flight.cancelled ===
      true;

    const isDiverted =
      flight.diverted ===
      true;

    const delaySeconds =
      Number(
        isDeparture
          ? (
              flight.departure_delay ||
              0
            )
          : (
              flight.arrival_delay ||
              0
            )
      );

    const isDelayed =
      !isCancelled &&
      !isDiverted &&
      Number.isFinite(
        delaySeconds
      ) &&
      delaySeconds >=
        MAJOR_DELAY_SECONDS;

    if (
      isCancelled
    ) {

      route.cancelled++;
      cancelled++;
    }

    if (
      isDiverted
    ) {

      route.diverted++;
      diverted++;
    }

    if (
      isDelayed
    ) {

      route.delayed++;
      delayed++;
    }
  }

  // ==================================================
  // SORT ROUTES
  // ==================================================

  const sortedRoutes =
    Array.from(
      routes.values()
    ).sort(
      (
        a,
        b
      ) => {

        const severityDiff =
          routeSeverity(
            b
          ) -
          routeSeverity(
            a
          );

        if (
          severityDiff !==
          0
        ) {
          return severityDiff;
        }

        const aTotal =
          a.dep +
          a.arr;

        const bTotal =
          b.dep +
          b.arr;

        if (
          bTotal !==
          aTotal
        ) {

          return (
            bTotal -
            aTotal
          );
        }

        return a.code.localeCompare(
          b.code
        );
      }
    );

  const routeLines =
    sortedRoutes.map(
      route => {

        const code =
          route.code.padEnd(
            6,
            " "
          );

        const dep =
          String(
            route.dep
          ).padStart(
            3,
            " "
          );

        const arr =
          String(
            route.arr
          ).padStart(
            3,
            " "
          );

        return (
          `${code}${dep}   ${arr}   ${buildRouteStatus(
            route
          )}`
        );
      }
    );

  const totalFlights =
    departures +
    arrivals;

  let boardLabel =
    "FULL DAY";

  let summaryLabel =
    "TOTAL FLIGHTS";

  if (
    remainingOnly &&
    cutoffHour === 13
  ) {

    boardLabel =
      "1:00 PM • REMAINING TODAY";

    summaryLabel =
      "FLIGHTS REMAINING";
  }

  if (
    remainingOnly &&
    cutoffHour === 18
  ) {

    boardLabel =
      "6:00 PM • REMAINING TONIGHT";

    summaryLabel =
      "FLIGHTS REMAINING";
  }

  return (
    `🗺️ **JETBLUE • FLL FLIGHT BOARD**\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `📅 **${formatBoardDate()} • ${boardLabel}**\n\n` +

    "```text\n" +
    "ROUTE  DEP   ARR   STATUS\n\n" +
    routeLines.join(
      "\n"
    ) +
    "\n```\n" +

    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `🟢 NORMAL   🟡 DELAYS   🔴 DISRUPTED\n\n` +

    `✈️ **${sortedRoutes.length} ROUTES**\n` +
    `🛫 **${departures} DEPARTURES**\n` +
    `🛬 **${arrivals} ARRIVALS**\n` +
    `🔵 **${totalFlights} ${summaryLabel}**\n\n` +

    `⚠️ **${delayed} DELAYED**\n` +
    `❌ **${cancelled} CANCELLED**\n` +
    `↪️ **${diverted} DIVERTED**\n\n` +

    `📍 **KFLL • JETBLUE OPERATIONS**`
  );
}

async function sendRouteBoardUpdate(
  remainingOnly = false,
  cutoffHour = null
) {

  if (
    !ROUTE_BOARD_WEBHOOK
  ) {
    return;
  }

  const board =
    await buildRouteBoard(
      remainingOnly,
      cutoffHour
    );

  if (!board) {

    console.log(
      "🗺️ Route board unavailable"
    );

    return;
  }

  await sendDiscord(
    ROUTE_BOARD_WEBHOOK,
    board
  );
}

// ======================================================
// 6 AM / 1 PM / 6 PM ROUTE BOARD POSTS
// ======================================================

async function checkScheduledRouteBoardUpdate() {

  const now =
    getEasternDateParts();

  const hour =
    Number(
      now.hour
    );

  const minute =
    Number(
      now.minute
    );

  if (
    minute !== 0 ||
    ![
      6,
      13,
      18
    ].includes(
      hour
    )
  ) {
    return;
  }

  const scheduleId =
    `${now.year}-${now.month}-${now.day}-${hour}`;

  if (
    scheduledRouteBoardUpdatesSent.has(
      scheduleId
    )
  ) {
    return;
  }

  scheduledRouteBoardUpdatesSent.set(
    scheduleId,
    Date.now()
  );

  // ==================================================
  // 6 AM = FULL DAY
  // ==================================================

  if (
    hour === 6
  ) {

    console.log(
      "🗺️ Sending 6 AM full-day FLL route board"
    );

    await sendRouteBoardUpdate(
      false,
      null
    );
  }

  // ==================================================
  // 1 PM = REMAINING TODAY
  // ==================================================

  if (
    hour === 13
  ) {

    console.log(
      "🗺️ Sending 1 PM remaining FLL route board"
    );

    await sendRouteBoardUpdate(
      true,
      13
    );
  }

  // ==================================================
  // 6 PM = REMAINING TONIGHT
  // ==================================================

  if (
    hour === 18
  ) {

    console.log(
      "🗺️ Sending 6 PM remaining FLL route board"
    );

    await sendRouteBoardUpdate(
      true,
      18
    );
  }

  const cutoff =
    Date.now() -
    48 *
    60 *
    60 *
    1000;

  for (
    const [
      id,
      timestamp
    ]
    of scheduledRouteBoardUpdatesSent.entries()
  ) {

    if (
      timestamp <
      cutoff
    ) {

      scheduledRouteBoardUpdatesSent.delete(
        id
      );
    }
  }
}

// ======================================================
// KFLL ARRIVAL / DEPARTURE DETECTOR
// ======================================================

async function checkKFLL() {

  try {

    const aircraft =
      await getAircraft(
        ARRIVAL_RADIUS_NM
      );

    if (
      aircraft === null
    ) {

      console.log(
        "🛬 Arrival poll skipped"
      );

      return;
    }

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
              plane.alt_baro ||
              0
            );

      const callsign =
        clean(
          plane.flight
        ).toUpperCase();

      const id =
        `${clean(
          plane.hex
        )}-${callsign}`;

      const previous =
        aircraftState.get(
          id
        );

      console.log(
        `   ✈️ ${callsign} | ` +
        `ALT: ${plane.alt_baro} | ` +
        `DIST: ${distance.toFixed(
          1
        )} NM`
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

      // ARRIVAL

      const wasAirborne =
        previous.altitude > 500 ||
        previous.wasAirborne === true;

      const wasApproaching =
        distance <
        previous.distance;

      const isAtAirport =
        distance <=
        1.5;

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

      // DEPARTURE

      const wasGround =
        previous.altitude <=
        100;

      const nowAirborne =
        altitude >
        500;

      const wasAtAirport =
        previous.distance <=
        1.5;

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

    // CLEANUP

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

  } catch (error) {

    console.error(
      "KFLL processing error:",
      error.response?.data ||
      error.message
    );
  }
}

// ======================================================
// SLASH COMMAND DEFINITIONS
// ======================================================

const slashCommands = [

  new SlashCommandBuilder()
    .setName("status")
    .setDescription(
      "Show KFLL Operations bot status"
    ),

  new SlashCommandBuilder()
    .setName("arrivals")
    .setDescription(
      "Run the JetBlue KFLL arrival monitor"
    ),

  new SlashCommandBuilder()
    .setName("tracking")
    .setDescription(
      "Run the JetBlue inbound aircraft tracker"
    ),

  new SlashCommandBuilder()
    .setName("ops")
    .setDescription(
      "Check JetBlue operational alerts"
    ),

  new SlashCommandBuilder()
    .setName("weather")
    .setDescription(
      "Show the FLL weather forecast"
    ),

  new SlashCommandBuilder()
    .setName("routes")
    .setDescription(
      "Show the JetBlue FLL flight board"
    ),

  new SlashCommandBuilder()
    .setName("flight")
    .setDescription(
      "Look up a JetBlue flight"
    )
    .addStringOption(
      option =>
        option
          .setName("number")
          .setDescription(
            "Flight number, for example 1200 or JBU1200"
          )
          .setRequired(
            true
          )
    ),

  new SlashCommandBuilder()
    .setName("help")
    .setDescription(
      "Show KFLL Operations bot commands"
    )

].map(
  command =>
    command.toJSON()
);

// ======================================================
// REGISTER SLASH COMMANDS
// ======================================================

async function registerSlashCommands() {

  if (!DISCORD_BOT_TOKEN) {
    return;
  }

  try {

    const applicationId =
      discordClient.application?.id ||
      discordClient.user?.id;

    if (!applicationId) {

      console.error(
        "Could not determine Discord application ID"
      );

      return;
    }

    const rest =
      new REST({
        version:
          "10"
      }).setToken(
        DISCORD_BOT_TOKEN
      );

    await rest.put(
      Routes.applicationCommands(
        applicationId
      ),
      {
        body:
          slashCommands
      }
    );

    console.log(
      "🤖 Slash commands registered"
    );

  } catch (error) {

    console.error(
      "Slash command registration error:",
      error.message
    );
  }
}

// ======================================================
// SLASH COMMAND HANDLER
// ======================================================

discordClient.on(
  "interactionCreate",
  async interaction => {

    if (
      !interaction.isChatInputCommand()
    ) {
      return;
    }

    try {

      // ==================================================
      // /status
      // ==================================================

      if (
        interaction.commandName ===
        "status"
      ) {

        await interaction.reply({
          content:

            `🔵 **JETBLUE KFLL OPERATIONS**\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `🟢 **Bot:** ONLINE\n` +
            `🛬 **Arrivals:** ${ARRIVALS_WEBHOOK ? "ONLINE" : "OFFLINE"}\n` +
            `🚨 **Ops Alerts:** ${ALERTS_WEBHOOK ? "ONLINE" : "OFFLINE"}\n` +
            `📡 **Tracking:** ${TRACKING_WEBHOOK ? "ONLINE" : "OFFLINE"}\n` +
            `⛈️ **Weather:** ${WEATHER_WEBHOOK ? "ONLINE" : "OFFLINE"}\n` +
            `🗺️ **Route Board:** ${ROUTE_BOARD_WEBHOOK ? "ONLINE" : "OFFLINE"}\n` +
            `🔵 **Operations:** ${OPERATIONS_WEBHOOK ? "ONLINE" : "OFFLINE"}\n` +
            `🔑 **FlightAware:** ${FLIGHTAWARE_API_KEY ? "CONNECTED" : "OFFLINE"}\n` +
            `⚡ **Arrival Poll:** 10 sec\n` +
            `📡 **Tracking Poll:** 60 sec\n` +
            `⚠️ **Major Delay:** 45+ min\n` +
            `🔴 **Severe Delay:** 90+ min\n` +
            `🛡️ **Ops Warm-up:** ${opsWarmupComplete ? "COMPLETE" : "INITIALIZING"}\n` +
            `━━━━━━━━━━━━━━━━━━━━`,

          ephemeral:
            true
        });

        return;
      }

      // ==================================================
      // /flight
      // ==================================================

      if (
        interaction.commandName ===
        "flight"
      ) {

        await interaction.deferReply({
          ephemeral:
            true
        });

        const input =
          interaction.options.getString(
            "number",
            true
          );

        const callsign =
          normalizeFlightInput(
            input
          );

        if (!callsign) {

          await interaction.editReply(
            "❌ Please enter a valid flight number."
          );

          return;
        }

        const flight =
          await lookupFlight(
            callsign
          );

        if (!flight) {

          await interaction.editReply(
            `❌ I couldn't find ${callsign} in FlightAware.`
          );

          return;
        }

        const flightNumber =
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

        const aircraft =
          clean(
            flight.aircraft_type
          );

        const registration =
          clean(
            flight.registration ||
            flight.tailnumber
          );

        const status =
          clean(
            flight.status
          );

        const scheduledDeparture =
          formatTime(
            flight.scheduled_off ||
            flight.scheduled_out
          );

        const estimatedDeparture =
          formatTime(
            flight.estimated_off ||
            flight.estimated_out ||
            flight.actual_off
          );

        const scheduledArrival =
          formatTime(
            flight.scheduled_on ||
            flight.scheduled_in
          );

        const estimatedArrival =
          formatTime(
            flight.estimated_on ||
            flight.estimated_in ||
            flight.actual_on
          );

        let delay =
          Number(
            flight.arrival_delay ||
            flight.departure_delay ||
            0
          );

        if (
          !Number.isFinite(
            delay
          )
        ) {
          delay = 0;
        }

        const delayText =
          delay > 0
            ? `+${formatMinutes(
                delay
              )} min`
            : "ON TIME / N/A";

        const message =
          `✈️ **JETBLUE FLIGHT — ${flightNumber}**\n` +
          `━━━━━━━━━━━━━━━━━━━━\n\n` +

          `📍 **Origin:** ${origin}\n` +
          `🎯 **Destination:** ${destination}\n` +
          `🛩️ **Aircraft:** ${aircraft}\n` +
          `🏷️ **Registration:** ${registration}\n` +
          `📋 **Status:** ${status}\n` +
          `⏱️ **Delay:** ${delayText}\n\n` +

          `🛫 **Scheduled Departure:** ${scheduledDeparture}\n` +
          `🕒 **Estimated Departure:** ${estimatedDeparture}\n` +
          `🛬 **Scheduled Arrival:** ${scheduledArrival}\n` +
          `🕒 **Estimated Arrival:** ${estimatedArrival}\n\n` +

          `━━━━━━━━━━━━━━━━━━━━`;

        await interaction.editReply(
          message
        );

        return;
      }

      // ==================================================
      // /arrivals
      // ==================================================

      if (
        interaction.commandName ===
        "arrivals"
      ) {

        await interaction.deferReply({
          ephemeral:
            true
        });

        await checkKFLL();

        await interaction.editReply(
          "🛬 KFLL JetBlue arrival monitor checked."
        );

        return;
      }

      // ==================================================
      // /tracking
      // ==================================================

      if (
        interaction.commandName ===
        "tracking"
      ) {

        await interaction.deferReply({
          ephemeral:
            true
        });

        await checkAircraftTracking();

        await interaction.editReply(
          "📡 JetBlue tracking check completed."
        );

        return;
      }

      // ==================================================
      // /ops
      // ==================================================

      if (
        interaction.commandName ===
        "ops"
      ) {

        await interaction.deferReply({
          ephemeral:
            true
        });

        await checkOpsAlerts();

        await interaction.editReply(
          "🚨 JetBlue Ops check completed."
        );

        return;
      }

      // ==================================================
      // /weather
      // ==================================================

      if (
        interaction.commandName ===
        "weather"
      ) {

        await interaction.deferReply({
          ephemeral:
            true
        });

        const weather =
          await getDailyFLLWeather();

        if (!weather) {

          await interaction.editReply(
            "❌ Unable to retrieve FLL weather right now."
          );

          return;
        }

        await interaction.editReply(
          buildDailyWeatherMessage(
            weather,
            "FLL WEATHER"
          )
        );

        return;
      }

      // ==================================================
      // /routes
      // ==================================================

      if (
        interaction.commandName ===
        "routes"
      ) {

        await interaction.deferReply({
          ephemeral:
            true
        });

        const board =
          await buildRouteBoard();

        if (!board) {

          await interaction.editReply(
            "❌ Unable to retrieve the JetBlue FLL route board right now."
          );

          return;
        }

        await interaction.editReply(
          board
        );

        return;
      }

      // ==================================================
      // /help
      // ==================================================

      if (
        interaction.commandName ===
        "help"
      ) {

        await interaction.reply({
          content:

            `🤖 **KFLL OPERATIONS COMMANDS**\n` +
            `━━━━━━━━━━━━━━━━━━━━\n\n` +

            `🔵 **/status**\n` +
            `View bot status\n\n` +

            `✈️ **/flight number:1200**\n` +
            `Look up a JetBlue flight\n\n` +

            `🛬 **/arrivals**\n` +
            `Run the arrival monitor\n\n` +

            `📡 **/tracking**\n` +
            `Run aircraft tracking\n\n` +

            `🚨 **/ops**\n` +
            `Run Ops Alert check\n\n` +

            `☀️ **/weather**\n` +
            `Show FLL weather forecast\n\n` +

            `🗺️ **/routes**\n` +
            `Show JetBlue FLL flight board\n\n` +

            `🤖 **/help**\n` +
            `Show this menu\n\n` +

            `━━━━━━━━━━━━━━━━━━━━`,

          ephemeral:
            true
        });

        return;
      }

      // ==================================================
      // UNKNOWN COMMAND SAFETY
      // ==================================================

      await interaction.reply({
        content:
          "❌ Unknown command. Use /help.",

        ephemeral:
          true
      });

    } catch (error) {

      console.error(
        "Slash command processing error:",
        error.response?.data ||
        error.message
      );

      if (
        interaction.deferred ||
        interaction.replied
      ) {

        await interaction
          .editReply(
            "❌ Command failed. Check Render Live Tail."
          )
          .catch(
            () => {}
          );

      } else {

        await interaction
          .reply({
            content:
              "❌ Command failed. Check Render Live Tail.",

            ephemeral:
              true
          })
          .catch(
            () => {}
          );
      }
    }
  }
);

// ======================================================
// BOT READY
// ======================================================

discordClient.once(
  "clientReady",
  async () => {

    console.log(
      `🟢 Discord bot online as ${discordClient.user.tag}`
    );

    discordClient.user.setPresence({
      activities: [
        {
          name:
            "JetBlue operations at KFLL",

          type:
            ActivityType.Watching
        }
      ],

      status:
        "online"
    });

    await registerSlashCommands();
  }
);

// ======================================================
// STARTUP DISPLAY
// ======================================================

console.log("");

console.log(
  "🔵 JETBLUE KFLL OPERATIONS"
);

console.log(
  "🛬 ARRIVALS ENABLED"
);

console.log(
  "🚨 QUIET OPS ALERTS ENABLED"
);

console.log(
  "   🛡️ STARTUP WARM-UP ENABLED"
);

console.log(
  "   Delay threshold: 45 minutes"
);

console.log(
  "   Severe threshold: 90 minutes"
);

console.log(
  "   CANCELLATIONS ENABLED"
);

console.log(
  "   DIVERSIONS ENABLED"
);

console.log(
  "   DEPARTURE DELAY SPAM DISABLED"
);

console.log(
  "📡 AIRCRAFT TRACKING ENABLED"
);

console.log(
  "⛈️ WEATHER ALERTS ENABLED"
);

console.log(
  "☀️ DAILY WEATHER: 6 AM / 1 PM / 6 PM ET"
);

console.log(
  "🗺️ ROUTE BOARD: 6 AM / 1 PM / 6 PM ET"
);

console.log(
  "🔵 OPERATIONS / LAST DEPARTURE ENABLED"
);

console.log(
  "🤖 SLASH COMMANDS ENABLED"
);

console.log(
  "   /status"
);

console.log(
  "   /flight"
);

console.log(
  "   /arrivals"
);

console.log(
  "   /tracking"
);

console.log(
  "   /ops"
);

console.log(
  "   /weather"
);

console.log(
  "   /routes"
);

console.log(
  "   /help"
);

console.log(
  "⚡ ARRIVAL POLLING: 10 SECONDS"
);

console.log(
  "📡 TRACKING POLLING: 60 SECONDS"
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
  "📢 Route Board:",
  !!ROUTE_BOARD_WEBHOOK
);

console.log(
  "📢 Operations:",
  !!OPERATIONS_WEBHOOK
);

console.log(
  "🔑 FlightAware:",
  !!FLIGHTAWARE_API_KEY
);

console.log("");

// ======================================================
// LOGIN
// ======================================================

if (
  DISCORD_BOT_TOKEN
) {

  discordClient
    .login(
      DISCORD_BOT_TOKEN
    )
    .catch(
      error => {

        console.error(
          "Discord login failed:",
          error.message
        );
      }
    );

} else {

  console.error(
    "DISCORD_BOT_TOKEN is missing"
  );
}

// ======================================================
// START MONITORS
// ======================================================

// ARRIVALS / DEPARTURES

checkKFLL();

setInterval(
  checkKFLL,
  ARRIVAL_POLL_INTERVAL
);

// LONG-RANGE TRACKING

checkAircraftTracking();

setInterval(
  checkAircraftTracking,
  TRACKING_POLL_INTERVAL
);

// OPS

checkOpsAlerts();

setInterval(
  checkOpsAlerts,
  OPS_POLL_INTERVAL
);

// WEATHER ALERTS

checkWeatherAlerts();

setInterval(
  checkWeatherAlerts,
  WEATHER_POLL_INTERVAL
);

// ======================================================
// SCHEDULED DAILY WEATHER
// ======================================================

// 6:00 AM ET
// 1:00 PM ET
// 6:00 PM ET

checkScheduledWeatherUpdate();

setInterval(
  checkScheduledWeatherUpdate,
  60000
);

// ======================================================
// SCHEDULED ROUTE BOARD
// ======================================================

// 6:00 AM ET
// 1:00 PM ET
// 6:00 PM ET

checkScheduledRouteBoardUpdate();

setInterval(
  checkScheduledRouteBoardUpdate,
  60000
);
