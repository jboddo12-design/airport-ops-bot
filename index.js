const axios = require("axios");
const { Client, GatewayIntentBits, ActivityType } = require("discord.js");

// =====================================================
// ENVIRONMENT VARIABLES
// =====================================================
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const ARRIVALS_WEBHOOK = process.env.DISCORD_ARRIVALS_WEBHOOK;
const ALERTS_WEBHOOK = process.env.DISCORD_ALERTS_WEBHOOK;
const TRACKING_WEBHOOK = process.env.DISCORD_TRACKING_WEBHOOK;
const WEATHER_WEBHOOK = process.env.DISCORD_WEATHER_WEBHOOK;

const OPERATIONS_WEBHOOK =
  process.env.DISCORD_OPERATIONS_WEBHOOK ||
  process.env.DISCORD_FLIGHT_STATUS_WEBHOOK;

const FLIGHTAWARE_API_KEY = process.env.FLIGHTAWARE_API_KEY;

// =====================================================
// KFLL SETTINGS
// =====================================================
const KFLL_LAT = 26.0726;
const KFLL_LON = -80.1527;

const ARRIVAL_RADIUS_NM = 8;
const ARRIVAL_POLL_MS = 5000;

const TRACKING_RADIUS_NM = 80;
const TRACKING_POLL_MS = 60000;

const OPS_ALERT_POLL_MS = 120000;
const OPERATIONS_POLL_MS = 60000;

const WEATHER_ALERT_POLL_MS = 300000;
const DAILY_WEATHER_CHECK_MS = 60000;
const DAILY_WEATHER_HOUR_ET = 6;

const DELAY_THRESHOLD_SECONDS = 30 * 60;

// =====================================================
// MEMORY
// =====================================================
const aircraftState = new Map();
const announcedLandings = new Map();

const trackingState = new Map();
const announcedTracking = new Map();

const recentlyDeparted = new Map();

const opsState = new Map();
const weatherAlertsSeen = new Map();

let lastOperationsDepartureId = null;
let lastDailyWeatherDate = null;
let opsInitialized = false;

// =====================================================
// DISCORD BOT
// =====================================================
const discordClient = new Client({
  intents: [GatewayIntentBits.Guilds]
});

discordClient.once("clientReady", () => {
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
});

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

// =====================================================
// HELPERS
// =====================================================
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

function isJetBlueADSB(plane) {
  return clean(
    plane.flight
  )
    .toUpperCase()
    .startsWith("JBU");
}

function flightCallsign(flight) {
  return clean(
    flight.ident_icao ||
    flight.ident ||
    flight.ident_iata
  ).toUpperCase();
}

function isJetBlueFlight(flight) {
  const ident =
    flightCallsign(flight);

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

function airportCode(airport) {
  return clean(
    airport?.code_iata ||
    airport?.code ||
    airport?.airport_code ||
    airport?.iata ||
    airport?.code_icao
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
    ((lat2 - lat1) * Math.PI) /
    180;

  const dLon =
    ((lon2 - lon1) * Math.PI) /
    180;

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(
      (lat1 * Math.PI) / 180
    ) *
    Math.cos(
      (lat2 * Math.PI) / 180
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

function formatTime(value) {
  if (!value) {
    return "N/A";
  }

  const date =
    value instanceof Date
      ? value
      : new Date(value);

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

function flightReferenceTime(
  flight
) {
  const value =
    flight.actual_off ||
    flight.actual_out ||
    flight.estimated_off ||
    flight.scheduled_off ||
    flight.actual_on ||
    flight.estimated_on ||
    flight.scheduled_on;

  if (!value) {
    return 0;
  }

  const ms =
    new Date(value)
      .getTime();

  return Number.isFinite(ms)
    ? ms
    : 0;
}

function easternNowParts() {
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
    const part
    of parts
  ) {
    values[
      part.type
    ] = part.value;
  }

  return {
    dateKey:
      `${values.year}-${values.month}-${values.day}`,

    hour:
      Number(values.hour),

    minute:
      Number(values.minute)
  };
}

function todayLongDate() {
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

function weatherEmoji(
  text = ""
) {
  const value =
    String(text)
      .toLowerCase();

  if (
    value.includes("thunder") ||
    value.includes("storm")
  ) {
    return "⛈️";
  }

  if (
    value.includes("rain") ||
    value.includes("shower")
  ) {
    return "🌧️";
  }

  if (
    value.includes("cloud") ||
    value.includes("overcast")
  ) {
    return "☁️";
  }

  if (
    value.includes("partly")
  ) {
    return "🌤️";
  }

  return "☀️";
}

function rampWeatherOutlook(
  day,
  night
) {
  const text =
    [
      day?.shortForecast,
      day?.detailedForecast,
      night?.shortForecast,
      night?.detailedForecast
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

  if (
    text.includes("thunder") ||
    text.includes("severe")
  ) {
    return (
      "Thunderstorms are possible today. " +
      "Watch this channel for NWS warnings affecting FLL."
    );
  }

  if (
    text.includes("rain") ||
    text.includes("shower")
  ) {
    return (
      "Rain is possible around FLL today. " +
      "Expect potentially wet ramp conditions."
    );
  }

  if (
    text.includes("windy") ||
    text.includes("breezy")
  ) {
    return (
      "Breezy conditions are expected around FLL today. " +
      "Keep an eye on changing winds."
    );
  }

  return (
    "No significant weather is highlighted in the current FLL forecast. " +
    "Severe-weather alerts will still post automatically."
  );
}

// =====================================================
// DISCORD
// =====================================================
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

// =====================================================
// ADS-B
// =====================================================
async function getAircraft(
  radius
) {
  const url =
    `https://api.adsb.lol/v2/point/` +
    `${KFLL_LAT}/${KFLL_LON}/${radius}`;

  const response =
    await axios.get(
      url,
      {
        timeout:
          10000
      }
    );

  return (
    response.data.ac ||
    []
  );
}

// =====================================================
// FLIGHTAWARE
// =====================================================
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

    return (
      response.data
    );

  } catch (error) {
    console.error(
      `❌ FlightAware ${path}:`,
      error.response?.data ||
      error.message
    );

    return null;
  }
}

async function getFlightDetails(
  callsign
) {
  if (
    !callsign ||
    !FLIGHTAWARE_API_KEY
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
    !flights.length
  ) {
    return null;
  }

  const now =
    Date.now();

  const fllFlights =
    flights.filter(
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

  const choices =
    fllFlights.length
      ? fllFlights
      : flights;

  choices.sort(
    (a, b) => {

      return (
        Math.abs(
          flightReferenceTime(a) -
          now
        ) -
        Math.abs(
          flightReferenceTime(b) -
          now
        )
      );

    }
  );

  return (
    choices[0] ||
    null
  );
}

async function getKFLLFlights() {
  return flightAwareGet(
    "/airports/KFLL/flights",
    {
      airline:
        "JBU",

      max_pages:
        1
    }
  );
}

// =====================================================
// ARRIVALS
// =====================================================
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

// =====================================================
// ADS-B DEPARTURE MEMORY
// ONLY used for return-to-FLL alerts
// =====================================================
function rememberDepartureFromADSB(
  plane
) {
  const hex =
    clean(
      plane.hex
    );

  const callsign =
    clean(
      plane.flight
    ).toUpperCase();

  recentlyDeparted.set(
    hex,
    {
      callsign,

      departedAt:
        Date.now()
    }
  );

  console.log(
    `🛫 ADS-B departure remembered: ${callsign}`
  );
}

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
      plane.alt_baro ===
        "ground" ||
      altitude <=
        100
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

// =====================================================
// OPERATIONS
// LATEST ACTUAL JETBLUE DEPARTURE
// =====================================================
function actualDepartureTime(
  flight
) {
  if (
    !flight.actual_off
  ) {
    return 0;
  }

  const ms =
    new Date(
      flight.actual_off
    ).getTime();

  return Number.isFinite(ms)
    ? ms
    : 0;
}

async function checkLatestOperationsDeparture() {
  if (
    !OPERATIONS_WEBHOOK ||
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

    const departures =
      [
        ...(
          data.departures ||
          []
        ),

        ...(
          data.scheduled_departures ||
          []
        )
      ]
        .filter(
          isJetBlueFlight
        )

        .filter(
          flight => {

            const origin =
              airportCode(
                flight.origin
              );

            return (
              origin === "FLL" ||
              origin === "KFLL"
            );

          }
        )

        .filter(
          flight =>
            actualDepartureTime(
              flight
            ) > 0
        )

        .sort(
          (a, b) =>
            actualDepartureTime(
              b
            ) -
            actualDepartureTime(
              a
            )
        );

    if (
      !departures.length
    ) {
      console.log(
        "🔵 Operations: no actual JetBlue departure found"
      );

      return;
    }

    const latest =
      departures[0];

    const departureId =
      latest.fa_flight_id ||
      `${flightCallsign(
        latest
      )}-${actualDepartureTime(
        latest
      )}`;

    // First scan remembers the current last departure.
    // This prevents an old departure from being posted
    // immediately every time Render restarts.
    if (
      lastOperationsDepartureId ===
      null
    ) {
      lastOperationsDepartureId =
        departureId;

      console.log(
        `🔵 Operations baseline: ${flightCallsign(
          latest
        )}`
      );

      return;
    }

    if (
      departureId ===
      lastOperationsDepartureId
    ) {
      return;
    }

    lastOperationsDepartureId =
      departureId;

    const callsign =
      flightCallsign(
        latest
      );

    const destination =
      airportCode(
        latest.destination
      );

    const aircraft =
      clean(
        latest.aircraft_type
      );

    const registration =
      clean(
        latest.registration
      );

    const message =
      `🛫 **LAST DEPARTURE — KFLL**\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `✈️ **Flight:** ${callsign}\n` +
      `📍 **Destination:** ${destination}\n` +
      `🛩️ **Aircraft:** ${aircraft}\n` +
      `🏷️ **Registration:** ${registration}\n` +
      `🛫 **Status:** DEPARTED\n` +
      `⏱️ **Takeoff:** ${formatTime(
        latest.actual_off
      )}\n` +
      `━━━━━━━━━━━━━━━━━━━━`;

    await sendDiscord(
      OPERATIONS_WEBHOOK,
      message
    );

    console.log(
      `🔵 Operations updated: ${callsign}`
    );

  } catch (error) {
    console.error(
      "❌ Operations departure error:",
      error.response?.data ||
      error.message
    );
  }
}

// =====================================================
// AIRCRAFT TRACKING
// =====================================================
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
      validForFLL:
        true,

      origin,

      registration
    };
  }

  const destination =
    airportCode(
      flight.destination
    );

  return {
    validForFLL:
      destination === "FLL" ||
      destination === "KFLL",

    origin:
      airportCode(
        flight.origin
      ),

    registration:
      flight.registration ||
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
  const id =
    `${clean(
      plane.hex
    )}-${callsign}`;

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
      `📏 **Distance:** ${distance.toFixed(
        1
      )} NM\n` +
      `⏱️ **Estimated:** ${Math.round(
        etaMinutes
      )} min\n` +
      `━━━━━━━━━━━━━━━━━━━━`;

  } else if (
    type === "15MIN"
  ) {
    message =
      `🕒 **15 MIN OUT — ${callsign}**\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `📍 **Route:** ${info.origin} → FLL\n` +
      `🏷️ **Registration:** ${info.registration}\n` +
      `📏 **Distance:** ${distance.toFixed(
        1
      )} NM\n` +
      `⏱️ **Estimated:** ${Math.round(
        etaMinutes
      )} min\n` +
      `━━━━━━━━━━━━━━━━━━━━`;

  } else {
    message =
      `🛬 **ON APPROACH — ${callsign}**\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `📍 **Route:** ${info.origin} → FLL\n` +
      `🏷️ **Registration:** ${info.registration}\n` +
      `📏 **Distance:** ${distance.toFixed(
        1
      )} NM\n` +
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
        isJetBlueADSB
      );

    const now =
      Date.now();

    console.log(
      `📡 JBU tracking aircraft: ${jetblue.length}`
    );

    for (
      const plane
      of jetblue
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
        plane.alt_baro ===
          "ground"
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

      const id =
        `${clean(
          plane.hex
        )}-${callsign}`;

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

// =====================================================
// OPS ALERTS
// =====================================================
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

    const flights =
      [
        ...(
          data.scheduled_arrivals ||
          []
        ),

        ...(
          data.scheduled_departures ||
          []
        ),

        ...(
          data.arrivals ||
          []
        ),

        ...(
          data.departures ||
          []
        )
      ].filter(
        isJetBlueFlight
      );

    const unique =
      new Map();

    for (
      const flight
      of flights
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

      unique.set(
        key,
        flight
      );
    }

    // Prevent old alerts from flooding Discord on startup.
    if (
      !opsInitialized
    ) {
      for (
        const [
          key,
          flight
        ]
        of unique.entries()
      ) {
        opsState.set(
          key,
          {
            cancelled:
              flight.cancelled ===
              true,

            diverted:
              flight.diverted ===
              true,

            arrivalDelayBucket:
              Math.floor(
                Number(
                  flight.arrival_delay ||
                  0
                ) /
                (
                  15 *
                  60
                )
              ),

            departureDelayBucket:
              Math.floor(
                Number(
                  flight.departure_delay ||
                  0
                ) /
                (
                  15 *
                  60
                )
              ),

            timestamp:
              Date.now()
          }
        );
      }

      opsInitialized =
        true;

      console.log(
        "🚨 Ops Alerts baseline established"
      );

      return;
    }

    for (
      const [
        key,
        flight
      ]
      of unique.entries()
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
        flight.cancelled ===
          true &&
        previous.cancelled !==
          true
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
        flight.diverted ===
          true &&
        previous.diverted !==
          true
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
        const bucket =
          Math.floor(
            arrivalDelay /
            (
              15 *
              60
            )
          );

        if (
          previous.arrivalDelayBucket !==
          bucket
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
          bucket;
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
        const bucket =
          Math.floor(
            departureDelay /
            (
              15 *
              60
            )
          );

        if (
          previous.departureDelayBucket !==
          bucket
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
          bucket;
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

// =====================================================
// NATIONAL WEATHER SERVICE
// =====================================================
const NWS_HEADERS = {
  "User-Agent":
    "KFLL-Discord-Ops/1.0"
};

async function getNWSForecast() {
  const pointResponse =
    await axios.get(
      `https://api.weather.gov/points/${KFLL_LAT},${KFLL_LON}`,
      {
        headers:
          NWS_HEADERS,

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
      "NWS forecast URL missing for KFLL"
    );
  }

  const forecastResponse =
    await axios.get(
      forecastUrl,
      {
        headers:
          NWS_HEADERS,

        timeout:
          15000
      }
    );

  return (
    forecastResponse.data
      ?.properties
      ?.periods ||
    []
  );
}

// =====================================================
// DAILY WEATHER
// =====================================================
async function sendDailyWeather() {
  if (
    !WEATHER_WEBHOOK
  ) {
    return;
  }

  try {
    const periods =
      await getNWSForecast();

    if (
      !periods.length
    ) {
      return;
    }

    const day =
      periods.find(
        period =>
          period.isDaytime ===
          true
      ) ||
      periods[0];

    const dayIndex =
      periods.indexOf(
        day
      );

    const night =
      periods
        .slice(
          Math.max(
            dayIndex + 1,
            0
          )
        )
        .find(
          period =>
            period.isDaytime ===
            false
        ) ||
      periods.find(
        period =>
          period.isDaytime ===
          false
      );

    const high =
      day?.temperature ??
      "N/A";

    const low =
      night?.temperature ??
      "N/A";

    const dayRain =
      Number(
        day
          ?.probabilityOfPrecipitation
          ?.value ??
        0
      );

    const nightRain =
      Number(
        night
          ?.probabilityOfPrecipitation
          ?.value ??
        0
      );

    const rainChance =
      Math.max(
        dayRain ||
        0,

        nightRain ||
        0
      );

    const condition =
      day?.shortForecast ||
      "Forecast available";

    const emoji =
      weatherEmoji(
        condition
      );

    const winds =
      [
        day?.windDirection,
        day?.windSpeed
      ]
        .filter(Boolean)
        .join(" ");

    const outlook =
      rampWeatherOutlook(
        day,
        night
      );

    const message =
      `${emoji} **FLL DAILY WEATHER**\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `📅 **${todayLongDate()}**\n\n` +
      `🌡️ **High:** ${high}°F\n` +
      `🌙 **Low:** ${low}°F\n` +
      `🌧️ **Rain Chance:** ${rainChance}%\n` +
      `💨 **Winds:** ${winds || "N/A"}\n` +
      `${emoji} **Forecast:** ${condition}\n\n` +
      `🛬 **Ramp Outlook:**\n` +
      `${outlook}\n` +
      `━━━━━━━━━━━━━━━━━━━━`;

    await sendDiscord(
      WEATHER_WEBHOOK,
      message
    );

    console.log(
      "☀️ Daily FLL weather posted"
    );

  } catch (error) {
    console.error(
      "❌ Daily weather error:",
      error.response?.data ||
      error.message
    );
  }
}

async function checkDailyWeatherSchedule() {
  if (
    !WEATHER_WEBHOOK
  ) {
    return;
  }

  const eastern =
    easternNowParts();

  if (
    eastern.hour >=
      DAILY_WEATHER_HOUR_ET &&
    lastDailyWeatherDate !==
      eastern.dateKey
  ) {
    await sendDailyWeather();

    lastDailyWeatherDate =
      eastern.dateKey;
  }
}

// =====================================================
// SEVERE WEATHER
// =====================================================
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

          headers:
            NWS_HEADERS,

          timeout:
            15000
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
      const feature
      of response.data
        ?.features ||
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

      const description =
        clean(
          props.description
        );

      const shortDescription =
        description === "N/A"
          ? ""
          : description
              .replace(
                /\s+/g,
                " "
              )
              .slice(
                0,
                450
              );

      const message =
        `⛈️ **FLL SEVERE WEATHER**\n` +
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
        (
          shortDescription
            ? `\n${shortDescription}\n`
            : ""
        ) +
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

// =====================================================
// MAIN 5-SECOND KFLL MONITOR
// =====================================================
async function checkKFLL() {
  try {
    const aircraft =
      await getAircraft(
        ARRIVAL_RADIUS_NM
      );

    const jetblue =
      aircraft.filter(
        isJetBlueADSB
      );

    const now =
      Date.now();

    console.log(
      `🔵 JBU aircraft near KFLL: ${jetblue.length}`
    );

    for (
      const plane
      of jetblue
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
        plane.alt_baro ===
          "ground"
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
        `DIST: ${distance.toFixed(
          1
        )} NM`
      );

      // =================================================
      // FIRST OBSERVATION
      // =================================================
      if (!previous) {
        aircraftState.set(
          id,
          {
            distance,
            altitude,
            timestamp:
              now,

            wasAirborne:
              altitude >
              500
          }
        );

        continue;
      }

      // =================================================
      // ARRIVAL DETECTION
      // SAME WORKING LOGIC
      // =================================================
      const wasAirborne =
        previous.altitude >
          500 ||
        previous.wasAirborne ===
          true;

      const wasApproaching =
        distance <
        previous.distance;

      const isAtAirport =
        distance <=
        1.5;

      const isGround =
        plane.alt_baro ===
          "ground" ||
        altitude <=
          100;

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

      // =================================================
      // DEPARTURE MEMORY ONLY
      // =================================================
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
        rememberDepartureFromADSB(
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
            altitude >
              500
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

// =====================================================
// STARTUP
// =====================================================
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
  "☀️ DAILY FLL WEATHER ENABLED"
);

console.log(
  "⛈️ SEVERE WEATHER ALERTS ENABLED"
);

console.log(
  "🔵 OPERATIONS / LATEST DEPARTURE ENABLED"
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

// =====================================================
// START LOOPS
// =====================================================

// ARRIVALS
checkKFLL();

setInterval(
  checkKFLL,
  ARRIVAL_POLL_MS
);

// OPERATIONS
setTimeout(
  checkLatestOperationsDeparture,
  10000
);

setInterval(
  checkLatestOperationsDeparture,
  OPERATIONS_POLL_MS
);

// AIRCRAFT TRACKING
setTimeout(
  checkAircraftTracking,
  20000
);

setInterval(
  checkAircraftTracking,
  TRACKING_POLL_MS
);

// OPS ALERTS
setTimeout(
  checkOpsAlerts,
  30000
);

setInterval(
  checkOpsAlerts,
  OPS_ALERT_POLL_MS
);

// SEVERE WEATHER
setTimeout(
  checkWeatherAlerts,
  40000
);

setInterval(
  checkWeatherAlerts,
  WEATHER_ALERT_POLL_MS
);

// DAILY WEATHER
setTimeout(
  checkDailyWeatherSchedule,
  50000
);

setInterval(
  checkDailyWeatherSchedule,
  DAILY_WEATHER_CHECK_MS
);
