"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  Map as LeafletMap,
  Marker as LeafletMarker,
  Polyline as LeafletPolyline,
} from "leaflet";

type ApiProgram = Record<string, string | undefined>;

type TransitStep = {
  mode: string;
  vehicle: string;
  line: string;
  from: string;
  to: string;
  headsign: string;
  stopCount: number | null;
  departureTime: string;
  arrivalTime: string;
};

type RouteBase = {
  configured: boolean;
  message?: string;
  hasMetrobus?: boolean;
  durationSeconds?: number;
  distanceMeters?: number;
  destinationQuery: string;
  destination: { lat: number; lng: number } | null;
  distanceText: string;
  durationText: string;
  lineSummary: string;
  transitSteps: TransitStep[];
  walkingInstructions: string[];
  encodedPolyline: string;
  googleMapsUrl: string;
};

type RouteOption = RouteBase & {
  optionId: string;
  optionLabel: string;
};

type RouteInfo = RouteBase & {
  optionId?: string;
  optionLabel?: string;
  routeOptions?: RouteOption[];
};

type RouteStatus = "idle" | "loading" | "ready" | "error";

type Preference = {
  id: string;
  code: string;
  university: string;
  faculty: string;
  program: string;
  rank: string;
  score: string;
  selected: boolean;
  originalOrder: number;
  routeStatus: RouteStatus;
  route?: RouteInfo;
  routeError?: string;
  fallbackMapsUrl?: string;
};

type Origin = {
  lat: number;
  lng: number;
  label: string;
};

type GeocodeResponse = {
  status: boolean;
  formattedAddress?: string;
  lat?: number;
  lng?: number;
  message?: string;
};

type AddressSuggestion = {
  placeId: string;
  text: string;
  mainText: string;
  secondaryText: string;
  distanceMeters: number | null;
};

type AddressSuggestionsResponse = {
  status: boolean;
  suggestions?: AddressSuggestion[];
  message?: string;
};

const API_ORIGIN = (
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001"
).replace(/\/+$/, "");

const API_BASE = `${API_ORIGIN}/api`;
const DEFAULT_ORIGIN: Origin = {
  lat: 40.9961,
  lng: 28.7909,
  label: "Sefaköy / İstanbul",
};

function cleanKey(value: string) {
  return value.replace(/^\uFEFF/, "").trim().toLocaleLowerCase("tr-TR");
}

function getField(item: ApiProgram, names: string[]) {
  const wanted = names.map(cleanKey);
  const entry = Object.entries(item).find(([key]) => wanted.includes(cleanKey(key)));
  return String(entry?.[1] ?? "").trim();
}

function findProgramCode(item: ApiProgram) {
  const namedCode = getField(item, ["Program Kodu", "program_kodu", "Kod"]);
  if (namedCode) return namedCode;

  return (
    Object.values(item)
      .map((value) => String(value ?? "").trim())
      .find((value) => /^\d{8,12}$/.test(value)) ?? ""
  );
}

function normalizeProgram(item: ApiProgram, order: number): Preference {
  const code = findProgramCode(item);
  const university = getField(item, [
    "Üniversite İsmi",
    "Üniversite",
    "Universite",
    "University",
  ]);
  const rawProgram = getField(item, ["Program İsmi", "Program", "Bölüm"]);
  const lines = rawProgram
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const faculty =
    getField(item, ["Fakülte", "Fakülte İsmi", "Faculty"]) ||
    (lines.length > 1 ? lines[0] : "Fakülte bilgisi bulunmuyor");

  const program =
    lines.length > 1 ? lines.slice(1).join(" · ") : rawProgram || "Program bilgisi yok";

  return {
    id: `${code || "program"}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`,
    code: code || "Kod yok",
    university: university || "Üniversite bilgisi yok",
    faculty,
    program,
    rank: getField(item, ["Başarı Sırası", "Sıralama", "Başarı Sirasi"]) || "—",
    score: getField(item, ["Başarı Puanı", "Taban Puan", "Puan"]) || "—",
    selected: false,
    originalOrder: order,
    routeStatus: "idle",
  };
}

function decodePolyline(encoded: string): [number, number][] {
  const points: [number, number][] = [];
  let index = 0;
  let latitude = 0;
  let longitude = 0;

  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let byte: number;

    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index < encoded.length);

    latitude += result & 1 ? ~(result >> 1) : result >> 1;
    result = 0;
    shift = 0;

    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index < encoded.length);

    longitude += result & 1 ? ~(result >> 1) : result >> 1;
    points.push([latitude / 1e5, longitude / 1e5]);
  }

  return points;
}

function routeModeIcon(vehicle: string) {
  if (/metrobüs|metrobus/i.test(vehicle)) return "🚍";
  if (/metro|tramvay|raylı|tren|banliyö/i.test(vehicle)) return "🚇";
  if (/vapur|feribot/i.test(vehicle)) return "⛴️";
  return "🚌";
}

export default function Home() {
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<ApiProgram[]>([]);
  const [preferences, setPreferences] = useState<Preference[]>([]);
  const [origin, setOrigin] = useState<Origin>(DEFAULT_ORIGIN);
  const [addressQuery, setAddressQuery] = useState(DEFAULT_ORIGIN.label);
  const [addressSuggestions, setAddressSuggestions] = useState<AddressSuggestion[]>([]);
  const [activeAddressSuggestion, setActiveAddressSuggestion] = useState(-1);
  const [addressSuggestionsLoading, setAddressSuggestionsLoading] = useState(false);
  const [geocoding, setGeocoding] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [activeRouteId, setActiveRouteId] = useState<string | null>(null);

  const mapElementRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const markerRef = useRef<LeafletMarker | null>(null);
  const destinationMarkerRef = useRef<LeafletMarker | null>(null);
  const routePolylineRef = useRef<LeafletPolyline | null>(null);
  const leafletRef = useRef<typeof import("leaflet") | null>(null);
  const addressSessionTokenRef = useRef("");
  const skipNextAddressAutocompleteRef = useRef(false);

  const selectedCount = useMemo(
    () => preferences.filter((item) => item.selected).length,
    [preferences]
  );

  const activePreference = useMemo(
    () => preferences.find((item) => item.id === activeRouteId) ?? null,
    [activeRouteId, preferences]
  );

  function getAddressSessionToken() {
    if (!addressSessionTokenRef.current) {
      addressSessionTokenRef.current =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }

    return addressSessionTokenRef.current;
  }

  function clearRouteLayers() {
    destinationMarkerRef.current?.remove();
    routePolylineRef.current?.remove();
    destinationMarkerRef.current = null;
    routePolylineRef.current = null;
  }

  function invalidateRoutes() {
    setPreferences((current) =>
      current.map((item) => ({
        ...item,
        routeStatus: "idle",
        route: undefined,
        routeError: undefined,
        fallbackMapsUrl: undefined,
      }))
    );
    setActiveRouteId(null);
    clearRouteLayers();
  }

  function showRouteOnMap(route: RouteInfo) {
    const L = leafletRef.current;
    const map = mapRef.current;
    if (!L || !map) return;

    clearRouteLayers();

    const destinationIcon = L.divIcon({
      className: "destination-pin-wrapper",
      html: '<span class="destination-pin" aria-hidden="true">🎓</span>',
      iconSize: [36, 36],
      iconAnchor: [18, 34],
    });

    if (route.destination) {
      destinationMarkerRef.current = L.marker(
        [route.destination.lat, route.destination.lng],
        { icon: destinationIcon }
      ).addTo(map);
    }

    const points = route.encodedPolyline
      ? decodePolyline(route.encodedPolyline)
      : [];

    if (points.length > 1) {
      const polyline = L.polyline(points, {
        weight: 5,
        opacity: 0.85,
      }).addTo(map);
      routePolylineRef.current = polyline;
      map.fitBounds(polyline.getBounds(), { padding: [28, 28] });
      return;
    }

    if (route.destination) {
      const bounds = L.latLngBounds([
        [origin.lat, origin.lng],
        [route.destination.lat, route.destination.lng],
      ]);
      map.fitBounds(bounds, { padding: [28, 28] });
    }
  }

  useEffect(() => {
    let disposed = false;

    async function createMap() {
      const L = await import("leaflet");
      if (disposed || !mapElementRef.current || mapRef.current) return;

      leafletRef.current = L;
      const map = L.map(mapElementRef.current).setView(
        [DEFAULT_ORIGIN.lat, DEFAULT_ORIGIN.lng],
        12
      );

      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "© OpenStreetMap contributors",
        maxZoom: 19,
      }).addTo(map);

      const pinIcon = L.divIcon({
        className: "map-pin-wrapper",
        html: '<span class="map-pin" aria-hidden="true"></span>',
        iconSize: [32, 38],
        iconAnchor: [16, 36],
      });

      const marker = L.marker([DEFAULT_ORIGIN.lat, DEFAULT_ORIGIN.lng], {
        draggable: true,
        icon: pinIcon,
      }).addTo(map);

      function updateLocation(lat: number, lng: number) {
        marker.setLatLng([lat, lng]);
        const label = `Seçilen konum (${lat.toFixed(4)}, ${lng.toFixed(4)})`;
        setOrigin({ lat, lng, label });
        skipNextAddressAutocompleteRef.current = true;
        setAddressQuery(label);
        setAddressSuggestions([]);
        setActiveAddressSuggestion(-1);
        addressSessionTokenRef.current = "";
        setPreferences((current) =>
          current.map((item) => ({
            ...item,
            routeStatus: "idle",
            route: undefined,
            routeError: undefined,
            fallbackMapsUrl: undefined,
          }))
        );
        setActiveRouteId(null);
        destinationMarkerRef.current?.remove();
        routePolylineRef.current?.remove();
        destinationMarkerRef.current = null;
        routePolylineRef.current = null;
        setMessage("Başlangıç konumu değişti. Rotaları yeniden hesapla.");
      }

      marker.on("dragend", () => {
        const point = marker.getLatLng();
        updateLocation(point.lat, point.lng);
      });

      map.on("click", (event) => {
        updateLocation(event.latlng.lat, event.latlng.lng);
      });

      mapRef.current = map;
      markerRef.current = marker;
    }

    void createMap();

    return () => {
      disposed = true;
      mapRef.current?.remove();
      mapRef.current = null;
      markerRef.current = null;
      destinationMarkerRef.current = null;
      routePolylineRef.current = null;
      leafletRef.current = null;
    };
  }, []);

  useEffect(() => {
    const trimmed = addressQuery.trim();

    if (skipNextAddressAutocompleteRef.current) {
      skipNextAddressAutocompleteRef.current = false;
      setAddressSuggestions([]);
      setActiveAddressSuggestion(-1);
      return;
    }

    if (trimmed.length < 3) {
      setAddressSuggestions([]);
      setActiveAddressSuggestion(-1);
      setAddressSuggestionsLoading(false);
      return;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setAddressSuggestionsLoading(true);

      try {
        const params = new URLSearchParams({
          q: trimmed,
          lat: String(origin.lat),
          lng: String(origin.lng),
          sessionToken: getAddressSessionToken(),
        });

        const response = await fetch(`${API_BASE}/address-suggestions?${params}`, {
          signal: controller.signal,
        });
        const data = (await response.json()) as AddressSuggestionsResponse;

        if (!response.ok || !data.status) {
          throw new Error(data.message || "Adres önerileri alınamadı.");
        }

        const nextSuggestions = Array.isArray(data.suggestions)
          ? data.suggestions
          : [];

        setAddressSuggestions(nextSuggestions);
        setActiveAddressSuggestion(nextSuggestions.length ? 0 : -1);
      } catch (error) {
        if ((error as Error).name !== "AbortError") {
          setAddressSuggestions([]);
          setActiveAddressSuggestion(-1);
          setMessage(
            error instanceof Error
              ? error.message
              : "Adres önerileri alınamadı."
          );
        }
      } finally {
        if (!controller.signal.aborted) setAddressSuggestionsLoading(false);
      }
    }, 280);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [addressQuery, origin.lat, origin.lng]);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setSuggestions([]);
      return;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(
          `${API_BASE}/search?q=${encodeURIComponent(trimmed)}`,
          { signal: controller.signal }
        );

        if (!response.ok) throw new Error("Arama isteği başarısız oldu.");
        const data = (await response.json()) as ApiProgram[];
        setSuggestions(Array.isArray(data) ? data.slice(0, 8) : []);
      } catch (error) {
        if ((error as Error).name !== "AbortError") {
          setMessage("Sunucuya bağlanılamadı. Server açık mı kontrol et.");
        }
      }
    }, 250);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  async function calculateRoute(
    preference: Preference,
    selectedOrigin: Origin = origin
  ): Promise<RouteInfo | null> {
    setPreferences((current) =>
      current.map((item) =>
        item.id === preference.id
          ? {
              ...item,
              routeStatus: "loading",
              routeError: undefined,
              fallbackMapsUrl: undefined,
            }
          : item
      )
    );

    try {
      const response = await fetch(`${API_BASE}/route`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          origin: { lat: selectedOrigin.lat, lng: selectedOrigin.lng },
          destination: {
            code: preference.code,
            university: preference.university,
            faculty: preference.faculty,
            program: preference.program,
          },
        }),
      });

      const data = (await response.json()) as RouteInfo & {
        status?: boolean;
        message?: string;
        googleMapsUrl?: string;
      };

      if (!response.ok) {
        throw Object.assign(new Error(data.message || "Rota hesaplanamadı."), {
          googleMapsUrl: data.googleMapsUrl,
        });
      }

      setPreferences((current) =>
        current.map((item) =>
          item.id === preference.id
            ? { ...item, routeStatus: "ready", route: data, routeError: undefined }
            : item
        )
      );
      setActiveRouteId(preference.id);
      showRouteOnMap(data);
      return data;
    } catch (error) {
      const routeError = error as Error & { googleMapsUrl?: string };
      setPreferences((current) =>
        current.map((item) =>
          item.id === preference.id
            ? {
                ...item,
                routeStatus: "error",
                routeError: routeError.message || "Rota hesaplanamadı.",
                fallbackMapsUrl: routeError.googleMapsUrl,
              }
            : item
        )
      );
      return null;
    }
  }

  function selectRouteOption(preferenceId: string, option: RouteOption) {
    const preference = preferences.find((item) => item.id === preferenceId);
    const routeOptions = preference?.route?.routeOptions ?? [];
    const nextRoute: RouteInfo = { ...option, routeOptions };

    setPreferences((current) =>
      current.map((item) =>
        item.id === preferenceId
          ? {
              ...item,
              routeStatus: "ready",
              route: nextRoute,
              routeError: undefined,
            }
          : item
      )
    );

    setActiveRouteId(preferenceId);
    showRouteOnMap(nextRoute);
    setMessage(
      option.hasMetrobus
        ? "Metrobüs rotası açıldı."
        : "Seçilen toplu taşıma rotası açıldı."
    );
  }

  async function addProgram(item: ApiProgram) {
    const normalized = normalizeProgram(item, preferences.length + 1);

    if (
      normalized.code !== "Kod yok" &&
      preferences.some((program) => program.code === normalized.code)
    ) {
      setMessage("Bu program tercih listesinde zaten bulunuyor.");
      return;
    }

    setPreferences((current) => [...current, normalized]);
    setQuery("");
    setSuggestions([]);
    setMessage("Program eklendi, kampüs rotası hesaplanıyor...");

    const route = await calculateRoute(normalized);
    if (!route) {
      setMessage("Program eklendi ancak rota hesaplanamadı. Satırdan tekrar deneyebilirsin.");
    } else if (!route.configured) {
      setMessage("Program eklendi. Gerçek hatlar için server .env dosyasına API anahtarı ekle.");
    } else {
      setMessage("Program ve toplu taşıma rotası eklendi.");
    }
  }

  async function addByCode() {
    const code = query.trim();
    if (!code) {
      setMessage("Bir program kodu veya bölüm adı yaz.");
      return;
    }

    const exactSuggestion = suggestions.find(
      (item) => findProgramCode(item) === code
    );

    if (exactSuggestion) {
      await addProgram(exactSuggestion);
      return;
    }

    setLoading(true);
    setMessage("");

    try {
      const response = await fetch(`${API_BASE}/program/${encodeURIComponent(code)}`);
      if (!response.ok) throw new Error("Program bulunamadı.");
      const data = (await response.json()) as ApiProgram;
      await addProgram(data);
    } catch {
      setMessage("Program bulunamadı. Açılan önerilerden birini seçebilirsin.");
    } finally {
      setLoading(false);
    }
  }

  async function selectAddressSuggestion(suggestion: AddressSuggestion) {
    setGeocoding(true);
    setAddressSuggestions([]);
    setActiveAddressSuggestion(-1);
    setMessage("Seçilen adres haritada açılıyor...");

    try {
      const sessionToken = getAddressSessionToken();
      const params = new URLSearchParams({ sessionToken });
      const response = await fetch(
        `${API_BASE}/place-details/${encodeURIComponent(
          suggestion.placeId
        )}?${params}`
      );
      const data = (await response.json()) as GeocodeResponse;

      if (
        !response.ok ||
        !data.status ||
        !Number.isFinite(data.lat) ||
        !Number.isFinite(data.lng)
      ) {
        throw new Error(data.message || "Seçilen adres açılamadı.");
      }

      const lat = Number(data.lat);
      const lng = Number(data.lng);
      const label = data.formattedAddress || suggestion.text;

      setOrigin({ lat, lng, label });
      skipNextAddressAutocompleteRef.current = true;
      setAddressQuery(label);
      markerRef.current?.setLatLng([lat, lng]);
      mapRef.current?.setView([lat, lng], 16);
      invalidateRoutes();
      addressSessionTokenRef.current = "";
      setMessage("Başlangıç adresi seçildi. Rotaları yeniden hesapla.");
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Seçilen adres açılırken bir hata oluştu."
      );
    } finally {
      setGeocoding(false);
    }
  }

  async function searchAddress() {
    if (addressSuggestions.length > 0) {
      const index =
        activeAddressSuggestion >= 0 ? activeAddressSuggestion : 0;
      await selectAddressSuggestion(addressSuggestions[index]);
      return;
    }

    const address = addressQuery.trim();

    if (address.length < 3) {
      setMessage("Başlangıç adresini en az 3 karakter olarak yaz.");
      return;
    }

    setGeocoding(true);
    setMessage("Adres haritada aranıyor...");

    try {
      const response = await fetch(
        `${API_BASE}/geocode?address=${encodeURIComponent(address)}`
      );
      const data = (await response.json()) as GeocodeResponse;

      if (
        !response.ok ||
        !data.status ||
        !Number.isFinite(data.lat) ||
        !Number.isFinite(data.lng)
      ) {
        throw new Error(data.message || "Adres bulunamadı.");
      }

      const lat = Number(data.lat);
      const lng = Number(data.lng);
      const label = data.formattedAddress || address;

      setOrigin({ lat, lng, label });
      skipNextAddressAutocompleteRef.current = true;
      setAddressQuery(label);
      setAddressSuggestions([]);
      setActiveAddressSuggestion(-1);
      addressSessionTokenRef.current = "";
      markerRef.current?.setLatLng([lat, lng]);
      mapRef.current?.setView([lat, lng], 15);
      invalidateRoutes();
      setMessage("Başlangıç adresi güncellendi. Rotaları yeniden hesapla.");
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Adres aranırken bir hata oluştu."
      );
    } finally {
      setGeocoding(false);
    }
  }

  function useMyLocation() {
    if (!navigator.geolocation) {
      setMessage("Tarayıcın konum özelliğini desteklemiyor.");
      return;
    }

    setMessage("Konum alınıyor...");
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        const lat = coords.latitude;
        const lng = coords.longitude;

        setOrigin({ lat, lng, label: "Mevcut konumum" });
        skipNextAddressAutocompleteRef.current = true;
        setAddressQuery("Mevcut konumum");
        setAddressSuggestions([]);
        setActiveAddressSuggestion(-1);
        addressSessionTokenRef.current = "";
        markerRef.current?.setLatLng([lat, lng]);
        mapRef.current?.setView([lat, lng], 14);
        invalidateRoutes();
        setMessage("Konum güncellendi. Rotaları yeniden hesapla.");
      },
      () => setMessage("Konum izni verilmedi veya konum alınamadı."),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }

  async function activatePreference(preference: Preference) {
    setActiveRouteId(preference.id);

    if (preference.routeStatus === "ready" && preference.route) {
      showRouteOnMap(preference.route);
      setMessage(`${preference.university} kampüs detayları açıldı.`);
      return;
    }

    if (preference.routeStatus === "loading") {
      setMessage(`${preference.university} rotası hesaplanıyor...`);
      return;
    }

    setMessage(`${preference.university} kampüs rotası hesaplanıyor...`);
    const route = await calculateRoute(preference);

    if (!route) {
      setMessage(`${preference.university} için rota hesaplanamadı.`);
    } else {
      setMessage(`${preference.university} kampüs detayları açıldı.`);
    }
  }

  function toggleSelected(id: string) {
    setPreferences((current) => {
      const target = current.find((item) => item.id === id);
      if (!target) return current;

      if (!target.selected && current.filter((item) => item.selected).length >= 24) {
        setMessage("En fazla 24 tercih seçebilirsin.");
        return current;
      }

      return current.map((item) =>
        item.id === id ? { ...item, selected: !item.selected } : item
      );
    });
  }

  function movePreference(id: string, requestedRank: number) {
    setPreferences((current) => {
      const sourceIndex = current.findIndex((item) => item.id === id);
      if (sourceIndex < 0) return current;

      const destinationIndex = Math.max(
        0,
        Math.min(current.length - 1, requestedRank - 1)
      );

      const copy = [...current];
      const [moved] = copy.splice(sourceIndex, 1);
      copy.splice(destinationIndex, 0, moved);
      return copy;
    });
  }

  function removePreference(id: string) {
    setPreferences((current) => current.filter((item) => item.id !== id));
    if (activeRouteId === id) {
      setActiveRouteId(null);
      clearRouteLayers();
    }
  }

  function resetOrder() {
    setPreferences((current) =>
      [...current].sort((a, b) => a.originalOrder - b.originalOrder)
    );
  }

  async function refreshAllRoutes() {
    if (!preferences.length) {
      setMessage("Önce tercih listesine program ekle.");
      return;
    }

    setMessage("Tüm kampüs rotaları hesaplanıyor...");
    await Promise.all(preferences.map((item) => calculateRoute(item)));
    setMessage("Rota yenileme işlemi tamamlandı.");
  }

  function printSelected() {
    if (selectedCount === 0) {
      setMessage("Yazdırmadan önce en az bir tercih seç.");
      return;
    }
    window.print();
  }

  return (
    <main className="site-shell">
      <div className="container">
        <section className="control-panel no-print">
          <div className="panel-group">
            <div className="label-row">
              <label>📍 Haritadan başlangıç konumunu seç</label>
              <button type="button" className="location-button" onClick={useMyLocation}>
                Konumumu kullan
              </button>
            </div>
            <div ref={mapElementRef} className="map" aria-label="Başlangıç ve kampüs rotası haritası" />
          </div>

          <div className="panel-row">
            <div className="panel-group location-field">
              <label>📍 Başlangıç adresi</label>
              <div className="location-entry">
                <div className="address-search-wrap">
                  <input
                    className="panel-input"
                    value={addressQuery}
                    placeholder="Örn: Halkalı Merkez Mahallesi, Küçükçekmece"
                    autoComplete="off"
                    aria-autocomplete="list"
                    aria-expanded={
                      addressSuggestionsLoading || addressSuggestions.length > 0
                    }
                    onChange={(event) => {
                      setAddressQuery(event.target.value);
                      setAddressSuggestions([]);
                      setActiveAddressSuggestion(-1);
                      setMessage("");
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "ArrowDown" && addressSuggestions.length) {
                        event.preventDefault();
                        setActiveAddressSuggestion((current) =>
                          Math.min(current + 1, addressSuggestions.length - 1)
                        );
                        return;
                      }

                      if (event.key === "ArrowUp" && addressSuggestions.length) {
                        event.preventDefault();
                        setActiveAddressSuggestion((current) =>
                          Math.max(current - 1, 0)
                        );
                        return;
                      }

                      if (event.key === "Escape") {
                        setAddressSuggestions([]);
                        setActiveAddressSuggestion(-1);
                        return;
                      }

                      if (event.key === "Enter") {
                        event.preventDefault();
                        void searchAddress();
                      }
                    }}
                  />

                  {(addressSuggestionsLoading ||
                    addressSuggestions.length > 0) && (
                    <div className="suggestions address-suggestions" role="listbox">
                      {addressSuggestionsLoading &&
                        addressSuggestions.length === 0 && (
                          <div className="address-suggestion-loading">
                            Adres seçenekleri aranıyor...
                          </div>
                        )}

                      {addressSuggestions.map((suggestion, index) => (
                        <button
                          type="button"
                          role="option"
                          aria-selected={index === activeAddressSuggestion}
                          className={`suggestion-item address-suggestion-item${
                            index === activeAddressSuggestion ? " is-active" : ""
                          }`}
                          key={suggestion.placeId}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => void selectAddressSuggestion(suggestion)}
                        >
                          <span className="address-suggestion-icon">📍</span>
                          <span className="address-suggestion-copy">
                            <strong>
                              {suggestion.mainText || suggestion.text}
                            </strong>
                            <small>
                              {suggestion.secondaryText ||
                                suggestion.text}
                            </small>
                          </span>
                          {suggestion.distanceMeters !== null && (
                            <span className="address-suggestion-distance">
                              {suggestion.distanceMeters < 1000
                                ? `${Math.round(suggestion.distanceMeters)} m`
                                : `${(
                                    suggestion.distanceMeters / 1000
                                  ).toLocaleString("tr-TR", {
                                    maximumFractionDigits: 1,
                                  })} km`}
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <button
                  type="button"
                  className="location-button address-search-button"
                  onClick={() => void searchAddress()}
                  disabled={geocoding || addressSuggestionsLoading}
                >
                  {geocoding ? "Açılıyor..." : "Adresi seç"}
                </button>
              </div>
              <small className="location-current-label">
                Aktif konum: {origin.label}
              </small>
            </div>

            <div className="panel-group search-group">
              <label>🔗 Üniversite, program kodu veya bölüm</label>
              <div className="search-wrap">
                <input
                  className="panel-input"
                  value={query}
                  placeholder="Örn: İstanbul Aydın bilgisayar"
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setMessage("");
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void addByCode();
                  }}
                />

                {suggestions.length > 0 && (
                  <div className="suggestions">
                    {suggestions.map((item, index) => {
                      const preview = normalizeProgram(item, index + 1);
                      return (
                        <button
                          type="button"
                          className="suggestion-item"
                          key={`${preview.code}-${index}`}
                          onClick={() => void addProgram(item)}
                        >
                          <strong>{preview.code}</strong>
                          <span>{preview.university}</span>
                          <small>{preview.program}</small>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            <button
              type="button"
              className="btn-add"
              onClick={() => void addByCode()}
              disabled={loading}
            >
              {loading ? "Ekleniyor..." : "+ Bölümü çek ve ekle"}
            </button>
          </div>

          {message && <p className="status-message">{message}</p>}
        </section>

        <div className="action-bar no-print">
          <button type="button" className="btn btn-reset" onClick={resetOrder}>
            Sıralamayı sıfırla
          </button>
          <button type="button" className="btn btn-route" onClick={() => void refreshAllRoutes()}>
            Tüm rotaları yenile
          </button>
          <button type="button" className="btn" onClick={printSelected}>
            A4 PDF / Yazdır
          </button>
        </div>

        <header className="header">
          <div>
            <h1>YKS Tercih Listesi ve Ulaşım Rehberi</h1>
            <p>Program bilgileri, tercih sıralaması ve gerçek toplu taşıma rotası</p>
          </div>
          <div className="stats-badge">{selectedCount} / 24 Seçildi</div>
        </header>

        <div className="table-frame">
          <table id="preferenceTable" className="preference-table">
            <thead>
              <tr>
                <th className="select-column">Seç</th>
                <th>Sıra</th>
                <th>Kod</th>
                <th>Üniversite & Fakülte</th>
                <th>Program</th>
                <th>Sıra / Puan</th>
                <th>Ulaşım</th>
                <th className="delete-column no-print">Sil</th>
              </tr>
            </thead>
            <tbody>
              {preferences.length === 0 ? (
                <tr className="empty-row">
                  <td colSpan={8}>
                    Program kodunu aratıp tercih listene ilk bölümünü ekle.
                  </td>
                </tr>
              ) : (
                preferences.map((item, index) => (
                  <tr
                    key={item.id}
                    className={`${
                      item.selected ? "selected-row" : "not-selected-row"
                    }${activeRouteId === item.id ? " active-route-row" : ""}`}
                  >
                    <td className="select-column">
                      <input
                        type="checkbox"
                        className="select-checkbox"
                        checked={item.selected}
                        onChange={() => toggleSelected(item.id)}
                        aria-label={`${item.program} programını seç`}
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        className="rank-input"
                        min={1}
                        max={preferences.length}
                        value={index + 1}
                        onChange={(event) =>
                          movePreference(item.id, Number(event.target.value))
                        }
                      />
                    </td>
                    <td>
                      <span className="code-text">{item.code}</span>
                      <br />
                      <span className="type-tag">YKS</span>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="uni-name-button"
                        aria-pressed={activeRouteId === item.id}
                        title={`${item.university} kampüs detaylarını aç`}
                        onClick={() => void activatePreference(item)}
                      >
                        <strong className="uni-name">{item.university}</strong>
                      </button>
                      <div className="faculty">{item.faculty}</div>
                    </td>
                    <td>
                      <div className="program-name">{item.program}</div>
                    </td>
                    <td>
                      <strong>{item.rank}</strong>
                      <br />
                      <span className="score-text">{item.score} puan</span>
                    </td>
                    <td>
                      {item.routeStatus === "loading" && (
                        <>
                          <span className="route-badge route-loading">⏳ Rota hesaplanıyor</span>
                          <span className="route-note">Kampüs ve toplu taşıma aranıyor</span>
                        </>
                      )}

                      {item.routeStatus === "ready" && item.route && (
                        <>
                          <button
                            type="button"
                            className="route-summary-button no-print"
                            onClick={() => {
                              setActiveRouteId(item.id);
                              showRouteOnMap(item.route as RouteInfo);
                            }}
                          >
                            {item.route.hasMetrobus
                              ? "🚍"
                              : item.route.transitSteps.length
                                ? "🚌"
                                : "🗺️"}{" "}
                            {item.route.lineSummary}
                          </button>
                          <span className="route-print-summary">
                            {item.route.lineSummary}
                          </span>
                          <span className="route-note">
                            {item.route.distanceText} · {item.route.durationText}
                          </span>
                          <a
                            className="route-link no-print"
                            href={item.route.googleMapsUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Google Maps'te aç
                          </a>
                        </>
                      )}

                      {item.routeStatus === "error" && (
                        <>
                          <span className="route-error">{item.routeError}</span>
                          <button
                            type="button"
                            className="route-retry no-print"
                            onClick={() => void calculateRoute(item)}
                          >
                            Tekrar dene
                          </button>
                          {item.fallbackMapsUrl && (
                            <a
                              className="route-link no-print"
                              href={item.fallbackMapsUrl}
                              target="_blank"
                              rel="noreferrer"
                            >
                              Google Maps'te aç
                            </a>
                          )}
                        </>
                      )}

                      {item.routeStatus === "idle" && (
                        <button
                          type="button"
                          className="route-retry no-print"
                          onClick={() => void calculateRoute(item)}
                        >
                          🚌 Rota hesapla
                        </button>
                      )}
                    </td>
                    <td className="delete-column no-print">
                      <button
                        type="button"
                        className="btn-delete"
                        onClick={() => removePreference(item.id)}
                      >
                        Sil
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {activePreference && (
          <section className="route-detail-card no-print">
            <div className="route-detail-header">
              <div>
                <span className="route-eyebrow">
                  {activePreference.route?.hasMetrobus
                    ? "METROBÜS ROTASI"
                    : "KAMPÜS ROTASI"}
                </span>
                <h2>{activePreference.university}</h2>
                <p>
                  {activePreference.route?.destinationQuery ||
                    `${activePreference.faculty} · ${activePreference.program}`}
                </p>
              </div>

              {activePreference.routeStatus === "ready" &&
                activePreference.route && (
                  <div className="route-metrics">
                    <strong>{activePreference.route.durationText}</strong>
                    <span>{activePreference.route.distanceText}</span>
                  </div>
                )}
            </div>

            {activePreference.routeStatus === "ready" &&
              activePreference.route &&
              (activePreference.route.routeOptions?.length ?? 0) > 1 && (
                <div className="route-option-list" aria-label="Rota seçenekleri">
                  {activePreference.route.routeOptions?.map((option) => {
                    const isActive =
                      option.optionId === activePreference.route?.optionId ||
                      (!activePreference.route?.optionId &&
                        option.encodedPolyline ===
                          activePreference.route?.encodedPolyline);

                    return (
                      <button
                        type="button"
                        key={option.optionId}
                        className={`route-option-button${
                          isActive ? " active" : ""
                        }${option.hasMetrobus ? " metrobus-option" : ""}`}
                        aria-pressed={isActive}
                        onClick={() =>
                          selectRouteOption(activePreference.id, option)
                        }
                      >
                        <span className="route-option-title">
                          {option.hasMetrobus ? "🚍 Metrobüs" : "🚌 Toplu taşıma"}
                        </span>
                        <strong>
                          {option.durationText} · {option.distanceText}
                        </strong>
                        <small>{option.lineSummary}</small>
                      </button>
                    );
                  })}
                </div>
              )}

            {activePreference.routeStatus === "loading" && (
              <div className="route-panel-status">
                <strong>⏳ Rota hesaplanıyor</strong>
                <span>
                  {activePreference.university} kampüsü ve toplu taşıma hatları
                  aranıyor.
                </span>
              </div>
            )}

            {activePreference.routeStatus === "idle" && (
              <div className="route-panel-status">
                <strong>Bu üniversitenin rotası henüz hesaplanmadı.</strong>
                <button
                  type="button"
                  className="route-retry"
                  onClick={() => void calculateRoute(activePreference)}
                >
                  🚌 Rotayı hesapla
                </button>
              </div>
            )}

            {activePreference.routeStatus === "error" && (
              <div className="route-panel-status route-panel-error">
                <strong>Rota hesaplanamadı.</strong>
                <span>
                  {activePreference.routeError ||
                    "Kampüs konumu veya toplu taşıma bilgisi alınamadı."}
                </span>
                <button
                  type="button"
                  className="route-retry"
                  onClick={() => void calculateRoute(activePreference)}
                >
                  Tekrar dene
                </button>
                {activePreference.fallbackMapsUrl && (
                  <a
                    className="route-link"
                    href={activePreference.fallbackMapsUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Google Maps'te aç
                  </a>
                )}
              </div>
            )}

            {activePreference.routeStatus === "ready" &&
              activePreference.route && (
                <>
                  {!activePreference.route.configured && (
                    <div className="api-warning">
                      {activePreference.route.message ||
                        "Google Routes API anahtarı eklenmediği için hatlar henüz gösterilemiyor."}
                    </div>
                  )}

                  {activePreference.route.transitSteps.length > 0 ? (
                    <div className="transit-steps">
                      {activePreference.route.transitSteps.map((step, index) => (
                        <article
                          className="transit-step"
                          key={`${step.line}-${index}`}
                        >
                          <div className="transit-icon">
                            {routeModeIcon(step.vehicle)}
                          </div>
                          <div>
                            <h3>
                              {step.vehicle} {step.line}
                            </h3>
                            <p>
                              {step.from || "Başlangıç durağı"} →{" "}
                              {step.to || "Varış durağı"}
                            </p>
                            <small>
                              {step.headsign ? `Yön: ${step.headsign}` : ""}
                              {step.headsign && step.stopCount ? " · " : ""}
                              {step.stopCount ? `${step.stopCount} durak` : ""}
                              {(step.departureTime || step.arrivalTime) &&
                                ` · ${step.departureTime || "—"}–${
                                  step.arrivalTime || "—"
                                }`}
                            </small>
                          </div>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <p className="no-transit-detail">
                      Hat ayrıntısı gelmedi. Güncel rotayı Google Maps üzerinden
                      açabilirsin.
                    </p>
                  )}

                  {activePreference.route.walkingInstructions.length > 0 && (
                    <div className="walking-box">
                      <strong>🚶 Yürüyüş adımları</strong>
                      <ul>
                        {activePreference.route.walkingInstructions.map(
                          (instruction, index) => (
                            <li key={`${instruction}-${index}`}>{instruction}</li>
                          )
                        )}
                      </ul>
                    </div>
                  )}

                  <a
                    className="maps-open-button"
                    href={activePreference.route.googleMapsUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Ayrıntılı rotayı Google Maps'te aç
                  </a>
                </>
              )}
          </section>
        )}
      </div>
    </main>
  );
}
