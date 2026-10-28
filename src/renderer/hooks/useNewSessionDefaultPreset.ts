import { useCallback, useEffect, useRef } from "react";
import { call } from "@/lib/api-client";
import { DEFAULT_TOOL_PRESET, type ToolPreset } from "@shared/tool-presets";

/**
 * Seeds a new session from the desktop default preset. The promise is kept so
 * the first send cannot race the settings read, and an explicit choice in this
 * view always wins over the late-arriving preference.
 */
export function useNewSessionDefaultPreset(isNew: boolean, apply: (preset: ToolPreset) => void) {
  const applyRef = useRef(apply);
  applyRef.current = apply;
  const preference = useRef<Promise<ToolPreset> | null>(null);
  const chosen = useRef(false);
  useEffect(() => {
    if (!isNew) return;
    let active = true;
    const promise = call("settings.getDefaultToolPreset").then(
      (value) => value.preset as ToolPreset,
      () => DEFAULT_TOOL_PRESET,
    );
    preference.current = promise;
    void promise.then((preset) => {
      if (active && !chosen.current) applyRef.current(preset);
    });
    return () => {
      active = false;
    };
  }, [isNew]);
  const markChosen = useCallback(() => {
    chosen.current = true;
  }, []);
  const resolve = useCallback(
    async (current: ToolPreset): Promise<ToolPreset> =>
      isNew && !chosen.current && preference.current ? preference.current : current,
    [isNew],
  );
  return { resolve, markChosen };
}
