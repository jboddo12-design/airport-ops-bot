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
const TRACKING_POLL_INTERVAL = 30000;

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
          timeout: 10000
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
        "⚠️ ADS-B rate limited — waiting for next poll"
      );

      return [];
    }

    throw error;
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
// UPDATED TO PREFER THE FLL LEG
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

  // First choice:
  // find the JetBlue leg whose destination is FLL/KFLL
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

  // Second choice:
  // prefer a flight record that actually has an origin
  const withOrigin =
    flights.find(
      flight => {

        const origin =
          airportCode(
            flight.origin
          );

        return (
          origin &&
          origin !== "N/A"
        );
      }
    );

  if (withOrigin) {

    return withOrigin;
  }

  return flights[0];
}

// ------------------------------------------------------

async function getKFLLFlights() {

  if (
    !FLIGHTAWARE_API_KEY
  ) {

    return null;
  }

  return await flightAwareGet(
    "/airports/KFLL/flights",
    {
      airline: "JBU",
      max_pages: 1
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
      "❌ Discord webhook missing"
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
      "❌ Discord webhook error:",
      error.response?.data ||
      error.message
    );
  }
}

// ======================================================
// ARRIVAL
// UPDATED ORIGIN LOOKUP
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

    const foundOrigin =
      airportCode(
        flight.origin
      );

    if (
      foundOrigin &&
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
      `⚠️ No FlightAware details found for ${callsign}`
    );
  }

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
// LAST DEPARTURE -> OPERATIONS
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
        Date.now(),

      lastDistance:
        0
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

    departed.lastDistance =
      distance;

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
    `↩️ **RETURN TO FLL — ${departed.callsign}**\n` +
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
              plane.alt_baro || 0
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
      "❌ Tracking error:",
      error.response?.data ||
      error.message
    );
  }
}

// ======================================================
// OPS ALERTS
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
        destination === "FLL" ||
        destination === "KFLL"
      ) {

        if (
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
      }

      // DEPARTURE DELAY

      const departureDelay =
        Number(
          flight.departure_delay ||
          0
        );

      if (
        origin === "FLL" ||
        origin === "KFLL"
      ) {

        if (
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
      }

      previous.cancelled =
        flight.cancelled ===
        true;

      previous.diverted =
        flight.diverted ===
        true;

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

      const headline =
        clean(
          props.headline
        );

      const severity =
        clean(
          props.severity
        );

      const expires =
        props.expires
          ? formatTime(
              props.expires
            )
          : "N/A";

      const message =
        `⛈️ **FLL WEATHER ALERT**\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `⚠️ **${event}**\n` +
        `📋 **${headline}**\n` +
        `🚨 **Severity:** ${severity}\n` +
        `⏱️ **Expires:** ${expires}\n` +
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
// KFLL ARRIVAL + DEPARTURE DETECTION
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

      // ARRIVAL DETECTION

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

      // DEPARTURE DETECTION

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

      // RETURN TO FLL

      await checkReturnToFLL(
        plane,
        distance,
        altitude
      );

      // UPDATE STATE

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

    // CLEAN OLD AIRCRAFT

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

    // CLEAN LANDING ALERTS

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

    // CLEAN DEPARTURE ALERTS

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

    // CLEAN TRACKING ALERTS

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

console.log("");

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
  "⚡ ARRIVAL POLLING: 10 SECONDS"
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
// START LOOPS
// ======================================================

checkKFLL();

setInterval(
  checkKFLL,
  ARRIVAL_POLL_INTERVAL
);

checkAircraftTracking();

setInterval(
  checkAircraftTracking,
  TRACKING_POLL_INTERVAL
);

checkOpsAlerts();

setInterval(
  checkOpsAlerts,
  OPS_POLL_INTERVAL
);

checkWeatherAlerts();

setInterval(
  checkWeatherAlerts,
  WEATHER_POLL_INTERVAL
);
