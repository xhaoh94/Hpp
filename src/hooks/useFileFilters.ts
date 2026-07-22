import { useEffect, useState } from "react";
import {
  DEFAULT_FILE_FILTERS,
  FILE_FILTERS_UPDATED_EVENT,
  getFileFilterKey,
  normalizeFileFilters,
  type FileFilterConfig,
} from "@shared/file-filters";

function getSettingsFilters(value: unknown): FileFilterConfig {
  const settings = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return normalizeFileFilters(settings.filters);
}

let cachedFilters = normalizeFileFilters(DEFAULT_FILE_FILTERS);
let cacheReady = false;
let cacheRevision = 0;
let loadPromise: Promise<FileFilterConfig> | null = null;

function updateCachedFilters(value: unknown): FileFilterConfig {
  const normalized = normalizeFileFilters(value);
  if (getFileFilterKey(normalized) !== getFileFilterKey(cachedFilters)) {
    cachedFilters = normalized;
    cacheRevision += 1;
  }
  cacheReady = true;
  return cachedFilters;
}

function loadFileFilters(): Promise<FileFilterConfig> {
  if (cacheReady) return Promise.resolve(cachedFilters);
  if (loadPromise) return loadPromise;

  const startingRevision = cacheRevision;
  loadPromise = window.electronAPI.loadData("settings")
    .then((value) => {
      if (cacheRevision === startingRevision) updateCachedFilters(getSettingsFilters(value));
      return cachedFilters;
    })
    .catch(() => cachedFilters)
    .finally(() => {
      loadPromise = null;
    });
  return loadPromise;
}

export function publishFileFilters(value: FileFilterConfig): FileFilterConfig {
  const normalized = normalizeFileFilters(value);
  cachedFilters = normalized;
  cacheReady = true;
  cacheRevision += 1;
  window.dispatchEvent(new CustomEvent(FILE_FILTERS_UPDATED_EVENT, { detail: normalized }));
  return normalized;
}

export function useFileFilters(): FileFilterConfig {
  const [filters, setFilters] = useState<FileFilterConfig>(() => cachedFilters);

  useEffect(() => {
    let active = true;
    const handleFiltersUpdated = (event: Event) => {
      setFilters(updateCachedFilters((event as CustomEvent<FileFilterConfig>).detail));
    };

    window.addEventListener(FILE_FILTERS_UPDATED_EVENT, handleFiltersUpdated);
    void loadFileFilters().then((loadedFilters) => {
      if (active) setFilters(loadedFilters);
    });

    return () => {
      active = false;
      window.removeEventListener(FILE_FILTERS_UPDATED_EVENT, handleFiltersUpdated);
    };
  }, []);

  return filters;
}
