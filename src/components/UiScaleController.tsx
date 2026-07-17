import { useEffect } from "react";
import { useSettingsStore } from "../store/settings";

/**
 * Pushes the persisted UI-scale policy to the main process, which owns the actual
 * zoom application and the auto-resize recompute. Rendered inside AppInitializer so
 * it only runs after settings hydrate — meaning a saved "manual" scale immediately
 * overrides main's default-auto. Renders nothing.
 */
export default function UiScaleController(): null {
  const uiScaleMode = useSettingsStore((s) => s.uiScaleMode);
  const uiScale = useSettingsStore((s) => s.uiScale);

  useEffect(() => {
    (window as any).ipcApi
      ?.sendIpcRequest("window:set-ui-scale", { mode: uiScaleMode, factor: uiScale })
      .catch(() => {
        /* main keeps its last-applied factor; nothing to recover here */
      });
  }, [uiScaleMode, uiScale]);

  return null;
}
