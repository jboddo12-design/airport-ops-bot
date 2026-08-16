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

const OPERATIONS_WEBHOOK =
  process.env.DISCORD_FLIGHT_STATUS_WEBHOOK;

const TRACKING_WEBHOOK =
  process.env.DISCORD_TRACKING_WEBHOOK;

const WEATHER_WEBHOOK =
  process.env.DISCORD_WEATHER_WEBHOOK;

const FLIGHTAWARE_API_KEY =
  process.env.FLIGHTAWARE_API_KEY;

// ======================================================
// KFLL SETTINGS
// ======================================================

const KFLL_LAT = 26.0726;
const KFLL_LON = -80.1527;

// Keep arrivals exactly on the fast 5-second monitor
const ARRIVAL_RADIUS_NM = 8;
const ARRIVAL_POLL_INTERVAL = 5000;

// Longer-range aircraft tracking
const TRACKING_RADIUS_NM = 160;
const TRACKING_POLL_INTERVAL = 30000;

// FlightAware operational checks
const OPS_POLL_INTERVAL = 120000;

// Weather checks
const WEATHER_POLL_INTERVAL = 300000;

// Alert when delay reaches 30 minutes
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

  return clean(
    airport?.code_iata ||
    airport?.code ||
    airport?.code_icao
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

  if (Number.isNaN(date.getTime())) {
    return "N/A";
  }

  return (
    new Intl.DateTimeFormat(
      "en-US",
      {
        timeZone:
          "America/New_York",

        hour: "2-digit",
        minute: "2-digit",

        hour12: true
      }
    ).format(date) +
    " ET"
  );

}

// ------------------------------------------------------

function formatMinutes(seconds) {

  if (
    seconds === null ||
    seconds === undefined ||
    !Number.isFinite(Number(seconds))
  ) {

    return "N/A";
  }

  return Math.round(
    Number(seconds) / 60
  );
}

// ------------------------------------------------------

function getGroundSpeed(plane) {

  const gs =
    Number(plane.gs);

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
    getGroundSpeed(plane);

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

// ------------------------------------------------------

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
      `/flights/${encodeURIComponent(callsign)}`,
      {
        start:
          new Date(
            Date.now() -
            6 *
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
      }
    );

  return (
    data?.flights?.[0] ||
    null
  );

}

// ------------------------------------------------------

async function getKFLLFlights() {

  if (!FLIGHTAWARE_API_KEY) {
    return null;
  }

  const now =
    Date.now();

  return await flightAwareGet(
    "/airports/KFLL/flights",
    {
      airline: "JBU",

      start:
        new Date(
          now -
          3 *
          60 *
          60 *
          1000
        ).toISOString(),

      end:
        new Date(
          now +
          12 *
          60 *
          60 *
          1000
        ).toISOString(),

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
// SAME WORKING ARRIVAL SYSTEM.
// ONLY "DETECTION" LINE REMOVED.
// ======================================================

async function announceArrival(
  plane
) {

  const callsign =
    clean(
      plane.flight
    ).toUpperCase();

  const hex =
    clean(plane.hex);

  const landingId =
    `${hex}-${callsign}`;

  // Prevent duplicate arrival messages
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
      flight.origin?.code_iata ||
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
    `━━━━━━━━━━━━━━━━━━━━`;

  await sendDiscord(
    ARRIVALS_WEBHOOK,
    message
  );

}

// ======================================================
// LAST DEPARTURE
//
// NORMAL DEPARTURES CHANNEL IS REMOVED.
// THIS POSTS THE DEPARTURE INTO OPERATIONS.
// ======================================================

async function announceLastDeparture(
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

  // Remember the aircraft so we can detect a return
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
    clean(plane.t);

  let registration =
    clean(plane.r);

  if (flight) {

    destination =
      flight.destination?.code_iata ||
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
// RETURN TO FLL ALERT
// ======================================================

async function checkReturnToFLL(
  plane,
  distance,
  altitude
) {

  const hex =
    clean(plane.hex);

  const departed =
    recentlyDeparted.get(hex);

  if (!departed) {
    return;
  }

  const age =
    Date.now() -
    departed.departedAt;

  // Watch recent departures for 2 hours
  if (
    age >
    2 *
    60 *
    60 *
    1000
  ) {

    recentlyDeparted.delete(hex);

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

  recentlyDeparted.delete(hex);

}

// ======================================================
// AIRCRAFT TRACKING
//
// 20 MIN OUT
// 15 MIN OUT
// ON APPROACH
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
        clean(plane.hex);

      const id =
        `${hex}-${callsign}`;

      const previous =
        trackingState.get(id);

      trackingState.set(
        id,
        {
          distance,
          altitude,
          timestamp:
            now
        }
      );

      // Need two observations before determining direction
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
        clean(plane.r);

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

            // Only flights headed to FLL
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

          const message =
            `🕒 **20 MIN OUT — ${callsign}**\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `📍 **${origin} → FLL**\n` +
            `🏷️ **${registration}**\n` +
            `📏 **Distance:** ${distance.toFixed(1)} NM\n` +
            `⏱️ **Estimated:** ${Math.round(etaMinutes)} min\n` +
            `━━━━━━━━━━━━━━━━━━━━`;

          await sendDiscord(
            TRACKING_WEBHOOK,
            message
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

          const message =
            `🕒 **15 MIN OUT — ${callsign}**\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `📍 **${origin} → FLL**\n` +
            `🏷️ **${registration}**\n` +
            `📏 **Distance:** ${distance.toFixed(1)} NM\n` +
            `⏱️ **Estimated:** ${Math.round(etaMinutes)} min\n` +
            `━━━━━━━━━━━━━━━━━━━━`;

          await sendDiscord(
            TRACKING_WEBHOOK,
            message
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

          const message =
            `🛬 **ON APPROACH — ${callsign}**\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `📍 **${origin} → FLL**\n` +
            `🏷️ **${registration}**\n` +
            `📏 **Distance:** ${distance.toFixed(1)} NM\n` +
            `⬇️ **Altitude:** ${Math.round(
              altitude
            ).toLocaleString()} ft\n` +
            `━━━━━━━━━━━━━━━━━━━━`;

          await sendDiscord(
            TRACKING_WEBHOOK,
            message
          );

        }

      }

    }

    // Cleanup old tracking state
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
// CANCELLATIONS
// DIVERSIONS
// ARRIVAL DELAYS
// DEPARTURE DELAYS
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
    ]
      .filter(
        isJetBlueFlight
      );

    const uniqueFlights =
      new Map();

    for (
      const flight of flights
    ) {

      const key =
        flight.fa_flight_id ||
        `${flightCallsign(flight)}-${flight.scheduled_off || flight.scheduled_on || ""}`;

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
        opsState.get(key) ||
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

      // ==================================================
      // CANCELLED
      // ==================================================

      if (
        flight.cancelled === true &&
        previous.cancelled !== true
      ) {

        const message =
          `❌ **CANCELLED — ${callsign}**\n` +
          `━━━━━━━━━━━━━━━━━━━━\n` +
          `📍 **Route:** ${origin} → ${destination}\n` +
          `🏷️ **Registration:** ${registration}\n` +
          `📋 **Status:** ${clean(
            flight.status
          )}\n` +
          `━━━━━━━━━━━━━━━━━━━━`;

        await sendDiscord(
          ALERTS_WEBHOOK,
          message
        );

      }

      // ==================================================
      // DIVERTED
      // ==================================================

      if (
        flight.diverted === true &&
        previous.diverted !== true
      ) {

        const message =
          `↪️ **DIVERTED — ${callsign}**\n` +
          `━━━━━━━━━━━━━━━━━━━━\n` +
          `📍 **Route:** ${origin} → ${destination}\n` +
          `🏷️ **Registration:** ${registration}\n` +
          `📋 **Status:** ${clean(
            flight.status
          )}\n` +
          `━━━━━━━━━━━━━━━━━━━━`;

        await sendDiscord(
          ALERTS_WEBHOOK,
          message
        );

      }

      // ==================================================
      // ARRIVAL DELAY
      // ==================================================

      const arrivalDelay =
        Number(
          flight.arrival_delay || 0
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

            const message =
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
              `━━━━━━━━━━━━━━━━━━━━`;

            await sendDiscord(
              ALERTS_WEBHOOK,
              message
            );

          }

          previous.arrivalDelayBucket =
            delayBucket;

        }

      }

      // ==================================================
      // DEPARTURE DELAY
      //
      // This is an ALERT only.
      // It does NOT restore the departures channel.
      // ==================================================

      const departureDelay =
        Number(
          flight.departure_delay || 0
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

            const message =
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
              `━━━━━━━━━━━━━━━━━━━━`;

            await sendDiscord(
              ALERTS_WEBHOOK,
              message
            );

          }

          previous.departureDelayBucket =
            delayBucket;

        }

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
      "❌ Ops alert error:",
      error.response?.data ||
      error.message
    );

  }

}

// ======================================================
// FLL WEATHER ALERTS
//
// Uses active NWS alerts at KFLL.
// DOES NOT claim that JetBlue has closed the ramp.
// ======================================================

async function checkWeatherAlerts() {

  if (!WEATHER_WEBHOOK) {
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

          timeout: 15000
        }
      );

    const features =
      response.data?.features ||
      [];

    const importantEvents =
      [
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

    // Cleanup weather alert memory
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
// KFLL MAIN MONITOR
//
// ARRIVALS REMAIN ON THE ORIGINAL 5-SECOND LOOP.
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

      const previous =
        aircraftState.get(id);

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
            timestamp: now,

            wasAirborne:
              altitude > 500
          }
        );

        continue;
      }

      // ==================================================
      // ARRIVAL DETECTION
      //
      // KEEP THIS EXACTLY AS THE WORKING VERSION.
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
      // NO DEPARTURES CHANNEL.
      //
      // We still detect it so Operations can show the
      // last departure and so a return can be detected.
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

      // ==================================================
      // RETURN TO FLL CHECK
      // ==================================================

      await checkReturnToFLL(
        plane,
        distance,
        altitude
      );

      // ==================================================
      // UPDATE AIRCRAFT STATE
      // ==================================================

      aircraftState.set(
        id,
        {
          distance,
          altitude,
          timestamp: now,

          wasAirborne:
            previous.wasAirborne ||
            altitude > 500
        }
      );

    }

    // ==================================================
    // CLEANUP AIRCRAFT
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

    // ==================================================
    // CLEANUP LANDING ALERTS
    // ==================================================

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

    // ==================================================
    // CLEANUP DEPARTURE ALERTS
    // ==================================================

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

    // ==================================================
    // CLEANUP TRACKING ALERTS
    // ==================================================

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

// ------------------------------------------------------
// ARRIVALS
// Keep the important arrival monitor running every
// 5 seconds, exactly like the working setup.
// ------------------------------------------------------

checkKFLL();

setInterval(
  checkKFLL,
  ARRIVAL_POLL_INTERVAL
);

// ------------------------------------------------------
// AIRCRAFT TRACKING
// Separate from arrivals.
// ------------------------------------------------------

checkAircraftTracking();

setInterval(
  checkAircraftTracking,
  TRACKING_POLL_INTERVAL
);

// ------------------------------------------------------
// OPS ALERTS
// ------------------------------------------------------

checkOpsAlerts();

setInterval(
  checkOpsAlerts,
  OPS_POLL_INTERVAL
);

// ------------------------------------------------------
// WEATHER
// ------------------------------------------------------

checkWeatherAlerts();

setInterval(
  checkWeatherAlerts,
  WEATHER_POLL_INTERVAL
);
