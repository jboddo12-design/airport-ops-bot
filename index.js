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

// Arrival detector
const ARRIVAL_RADIUS_NM = 8;
const ARRIVAL_POLL_INTERVAL = 10000;

// Long-range tracking
const TRACKING_RADIUS_NM = 160;
const TRACKING_POLL_INTERVAL = 60000;

// Ops alerts
const OPS_POLL_INTERVAL = 120000;

// Weather
const WEATHER_POLL_INTERVAL = 300000;

// Delay thresholds
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

// ------------------------------------------------------

function isJetBlue(plane) {

  return clean(
    plane.flight
  )
    .toUpperCase()
    .startsWith("JBU");
}

// ------------------------------------------------------

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

// ------------------------------------------------------

function flightCallsign(flight) {

  return clean(
    flight.ident_icao ||
    flight.ident ||
    flight.ident_iata
  ).toUpperCase();
}

// ------------------------------------------------------

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
      lat1 *
      Math.PI /
      180
    ) *

    Math.cos(
      lat2 *
      Math.PI /
      180
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

// ------------------------------------------------------

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

// ------------------------------------------------------

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

// ------------------------------------------------------

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

  if (
    !FLIGHTAWARE_API_KEY
  ) {
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

  // Prefer flight going to FLL
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

  // Otherwise choose record with a valid origin
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
// KFLL FLIGHTAWARE FLIGHTS
// ======================================================

async function getKFLLFlights() {

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
// TRACKING
// 20 MIN OUT
// 15 MIN OUT
// ON APPROACH
// ======================================================

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

    // Cleanup tracker memory

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
    // LIVE OPS ALERTS
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

      // ==================================================
      // CANCELLATION
      // ==================================================

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

        console.log(
          `Cancellation detected: ${callsign}`
        );
      }

      // ==================================================
      // DIVERSION
      // ==================================================

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

        console.log(
          `Diversion detected: ${callsign}`
        );
      }

      // ==================================================
      // ARRIVAL DELAYS ONLY
      // ==================================================

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

        // ================================================
        // 90 MIN
        // ================================================

        if (
          arrivalDelay >=
          SEVERE_DELAY_SECONDS &&
          previous.severeDelaySent !== true
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

          console.log(
            `Severe delay detected: ${callsign}`
          );

        }

        // ================================================
        // 45 MIN
        // ================================================

        else if (
          arrivalDelay >=
          MAJOR_DELAY_SECONDS &&
          previous.majorDelaySent !== true
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

          console.log(
            `Major delay detected: ${callsign}`
          );
        }
      }

      previous.timestamp =
        Date.now();

      opsState.set(
        key,
        previous
      );
    }

    // Cleanup old ops state

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
      "Weather processing error:",
      error.response?.data ||
      error.message
    );
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

            timestamp:
              now,

            wasAirborne:
              altitude > 500
          }
        );

        continue;
      }

      // ==================================================
      // ARRIVAL
      // ==================================================

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

      // ==================================================
      // DEPARTURE
      // ==================================================

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

      // ==================================================
      // RETURN TO FLL
      // ==================================================

      await checkReturnToFLL(
        plane,
        distance,
        altitude
      );

      // ==================================================
      // UPDATE STATE
      // ==================================================

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

    // ==================================================
    // CLEANUP
    // ==================================================

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
      "Run the KFLL JetBlue arrival monitor"
    ),

  new SlashCommandBuilder()
    .setName("tracking")
    .setDescription(
      "Run the JetBlue inbound aircraft tracker"
    ),

  new SlashCommandBuilder()
    .setName("ops")
    .setDescription(
      "Run the JetBlue operations alert check"
    ),

  new SlashCommandBuilder()
    .setName("weather")
    .setDescription(
      "Check active FLL weather alerts"
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

  if (
    !DISCORD_BOT_TOKEN
  ) {
    return;
  }

  try {

    const applicationId =
      discordClient.application?.id ||
      discordClient.user?.id;

    if (
      !applicationId
    ) {

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
          "📡 JetBlue aircraft tracking check completed."
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

        await checkWeatherAlerts();

        await interaction.editReply(
          "⛈️ FLL weather alert check completed."
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
            `View bot and system status\n\n` +

            `🛬 **/arrivals**\n` +
            `Run the JetBlue arrival monitor\n\n` +

            `📡 **/tracking**\n` +
            `Run the inbound aircraft tracker\n\n` +

            `🚨 **/ops**\n` +
            `Check delays, cancellations and diversions\n\n` +

            `⛈️ **/weather**\n` +
            `Check FLL weather alerts\n\n` +

            `🤖 **/help**\n` +
            `Show this command menu\n\n` +

            `━━━━━━━━━━━━━━━━━━━━`,

          ephemeral:
            true
        });

        return;
      }

    } catch (error) {

      console.error(
        "Slash command processing error:",
        error.message
      );

      if (
        interaction.deferred ||
        interaction.replied
      ) {

        await interaction
          .editReply(
            "Command failed. Check Render Live Tail."
          )
          .catch(
            () => {}
          );

      } else {

        await interaction
          .reply({
            content:
              "Command failed. Check Render Live Tail.",

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

    // Register commands every time bot starts
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
  "🔵 OPERATIONS / LAST DEPARTURE ENABLED"
);

console.log(
  "🤖 SLASH COMMANDS ENABLED"
);

console.log(
  "   /status"
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

// Arrival / departure
checkKFLL();

setInterval(
  checkKFLL,
  ARRIVAL_POLL_INTERVAL
);

// Tracking
checkAircraftTracking();

setInterval(
  checkAircraftTracking,
  TRACKING_POLL_INTERVAL
);

// Ops
checkOpsAlerts();

setInterval(
  checkOpsAlerts,
  OPS_POLL_INTERVAL
);

// Weather
checkWeatherAlerts();

setInterval(
  checkWeatherAlerts,
  WEATHER_POLL_INTERVAL
);
