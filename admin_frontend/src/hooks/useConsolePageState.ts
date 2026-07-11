// FILE: ~/otmega/otmega_app/console/admin_frontend/src/hooks/useConsolePageState.ts
// ماموریت: مکانیزم واحد «آخرین وضعیت صفحه» برای Admin Console (درخواست 2083 سند 0016-0201).
// هر صفحه/پنل وضعیت خود را به‌عنوان یک section مستقل در فایل GCS تنظیمات کنسول
// (admin-console-dashboard-settings.json — per-actor و per-section merge) ذخیره و در
// بازگشت بازیابی می‌کند. چون backend فقط section داده‌شده را جایگزین می‌کند، هیچ
// section دیگری (و هیچ فایل دیگری در main-data که به خود Collabra داده می‌شود)
// دست نمی‌خورد. قاعده: صفحه جدید = یک section جدید snake_case از طریق همین هوک؛
// پیاده‌سازی دستی و پراکنده load/save ممنوع.

import { useEffect, useRef, useState } from 'react';
import { fetchConsoleDashboardSettings, saveConsoleDashboardSettingsSection } from '../api/consoleApi';

const SAVE_DEBOUNCE_MS = 600;

export function useConsolePageState<T extends Record<string, unknown>>(
  sectionKey: string,
  defaultState: T,
): [T, (updater: T | ((previous: T) => T)) => void, boolean] {
  const [state, setState] = useState<T>(defaultState);
  const [loaded, setLoaded] = useState(false);
  const lastSavedRef = useRef<string | null>(null);
  const loadedRef = useRef(false);

  // Load the persisted section once per mount; unknown/missing section keeps defaults.
  useEffect(() => {
    let cancelled = false;
    void fetchConsoleDashboardSettings()
      .then((response) => {
        if (cancelled) return;
        const saved = response.settings?.[sectionKey] as Partial<T> | undefined;
        if (saved && typeof saved === 'object') {
          setState((previous) => {
            const merged = { ...previous, ...saved };
            lastSavedRef.current = JSON.stringify(merged);
            return merged;
          });
        }
      })
      .catch(() => undefined) // persistence is best-effort; the page must keep working
      .finally(() => {
        if (!cancelled) {
          loadedRef.current = true;
          setLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
    // sectionKey is stable per page by contract.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Debounced save on every change AFTER the initial load (so defaults never clobber
  // the remote value before it arrives).
  useEffect(() => {
    if (!loadedRef.current) return undefined;
    const serialized = JSON.stringify(state);
    if (lastSavedRef.current === serialized) return undefined;
    const timer = window.setTimeout(() => {
      lastSavedRef.current = serialized;
      void saveConsoleDashboardSettingsSection(sectionKey, state).catch(() => undefined);
    }, SAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [state, sectionKey]);

  return [state, setState, loaded];
}
