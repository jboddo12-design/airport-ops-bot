const axios = require("axios");
const { Client, GatewayIntentBits, ActivityType } = require("discord.js");

// ======================================================
// ENVIRONMENT VARIABLES
// ======================================================

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;

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

// ARRIVALS
const ARRIVAL_RADIUS_NM = 8;
const ARRIVAL_POLL_INTERVAL = 5000;

// TRACKING
const TRACKING_RADIUS_NM = 80;
const TRACKING_POLL_INTERVAL = 60000;

// OPS ALERTS
const OPS_POLL_INTERVAL = 120000;

// OPERATIONS CHANNEL
const OPERATIONS_POLL_INTERVAL = 60000;

// WEATHER
const WEATHER_ALERT_POLL_INTERVAL = 300000;
const DAILY_WEATHER_CHECK_INTERVAL = 60000;
const DAILY_WEATHER_HOUR = 6;

// Delay alerts start at 30 minutes
const DELAY_THRESHOLD_SECONDS =
  30 * 60;

// ======================================================
// MEMORY
// ======================================================

const aircraftState =
  new Map();

const announcedLandings =
  new Map();

const trackingState =
  new Map();

const announcedTracking =
  new Map();

const opsState =
  new Map();

const weatherAlertsSeen =
  new Map();

const recentlyDeparted =
  new Map();

let lastDailyWeatherDate =
  null;

let lastOperationsDepartureId =
  null;

// ======================================================
// DISCORD BOT
// ======================================================

const discordClient =
  new Client({
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
          name:
            "JetBlue operations at KFLL",

          type:
            ActivityType.Watching
        }
      ],

      status:
        "online"
    });

  }
);

if (DISCORD_BOT_TOKEN) {

  discordClient
    .login(
      DISCORD_BOT_TOKEN
    )
    .catch(
      error => {

        console.error(
          "❌ Discord login failed:",
          error.message
        );

      }
    );

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

  return String(
    value
  ).trim();

}

// ------------------------------------------------------

function isJetBlue(
  plane
) {

  return clean(
    plane.flight
  )
    .toUpperCase()
    .startsWith(
      "JBU"
    );

}

// ------------------------------------------------------

function isJetBlueFlight(
  flight
) {

  const ident =
    clean(
      flight.ident_icao ||
      flight.ident ||
      flight.ident_iata
    )
      .toUpperCase();

  const operator =
    clean(
      flight.operator_icao ||
      flight.operator ||
      flight.operator_iata
    )
      .toUpperCase();

  return (
    ident.startsWith(
      "JBU"
    ) ||
    ident.startsWith(
      "B6"
    ) ||
    operator ===
      "JBU" ||
    operator ===
      "B6"
  );

}

// ------------------------------------------------------

function flightCallsign(
  flight
) {

  return clean(
    flight.ident_icao ||
    flight.ident ||
    flight.ident_iata
  )
    .toUpperCase();

}

// ------------------------------------------------------

function airportCode(
  airport
) {

  return clean(
    airport?.code_iata ||
    airport?.code ||
    airport?.airport_code ||
    airport?.iata ||
    airport?.code_icao
  )
    .toUpperCase();

}

// ------------------------------------------------------

function distanceNM(
  lat1,
  lon1,
  lat2,
  lon2
) {

  const R =
    3440.065;

  const dLat =
    (
      (
        lat2 -
        lat1
      ) *
      Math.PI
    ) /
    180;

  const dLon =
    (
      (
        lon2 -
        lon1
      ) *
      Math.PI
    ) /
    180;

  const a =
    Math.sin(
      dLat / 2
    ) ** 2 +
    Math.cos(
      (
        lat1 *
        Math.PI
      ) /
      180
    ) *
    Math.cos(
      (
        lat2 *
        Math.PI
      ) /
      180
    ) *
    Math.sin(
      dLon / 2
    ) ** 2;

  return (
    R *
    2 *
    Math.atan2(
      Math.sqrt(
        a
      ),
      Math.sqrt(
        1 - a
      )
    )
  );

}

// ------------------------------------------------------

function formatTime(
  timestamp
) {

  if (!timestamp) {

    return "N/A";

  }

  const date =
    timestamp instanceof Date
      ? timestamp
      : new Date(
          timestamp
        );

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
    ).format(
      date
    ) +
    " ET"
  );

}

// ------------------------------------------------------

function formatMinutes(
  seconds
) {

  if (
    !Number.isFinite(
      Number(
        seconds
      )
    )
  ) {

    return "N/A";

  }

  return Math.round(
    Number(
      seconds
    ) /
    60
  );

}

// ------------------------------------------------------

function estimatedMinutesOut(
  distance,
  plane
) {

  const speed =
    Number(
      plane.gs
    );

  if (
    !Number.isFinite(
      speed
    ) ||
    speed <
      30
  ) {

    return null;

  }

  return (
    distance /
    speed *
    60
  );

}

// ------------------------------------------------------

function flightTimeValue(
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

  const time =
    value
      ? new Date(
          value
        ).getTime()
      : 0;

  return Number.isFinite(
    time
  )
    ? time
    : 0;

}

// ======================================================
// EASTERN TIME
// ======================================================

function easternDateParts() {

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
    )
      .formatToParts(
        new Date()
      );

  const values =
    {};

  for (
    const part
    of parts
  ) {

    values[
      part.type
    ] =
      part.value;

  }

  return {

    dateKey:
      `${values.year}-${values.month}-${values.day}`,

    hour:
      Number(
        values.hour
      ),

    minute:
      Number(
        values.minute
      )

  };

}

// ------------------------------------------------------

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

// ======================================================
// WEATHER DISPLAY HELPERS
// ======================================================

function weatherEmoji(
  text = ""
) {

  const value =
    String(
      text
    ).toLowerCase();

  if (
    value.includes(
      "thunder"
    ) ||
    value.includes(
      "storm"
    )
  ) {

    return "⛈️";

  }

  if (
    value.includes(
      "rain"
    ) ||
    value.includes(
      "shower"
    )
  ) {

    return "🌧️";

  }

  if (
    value.includes(
      "cloud"
    ) ||
    value.includes(
      "overcast"
    )
  ) {

    return "☁️";

  }

  if (
    value.includes(
      "partly"
    ) ||
    value.includes(
      "mostly sunny"
    )
  ) {

    return "🌤️";

  }

  return "☀️";

}

// ------------------------------------------------------

function rampWeatherOutlook(
  dayForecast,
  nightForecast
) {

  const combined =
    [
      dayForecast?.shortForecast,
      dayForecast?.detailedForecast,
      nightForecast?.shortForecast,
      nightForecast?.detailedForecast
    ]
      .filter(
        Boolean
      )
      .join(
        " "
      )
      .toLowerCase();

  if (
    combined.includes(
      "thunder"
    ) ||
    combined.includes(
      "severe"
    )
  ) {

    return (
      "Thunderstorms are possible today. " +
      "Watch this channel for NWS warnings affecting FLL."
    );

  }

  if (
    combined.includes(
      "heavy rain"
    ) ||
    combined.includes(
      "showers"
    ) ||
    combined.includes(
      "rain"
    )
  ) {

    return (
      "Rain is possible around FLL today. " +
      "Expect potentially wet ramp conditions."
    );

  }

  if (
    combined.includes(
      "windy"
    ) ||
    combined.includes(
      "breezy"
    )
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

// ======================================================
// ADS-B
// ======================================================

async function getAircraft(
  radius
) {

  const url =
    `https://api.adsb.lol/v2/point/` +
    `${KFLL_LAT}/` +
    `${KFLL_LON}/` +
    `${radius}`;

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

    return (
      response.data
    );

  } catch (
    error
  ) {

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

        const destination =
          airportCode(
            flight.destination
          );

        const origin =
          airportCode(
            flight.origin
          );

        return (
          destination ===
            "FLL" ||
          destination ===
            "KFLL" ||
          origin ===
            "FLL" ||
          origin ===
            "KFLL"
        );

      }
    );

  const choices =
    fllFlights.length
      ? fllFlights
      : flights;

  choices.sort(
    (
      a,
      b
    ) =>
      Math.abs(
        flightTimeValue(
          a
        ) -
        now
      ) -
      Math.abs(
        flightTimeValue(
          b
        ) -
        now
      )
  );

  return (
    choices[0] ||
    null
  );

}

// ------------------------------------------------------

async function getKFLLFlights() {

  if (
    !FLIGHTAWARE_API_KEY
  ) {

    return null;

  }

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

  } catch (
    error
  ) {

    console.error(
      "❌ Discord webhook error:",
      error.response?.data ||
      error.message
    );

  }

}

// ======================================================
// ARRIVALS
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
// ADS-B DEPARTURE MEMORY
//
// ONLY used for return-to-FLL detection.
// It does NOT post into Operations.
// ======================================================

function rememberDepartureFromADSB(
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

// ======================================================
// OPERATIONS
//
// THIS IS THE IMPORTANT FIX.
//
// Operations now uses FlightAware's ACTUAL departures
// instead of depending on ADS-B takeoff detection.
// ======================================================

function getActualDepartureTime(
  flight
) {

  const value =
    flight.actual_off ||
    flight.actual_out;

  if (!value) {

    return 0;

  }

  const time =
    new Date(
      value
    ).getTime();

  return Number.isFinite(
    time
  )
    ? time
    : 0;

}

// ------------------------------------------------------

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
              origin ===
                "FLL" ||
              origin ===
                "KFLL"
            );

          }
        )

        .filter(
          flight =>
            getActualDepartureTime(
              flight
            ) >
            0
        )

        .sort(
          (
            a,
            b
          ) =>
            getActualDepartureTime(
              b
            ) -
            getActualDepartureTime(
              a
            )
        );

    if (
      !departures.length
    ) {

      console.log(
        "🔵 Operations: no actual JetBlue departures found yet"
      );

      return;

    }

    const latest =
      departures[0];

    const departureId =
      latest.fa_flight_id ||
      `${flightCallsign(
        latest
      )}-${getActualDepartureTime(
        latest
      )}`;

    if (
      lastOperationsDepartureId ===
      departureId
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

    const registration =
      clean(
        latest.registration
      );

    const aircraft =
      clean(
        latest.aircraft_type
      );

    const actualTime =
      latest.actual_off ||
      latest.actual_out;

    const message =
      `🛫 **LAST DEPARTURE — KFLL**\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `✈️ **Flight:** ${callsign}\n` +
      `📍 **Destination:** ${destination}\n` +
      `🛩️ **Aircraft:** ${aircraft}\n` +
      `🏷️ **Registration:** ${registration}\n` +
      `🛫 **Status:** DEPARTED\n` +
      `⏱️ **Takeoff:** ${formatTime(
        actualTime
      )}\n` +
      `━━━━━━━━━━━━━━━━━━━━`;

    await sendDiscord(
      OPERATIONS_WEBHOOK,
      message
    );

    console.log(
      `🔵 Operations updated: ${callsign}`
    );

  } catch (
    error
  ) {

    console.error(
      "❌ Operations departure error:",
      error.response?.data ||
      error.message
    );

  }

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
    distance <=
      1.5 &&
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

// ======================================================
// AIRCRAFT TRACKING
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

  const validForFLL =
    destination ===
      "FLL" ||
    destination ===
      "KFLL";

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

// ------------------------------------------------------

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
    type ===
      "20MIN"
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

  }

  else if (
    type ===
      "15MIN"
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

  }

  else {

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

// ------------------------------------------------------

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
      const plane
      of jetblue
    ) {

      if (
        plane.lat ===
          undefined ||
        plane.lon ===
          undefined
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
        altitude <=
          500 ||
        distance <=
          1.5
      ) {

        continue;

      }

      const callsign =
        clean(
          plane.flight
        )
          .toUpperCase();

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

      // 20 MIN OUT
      if (
        etaMinutes !==
          null &&
        etaMinutes <=
          21 &&
        etaMinutes >
          17
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

      // 15 MIN OUT
      if (
        etaMinutes !==
          null &&
        etaMinutes <=
          16 &&
        etaMinutes >
          12
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

      // ON APPROACH
      if (
        distance <=
          8 &&
        altitude >
          500 &&
        altitude <=
          5000
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

  } catch (
    error
  ) {

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
      ]
        .filter(
          isJetBlueFlight
        );

    const uniqueFlights =
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
          destination ===
            "FLL" ||
          destination ===
            "KFLL"
        ) &&
        arrivalDelay >=
          DELAY_THRESHOLD_SECONDS
      ) {

        const delayBucket =
          Math.floor(
            arrivalDelay /
            (
              15 *
              60
            )
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
            `🕒 **Estimated Arrival:** ${format
