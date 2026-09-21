"use client";

import { useEffect } from "react";
import { useAlerts } from "@/store/alerts";
import { accentDef } from "@/lib/accent";
import { setMasterVolume } from "@/lib/sounds";

/**
 * SystemBridge — applies persisted operator preferences to the document:
 * - accent → html[data-accent] (drives the whole neon chrome via CSS vars)
 * - soundVolume → WebAudio master gain
 * Runs on mount + whenever the persisted values change.
 */
export function SystemBridge() {
  const accent = useAlerts((s) => s.accent);
  const soundVolume = useAlerts((s) => s.soundVolume);

  useEffect(() => {
    const def = accentDef(accent);
    document.documentElement.dataset.accent = def.id;
  }, [accent]);

  useEffect(() => {
    setMasterVolume(soundVolume);
  }, [soundVolume]);

  return null;
}
