"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import "./motion-preferences.css";

export type MotionPreference = "adaptive" | "vivid" | "still";
type MotionPreferencesValue = {
  preference: MotionPreference;
  setPreference: (preference: MotionPreference) => void;
  reduceMotion: boolean;
  openPreferences: () => void;
};

const MotionPreferencesContext = createContext<MotionPreferencesValue | null>(null);
const STORAGE_KEY = "phoenix-motion";

function readPreference(): MotionPreference {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    return saved === "still" || saved === "vivid" ? saved : "adaptive";
  } catch {
    return "adaptive";
  }
}

export function MotionPreferencesProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<MotionPreference>("adaptive");
  const [systemReduceMotion, setSystemReduceMotion] = useState(true);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();
  const radioName = useId();
  const reduceMotion = preference === "still" || (systemReduceMotion && preference !== "vivid");

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    setPreferenceState(readPreference());
    setSystemReduceMotion(media.matches);
    const onSystemChange = (event: MediaQueryListEvent) => setSystemReduceMotion(event.matches);
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY || event.key === null) setPreferenceState(readPreference());
    };
    media.addEventListener("change", onSystemChange);
    window.addEventListener("storage", onStorage);
    return () => {
      media.removeEventListener("change", onSystemChange);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.motion = reduceMotion ? "still" : preference;
  }, [reduceMotion]);

  const setPreference = useCallback((next: MotionPreference) => {
    setPreferenceState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // The choice remains effective for this session when storage is unavailable.
    }
  }, []);

  const openPreferences = useCallback(() => {
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;
    triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.showModal();
    dialog.querySelector<HTMLInputElement>("input:checked")?.focus();
  }, []);

  const restoreFocus = useCallback(() => {
    const trigger = triggerRef.current;
    if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    triggerRef.current = null;
  }, []);

  const value = useMemo(
    () => ({ preference, setPreference, reduceMotion, openPreferences }),
    [preference, setPreference, reduceMotion, openPreferences],
  );

  return (
    <MotionPreferencesContext.Provider value={value}>
      {children}
      <dialog
        ref={dialogRef}
        className="px-motion-dialog"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onClose={restoreFocus}
        onClick={(event) => {
          if (event.target !== event.currentTarget) return;
          const bounds = event.currentTarget.getBoundingClientRect();
          if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) {
            event.currentTarget.close();
          }
        }}
      >
        <div className="px-motion-dialog__heading">
          <span className="px-motion-dialog__eyebrow">Your workspace</span>
          <button type="button" className="px-motion-dialog__close" onClick={() => dialogRef.current?.close()} aria-label="Close motion preferences">
            Close
          </button>
        </div>
        <h2 id={titleId}>Set your pace.</h2>
        <p id={descriptionId}>Choose how Phoenix moves. Your preference is saved on this device.</p>
        <fieldset className="px-motion-options">
          <legend className="px-motion-sr-only">Motion preference</legend>
          <label className="px-motion-option">
            <input type="radio" name={radioName} value="adaptive" checked={preference === "adaptive"} onChange={() => setPreference("adaptive")} />
            <span><strong>Adaptive motion</strong><small>Ambient movement and subtle pointer interactions, tuned to your device.</small></span>
          </label>
          <label className="px-motion-option">
            <input type="radio" name={radioName} value="vivid" checked={preference === "vivid"} onChange={() => setPreference("vivid")} />
            <span><strong>Vivid button effects</strong><small>Visible magnetic pull, glow and zoom. Choosing this enables pointer motion even when your device prefers reduced motion.</small></span>
          </label>
          <label className="px-motion-option">
            <input type="radio" name={radioName} value="still" checked={preference === "still"} onChange={() => setPreference("still")} />
            <span><strong>Still mode</strong><small>A calm workspace with background motion and pointer effects paused.</small></span>
          </label>
        </fieldset>
        <p className="px-motion-system-note" role="status">
          {systemReduceMotion
            ? "Your device prefers reduced motion. Adaptive stays still; Vivid is your explicit choice to enable button motion."
            : "Adaptive follows your device. Still pauses interactions. Background images stay static."}
        </p>
        <button type="button" className="px-motion-dialog__done" onClick={() => dialogRef.current?.close()}>Done</button>
      </dialog>
    </MotionPreferencesContext.Provider>
  );
}

export function useMotionPreferences() {
  const value = useContext(MotionPreferencesContext);
  if (!value) throw new Error("useMotionPreferences must be used within MotionPreferencesProvider");
  return value;
}

export function MotionPreferencesButton({ className = "" }: { className?: string }) {
  const { openPreferences, reduceMotion } = useMotionPreferences();
  return (
    <button type="button" className={`px-motion-button ${className}`.trim()} onClick={openPreferences} aria-haspopup="dialog">
      Effects <span>{reduceMotion ? "Still" : "On"}</span>
    </button>
  );
}
