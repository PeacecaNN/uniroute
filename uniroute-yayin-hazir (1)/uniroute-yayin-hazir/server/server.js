const express = require("express");
const cors = require("cors");
const csv = require("csv-parser");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const app = express();

function normalizeOrigin(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

const allowedOrigins = new Set(
  [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    ...String(process.env.FRONTEND_URLS || process.env.FRONTEND_URL || "")
      .split(",")
      .map(normalizeOrigin),
  ].filter(Boolean)
);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);

      const normalized = normalizeOrigin(origin);
      const allowVercelPreview =
        String(process.env.ALLOW_VERCEL_PREVIEWS || "").toLowerCase() === "true" &&
        /^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(normalized);

      if (allowedOrigins.has(normalized) || allowVercelPreview) {
        return callback(null, true);
      }

      return callback(new Error("CORS: Bu adresten erişime izin verilmiyor."));
    },
  })
);
app.use(express.json({ limit: "100kb" }));

const PORT = Number(process.env.PORT) || 3001;
const GOOGLE_MAPS_API_KEY = String(process.env.GOOGLE_MAPS_API_KEY || "").trim();
const ROUTES_API_URL = "https://routes.googleapis.com/directions/v2:computeRoutes";
const GEOCODING_API_URL = "https://maps.googleapis.com/maps/api/geocode/json";
const PLACES_AUTOCOMPLETE_API_URL =
  "https://places.googleapis.com/v1/places:autocomplete";
const PLACES_DETAILS_API_URL = "https://places.googleapis.com/v1/places";
const ROUTE_CACHE_TTL_MS = 10 * 60 * 1000;
const GEOCODE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

let programs = [];
const routeCache = new Map();
const geocodeCache = new Map();

function normalizeKey(value) {
  return String(value || "")
    .replace(/^\uFEFF/, "")
    .trim();
}

function normalizeRow(row) {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      normalizeKey(key),
      String(value ?? "").trim(),
    ])
  );
}

function normalizeAddress(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}


// Arama metnini Türkçe karakterlerden bağımsız ve çok kelimeli aramaya uygun hale getirir.
// Örnek: "İstanbul Aydın Bilgisayar" -> ["istanbul", "aydin", "bilgisayar"]
function normalizeSearchText(value) {
  return String(value || "")
    .toLocaleLowerCase("tr-TR")
    .replace(/ı/g, "i")
    .replace(/ğ/g, "g")
    .replace(/ü/g, "u")
    .replace(/ş/g, "s")
    .replace(/ö/g, "o")
    .replace(/ç/g, "c")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getProgramField(program, names) {
  const normalizedNames = names.map((name) => normalizeSearchText(name));
  const entry = Object.entries(program).find(([key]) =>
    normalizedNames.includes(normalizeSearchText(key))
  );
  return String(entry?.[1] || "").trim();
}

function scoreProgramSearch(program, normalizedQuery, terms) {
  const code = normalizeSearchText(findProgramCode(program));
  const university = normalizeSearchText(
    getProgramField(program, ["Üniversite İsmi", "Üniversite", "Universite"])
  );
  const programName = normalizeSearchText(
    getProgramField(program, ["Program İsmi", "Program", "Bölüm"])
  );
  const fullText = normalizeSearchText(Object.values(program).join(" "));

  // Her kelime aynı kaydın herhangi bir alanında bulunmalı.
  // Böylece "İstanbul Aydın bilgisayar" sorgusu üniversite ve bölüm alanlarını birlikte arar.
  if (!terms.every((term) => fullText.includes(term))) return -1;

  let score = 0;

  if (code === normalizedQuery) score += 2000;
  else if (code.includes(normalizedQuery)) score += 900;

  if (fullText.includes(normalizedQuery)) score += 350;
  if (university.includes(normalizedQuery)) score += 300;
  if (programName.includes(normalizedQuery)) score += 280;

  for (const term of terms) {
    if (university === term) score += 130;
    else if (university.startsWith(term)) score += 100;
    else if (university.includes(term)) score += 70;

    if (programName === term) score += 125;
    else if (programName.startsWith(term)) score += 95;
    else if (programName.includes(term)) score += 65;

    if (code === term) score += 500;
    else if (code.includes(term)) score += 180;
  }

  // Daha kısa ve doğrudan eşleşmeleri üstte tutar.
  score -= Math.min(fullText.length / 500, 20);
  return score;
}

function readTimedCache(cache, key, ttl) {
  const cached = cache.get(key);
  if (!cached) return null;

  if (Date.now() - cached.createdAt > ttl) {
    cache.delete(key);
    return null;
  }

  return cached.value;
}

function loadCSV() {
  programs = [];
  const filePath = path.join(__dirname, "data", "universite.csv");

  if (!fs.existsSync(filePath)) {
    console.error("❌ CSV bulunamadı:", filePath);
    return;
  }

  fs.createReadStream(filePath)
    .pipe(csv())
    .on("data", (row) => {
      const normalized = normalizeRow(row);
      if (Object.values(normalized).join("").trim()) {
        programs.push(normalized);
      }
    })
    .on("end", () => {
      console.log(`✅ ${programs.length} üniversite programı yüklendi.`);
      if (programs[0]) console.log("İlk kayıt:", programs[0]);
    })
    .on("error", (error) => {
      console.error("❌ CSV okunamadı:", error.message);
    });
}

function findProgramCode(program) {
  const named =
    program["Program Kodu"] || program.program_kodu || program.Kod || "";

  if (String(named).trim()) return String(named).trim();

  return (
    Object.values(program)
      .map((value) => String(value || "").trim())
      .find((value) => /^\d{8,12}$/.test(value)) || ""
  );
}

function cleanDestinationPart(value) {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();

  if (!text) return "";
  if (/bilgisi (bulunmuyor|yok)/i.test(text)) return "";
  return text;
}

function buildDestinationQuery({ university, faculty }) {
  const parts = [
    cleanDestinationPart(university),
    cleanDestinationPart(faculty),
    "Türkiye",
  ].filter(Boolean);

  return parts.join(", ");
}

function buildGoogleMapsUrl(origin, destinationQuery) {
  const originText = `${origin.lat},${origin.lng}`;
  return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(
    originText
  )}&destination=${encodeURIComponent(destinationQuery)}&travelmode=transit`;
}

function parseDurationSeconds(value) {
  const match = String(value || "").match(/^([\d.]+)s$/);
  return match ? Number(match[1]) : 0;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  const roundedMinutes = Math.max(1, Math.round(seconds / 60));
  const hours = Math.floor(roundedMinutes / 60);
  const minutes = roundedMinutes % 60;
  return hours ? `${hours} sa ${minutes} dk` : `${minutes} dk`;
}

function formatDistance(meters) {
  if (!Number.isFinite(meters) || meters <= 0) return "—";
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toLocaleString("tr-TR", {
    maximumFractionDigits: 1,
  })} km`;
}

function vehicleLabel(type, fallback) {
  const labels = {
    BUS: "Otobüs",
    INTERCITY_BUS: "Şehirlerarası otobüs",
    TROLLEYBUS: "Troleybüs",
    SUBWAY: "Metro",
    METRO_RAIL: "Raylı sistem",
    HEAVY_RAIL: "Tren",
    COMMUTER_TRAIN: "Banliyö",
    LONG_DISTANCE_TRAIN: "Uzun mesafe treni",
    HIGH_SPEED_TRAIN: "Hızlı tren",
    LIGHT_RAIL: "Tramvay",
    TRAM: "Tramvay",
    RAIL: "Raylı sistem",
    MONORAIL: "Monoray",
    FERRY: "Vapur",
    CABLE_CAR: "Teleferik",
    GONDOLA_LIFT: "Gondol",
    FUNICULAR: "Füniküler",
  };

  return labels[type] || fallback || "Toplu taşıma";
}

function isMetrobusTransitStep({ lineName, details, line }) {
  const stops = details?.stopDetails || {};
  const searchable = normalizeSearchText(
    [
      lineName,
      line?.name,
      line?.nameShort,
      line?.vehicle?.name?.text,
      details?.headsign,
      stops?.departureStop?.name,
      stops?.arrivalStop?.name,
      ...(Array.isArray(line?.agencies)
        ? line.agencies.map((agency) => agency?.name)
        : []),
    ]
      .filter(Boolean)
      .join(" ")
  );

  const compactLine = normalizeSearchText(lineName).replace(/\s+/g, "");

  // Google, İstanbul Metrobüsünü ayrı bir ulaşım modu yerine BUS olarak
  // döndürebiliyor. İETT Metrobüs hatlarının kısa adları 34 ile başlar.
  return (
    searchable.includes("metrobus") ||
    /^34(?:[a-z0-9-]*)$/i.test(compactLine)
  );
}

function parseTransitStep(step) {
  const details = step?.transitDetails;
  if (!details) return null;

  const line = details.transitLine || {};
  const stops = details.stopDetails || {};
  const type = String(line.vehicle?.type || "");
  const defaultVehicle = vehicleLabel(type, line.vehicle?.name?.text);
  const lineName = String(line.nameShort || line.name || defaultVehicle).trim();
  const isMetrobus = isMetrobusTransitStep({ lineName, details, line });

  return {
    mode: isMetrobus ? "METROBUS" : type || "TRANSIT",
    vehicle: isMetrobus ? "Metrobüs" : defaultVehicle,
    line: lineName,
    from: String(stops.departureStop?.name || "").trim(),
    to: String(stops.arrivalStop?.name || "").trim(),
    headsign: String(details.headsign || "").trim(),
    stopCount: Number.isFinite(details.stopCount) ? details.stopCount : null,
    departureTime: String(
      details.localizedValues?.departureTime?.time?.text || ""
    ).trim(),
    arrivalTime: String(
      details.localizedValues?.arrivalTime?.time?.text || ""
    ).trim(),
  };
}

function parseRouteResponse(route, destinationQuery, googleMapsUrl) {
  const legs = Array.isArray(route?.legs) ? route.legs : [];
  const steps = legs.flatMap((leg) => (Array.isArray(leg.steps) ? leg.steps : []));
  const transitSteps = steps.map(parseTransitStep).filter(Boolean);
  const walkingInstructions = steps
    .filter((step) => step?.travelMode === "WALK")
    .map((step) => String(step?.navigationInstruction?.instructions || "").trim())
    .filter(Boolean)
    .slice(0, 6);

  const uniqueLines = [];
  for (const step of transitSteps) {
    const label = `${step.vehicle} ${step.line}`.trim();
    if (label && !uniqueLines.includes(label)) uniqueLines.push(label);
  }

  const endLocation = legs.at(-1)?.endLocation?.latLng;
  const durationSeconds = parseDurationSeconds(route?.duration);
  const distanceMeters = Number(route?.distanceMeters || 0);

  return {
    configured: true,
    hasMetrobus: transitSteps.some((step) => step.mode === "METROBUS"),
    durationSeconds,
    distanceMeters,
    destinationQuery,
    destination:
      Number.isFinite(endLocation?.latitude) &&
      Number.isFinite(endLocation?.longitude)
        ? {
            lat: Number(endLocation.latitude),
            lng: Number(endLocation.longitude),
          }
        : null,
    distanceText:
      String(route?.localizedValues?.distance?.text || "").trim() ||
      formatDistance(distanceMeters),
    durationText:
      String(route?.localizedValues?.duration?.text || "").trim() ||
      formatDuration(durationSeconds),
    lineSummary:
      uniqueLines.join(" → ") ||
      (walkingInstructions.length ? "Yürüyüş ağırlıklı rota" : "Toplu taşıma rotası"),
    transitSteps,
    walkingInstructions,
    encodedPolyline: String(route?.polyline?.encodedPolyline || ""),
    googleMapsUrl,
  };
}

function routeFingerprint(route) {
  const lines = route.transitSteps
    .map((step) => `${step.mode}:${step.line}:${step.from}:${step.to}`)
    .join("|");

  return [
    lines,
    route.durationSeconds,
    route.distanceMeters,
    route.destinationQuery,
  ].join("::");
}

function buildRouteBundle(routes, destinationQuery, googleMapsUrl) {
  const unique = [];
  const seen = new Set();

  for (const rawRoute of routes) {
    const parsed = parseRouteResponse(rawRoute, destinationQuery, googleMapsUrl);
    const fingerprint = routeFingerprint(parsed);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    unique.push(parsed);
  }

  unique.sort((a, b) => {
    if (a.hasMetrobus !== b.hasMetrobus) return a.hasMetrobus ? -1 : 1;
    return a.durationSeconds - b.durationSeconds;
  });

  if (!unique.length) return null;

  const routeOptions = unique.slice(0, 6).map((route, index) => ({
    ...route,
    optionId: `route-${index + 1}-${route.hasMetrobus ? "metrobus" : "transit"}`,
    optionLabel: route.hasMetrobus
      ? `Metrobüs rotası · ${route.lineSummary}`
      : `${index === 0 ? "Önerilen rota" : "Alternatif rota"} · ${route.lineSummary}`,
  }));

  const selected = routeOptions.find((route) => route.hasMetrobus) || routeOptions[0];

  return {
    ...selected,
    routeOptions,
  };
}

async function requestGoogleTransitRoutes({
  origin,
  destinationQuery,
  routingPreference,
  signal,
}) {
  const response = await fetch(ROUTES_API_URL, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": GOOGLE_MAPS_API_KEY,
      "X-Goog-FieldMask": [
        "routes.routeLabels",
        "routes.distanceMeters",
        "routes.duration",
        "routes.localizedValues",
        "routes.polyline.encodedPolyline",
        "routes.legs.endLocation",
        "routes.legs.steps.travelMode",
        "routes.legs.steps.navigationInstruction.instructions",
        "routes.legs.steps.transitDetails",
      ].join(","),
    },
    body: JSON.stringify({
      origin: {
        location: {
          latLng: {
            latitude: origin.lat,
            longitude: origin.lng,
          },
        },
      },
      destination: {
        address: destinationQuery,
      },
      travelMode: "TRANSIT",
      computeAlternativeRoutes: true,
      languageCode: "tr",
      regionCode: "tr",
      units: "METRIC",
      transitPreferences: {
        routingPreference,
        allowedTravelModes: ["BUS", "SUBWAY", "TRAIN", "LIGHT_RAIL", "RAIL"],
      },
    }),
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(
      payload?.error?.message || "Google Routes API isteği başarısız oldu."
    );
    error.statusCode = response.status;
    throw error;
  }

  return Array.isArray(payload.routes) ? payload.routes : [];
}

function getCacheKey(origin, destinationQuery) {
  return [
    Number(origin.lat).toFixed(4),
    Number(origin.lng).toFixed(4),
    destinationQuery.toLocaleLowerCase("tr-TR"),
  ].join("|");
}

function readCachedRoute(key) {
  const cached = routeCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.createdAt > ROUTE_CACHE_TTL_MS) {
    routeCache.delete(key);
    return null;
  }
  return cached.value;
}

loadCSV();

app.get("/", (req, res) => {
  res.json({
    status: true,
    message: "Üniversite API Çalışıyor",
    total: programs.length,
    routesConfigured: Boolean(GOOGLE_MAPS_API_KEY),
    geocodingConfigured: Boolean(GOOGLE_MAPS_API_KEY),
    placesConfigured: Boolean(GOOGLE_MAPS_API_KEY),
  });
});

app.get("/api/search", (req, res) => {
  const normalizedQuery = normalizeSearchText(req.query.q);
  if (!normalizedQuery) return res.json([]);

  const terms = normalizedQuery.split(" ").filter(Boolean);

  const results = programs
    .map((program) => ({
      program,
      score: scoreProgramSearch(program, normalizedQuery, terms),
    }))
    .filter((result) => result.score >= 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return findProgramCode(a.program).localeCompare(findProgramCode(b.program));
    })
    .slice(0, 30)
    .map((result) => result.program);

  res.json(results);
});

app.get("/api/program/:code", (req, res) => {
  const code = String(req.params.code || "").trim();
  const result = programs.find((program) => findProgramCode(program) === code);

  if (!result) {
    return res.status(404).json({
      status: false,
      message: "Program bulunamadı.",
    });
  }

  res.json(result);
});

app.get("/api/programs", (req, res) => {
  res.json(programs);
});

app.get("/api/address-suggestions", async (req, res) => {
  const input = normalizeAddress(req.query.q);
  const latitude = Number(req.query.lat);
  const longitude = Number(req.query.lng);
  const sessionToken = normalizeAddress(req.query.sessionToken).slice(0, 128);

  if (input.length < 3) {
    return res.json({ status: true, suggestions: [] });
  }

  if (!GOOGLE_MAPS_API_KEY) {
    return res.status(503).json({
      status: false,
      message:
        "Adres seçenekleri için server/.env dosyasına GOOGLE_MAPS_API_KEY eklenmeli.",
    });
  }

  const body = {
    input,
    includedRegionCodes: ["tr"],
    languageCode: "tr",
    regionCode: "tr",
    includeQueryPredictions: false,
  };

  if (sessionToken) body.sessionToken = sessionToken;

  if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
    body.origin = {
      latitude,
      longitude,
    };
    body.locationBias = {
      circle: {
        center: {
          latitude,
          longitude,
        },
        radius: 50000,
      },
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(PLACES_AUTOCOMPLETE_API_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": GOOGLE_MAPS_API_KEY,
        "X-Goog-FieldMask": [
          "suggestions.placePrediction.placeId",
          "suggestions.placePrediction.text.text",
          "suggestions.placePrediction.structuredFormat.mainText.text",
          "suggestions.placePrediction.structuredFormat.secondaryText.text",
          "suggestions.placePrediction.distanceMeters",
        ].join(","),
      },
      body: JSON.stringify(body),
    });

    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      return res.status(response.status >= 500 ? 502 : response.status).json({
        status: false,
        message:
          payload?.error?.message ||
          "Google Places adres önerileri alınamadı.",
      });
    }

    const suggestions = (Array.isArray(payload.suggestions)
      ? payload.suggestions
      : []
    )
      .map((item) => item?.placePrediction)
      .filter(Boolean)
      .map((prediction) => ({
        placeId: String(prediction.placeId || "").trim(),
        text: String(prediction.text?.text || "").trim(),
        mainText: String(
          prediction.structuredFormat?.mainText?.text || ""
        ).trim(),
        secondaryText: String(
          prediction.structuredFormat?.secondaryText?.text || ""
        ).trim(),
        distanceMeters: Number.isFinite(prediction.distanceMeters)
          ? Number(prediction.distanceMeters)
          : null,
      }))
      .filter((suggestion) => suggestion.placeId && suggestion.text)
      .slice(0, 5);

    return res.json({ status: true, suggestions });
  } catch (error) {
    const isAbort = error?.name === "AbortError";
    return res.status(502).json({
      status: false,
      message: isAbort
        ? "Adres seçenekleri zaman aşımına uğradı. Tekrar dene."
        : "Adres seçenekleri servisine bağlanılamadı.",
    });
  } finally {
    clearTimeout(timeout);
  }
});

app.get("/api/place-details/:placeId", async (req, res) => {
  const placeId = normalizeAddress(req.params.placeId);
  const sessionToken = normalizeAddress(req.query.sessionToken).slice(0, 128);

  if (!placeId) {
    return res.status(400).json({
      status: false,
      message: "Geçerli bir adres seçeneği gönderilmedi.",
    });
  }

  if (!GOOGLE_MAPS_API_KEY) {
    return res.status(503).json({
      status: false,
      message:
        "Adres ayrıntıları için server/.env dosyasına GOOGLE_MAPS_API_KEY eklenmeli.",
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const url = new URL(
      `${PLACES_DETAILS_API_URL}/${encodeURIComponent(placeId)}`
    );
    url.searchParams.set("languageCode", "tr");
    url.searchParams.set("regionCode", "tr");
    if (sessionToken) url.searchParams.set("sessionToken", sessionToken);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": GOOGLE_MAPS_API_KEY,
        "X-Goog-FieldMask": "formattedAddress,location",
      },
    });

    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      return res.status(response.status >= 500 ? 502 : response.status).json({
        status: false,
        message:
          payload?.error?.message ||
          "Seçilen adresin ayrıntıları alınamadı.",
      });
    }

    const lat = Number(payload?.location?.latitude);
    const lng = Number(payload?.location?.longitude);

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(502).json({
        status: false,
        message: "Seçilen adresin koordinat bilgisi bulunamadı.",
      });
    }

    return res.json({
      status: true,
      formattedAddress: String(payload.formattedAddress || "").trim(),
      lat,
      lng,
    });
  } catch (error) {
    const isAbort = error?.name === "AbortError";
    return res.status(502).json({
      status: false,
      message: isAbort
        ? "Adres ayrıntısı isteği zaman aşımına uğradı. Tekrar dene."
        : "Adres ayrıntıları servisine bağlanılamadı.",
    });
  } finally {
    clearTimeout(timeout);
  }
});

app.get("/api/geocode", async (req, res) => {
  const address = normalizeAddress(req.query.address);

  if (address.length < 3) {
    return res.status(400).json({
      status: false,
      message: "Adres en az 3 karakter olmalı.",
    });
  }

  if (!GOOGLE_MAPS_API_KEY) {
    return res.status(503).json({
      status: false,
      message:
        "Adres araması için server/.env dosyasına GOOGLE_MAPS_API_KEY eklenmeli.",
    });
  }

  const cacheKey = address.toLocaleLowerCase("tr-TR");
  const cached = readTimedCache(geocodeCache, cacheKey, GEOCODE_CACHE_TTL_MS);
  if (cached) return res.json(cached);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const url = new URL(GEOCODING_API_URL);
    url.searchParams.set("address", address);
    url.searchParams.set("key", GOOGLE_MAPS_API_KEY);
    url.searchParams.set("language", "tr");
    url.searchParams.set("region", "tr");

    const response = await fetch(url, { signal: controller.signal });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok || payload.status !== "OK") {
      const apiMessage =
        payload.error_message ||
        (payload.status === "ZERO_RESULTS"
          ? "Bu adres için sonuç bulunamadı."
          : `Google Geocoding API hatası: ${payload.status || "Bilinmeyen hata"}`);

      return res.status(payload.status === "ZERO_RESULTS" ? 404 : 502).json({
        status: false,
        message: apiMessage,
      });
    }

    const result = Array.isArray(payload.results) ? payload.results[0] : null;
    const location = result?.geometry?.location;
    const lat = Number(location?.lat);
    const lng = Number(location?.lng);

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(502).json({
        status: false,
        message: "Adres bulundu ancak koordinat bilgisi alınamadı.",
      });
    }

    const value = {
      status: true,
      formattedAddress: String(result.formatted_address || address),
      lat,
      lng,
    };

    geocodeCache.set(cacheKey, { createdAt: Date.now(), value });
    return res.json(value);
  } catch (error) {
    const isAbort = error?.name === "AbortError";
    return res.status(502).json({
      status: false,
      message: isAbort
        ? "Adres araması zaman aşımına uğradı. Tekrar dene."
        : "Adres servisine bağlanılamadı.",
    });
  } finally {
    clearTimeout(timeout);
  }
});

app.post("/api/route", async (req, res) => {
  const origin = {
    lat: Number(req.body?.origin?.lat),
    lng: Number(req.body?.origin?.lng),
  };

  const destinationInput = req.body?.destination || {};
  const destinationQuery = buildDestinationQuery(destinationInput);

  if (!Number.isFinite(origin.lat) || !Number.isFinite(origin.lng)) {
    return res.status(400).json({
      status: false,
      message: "Başlangıç koordinatı geçersiz.",
    });
  }

  if (!destinationQuery || destinationQuery === "Türkiye") {
    return res.status(400).json({
      status: false,
      message: "Üniversite veya kampüs bilgisi bulunamadı.",
    });
  }

  const googleMapsUrl = buildGoogleMapsUrl(origin, destinationQuery);

  if (!GOOGLE_MAPS_API_KEY) {
    return res.json({
      configured: false,
      message:
        "Gerçek toplu taşıma hatlarını göstermek için server/.env dosyasına GOOGLE_MAPS_API_KEY eklenmeli.",
      destinationQuery,
      destination: null,
      distanceText: "—",
      durationText: "—",
      lineSummary: "Google Maps'te rotayı aç",
      transitSteps: [],
      walkingInstructions: [],
      encodedPolyline: "",
      googleMapsUrl,
    });
  }

  const cacheKey = getCacheKey(origin, destinationQuery);
  const cached = readCachedRoute(cacheKey);
  if (cached) return res.json(cached);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);

  try {
    let rawRoutes = await requestGoogleTransitRoutes({
      origin,
      destinationQuery,
      routingPreference: "LESS_WALKING",
      signal: controller.signal,
    });

    let bundle = buildRouteBundle(rawRoutes, destinationQuery, googleMapsUrl);

    // İlk sonuçlarda Metrobüs yoksa daha az aktarmalı rotaları da ayrıca sor.
    // Bu, Google'ın BUS olarak sınıflandırdığı 34/34A/34AS gibi Metrobüs
    // alternatiflerinin bulunma ihtimalini artırır.
    if (
      !bundle ||
      !bundle.routeOptions.some((route) => route.hasMetrobus)
    ) {
      const fewerTransfersRoutes = await requestGoogleTransitRoutes({
        origin,
        destinationQuery,
        routingPreference: "FEWER_TRANSFERS",
        signal: controller.signal,
      });
      rawRoutes = [...rawRoutes, ...fewerTransfersRoutes];
      bundle = buildRouteBundle(rawRoutes, destinationQuery, googleMapsUrl);
    }

    if (!bundle) {
      return res.status(404).json({
        status: false,
        message: "Bu başlangıç noktası ile kampüs arasında toplu taşıma rotası bulunamadı.",
        googleMapsUrl,
      });
    }

    routeCache.set(cacheKey, { createdAt: Date.now(), value: bundle });
    return res.json(bundle);
  } catch (error) {
    const isAbort = error?.name === "AbortError";
    const statusCode = Number(error?.statusCode);
    return res.status(
      Number.isFinite(statusCode) && statusCode >= 400 && statusCode < 500
        ? statusCode
        : 502
    ).json({
      status: false,
      message: isAbort
        ? "Rota servisi zaman aşımına uğradı. Tekrar dene."
        : error?.message || "Rota servisine bağlanılamadı.",
      googleMapsUrl,
    });
  } finally {
    clearTimeout(timeout);
  }
});

app.use((error, req, res, next) => {
  console.error("Sunucu hatası:", error);
  res.status(500).json({ status: false, message: "Beklenmeyen sunucu hatası." });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("--------------------------------");
  console.log("🚀 SERVER BAŞLADI");
  console.log(`http://localhost:${PORT}`);
  console.log(
    GOOGLE_MAPS_API_KEY
      ? "✅ Google Maps API anahtarı bulundu. Routes API ve Geocoding API etkin olmalı."
      : "⚠️ GOOGLE_MAPS_API_KEY eksik; rota ve adres araması sınırlı çalışacak."
  );
  console.log("--------------------------------");
});
