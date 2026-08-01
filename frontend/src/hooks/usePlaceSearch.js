import { useEffect, useState } from "react";
import { API_BASE_URL, SEARCH_DEBOUNCE_MS } from "../constants/appConstants";
import { normalizeSearchText } from "../utils/appHelpers";

async function searchPlaces(q, signal) {
  if (q.length < 3) return [];
  const response = await fetch(`${API_BASE_URL}/search?q=${encodeURIComponent(q)}`, { signal });
  return response.json();
}

export default function usePlaceSearch(query, cacheRef) {
  const [results, setResults] = useState([]);

  useEffect(() => {
    const trimmed = String(query || "").trim();
    if (trimmed.length < 3) {
      setResults([]);
      return undefined;
    }

    const cacheKey = normalizeSearchText(trimmed);
    const cached = cacheRef?.current?.get(cacheKey);
    if (cached) {
      setResults(cached);
      return undefined;
    }

    let cancelled = false;
    const controller = new AbortController();
    const timerId = setTimeout(async () => {
      try {
        const found = await searchPlaces(trimmed, controller.signal);
        if (cancelled) return;
        const safeResults = Array.isArray(found) ? found : [];
        cacheRef?.current?.set(cacheKey, safeResults);
        setResults(safeResults);
      } catch {
        if (!cancelled) setResults([]);
      }
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timerId);
      controller.abort();
    };
  }, [cacheRef, query]);

  return results;
}
