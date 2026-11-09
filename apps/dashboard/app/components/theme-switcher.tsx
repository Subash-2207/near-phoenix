"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "./ui";
import { useTheme, type ThemePreference } from "./theme-provider";
import "./theme-switcher.css";

const options: Array<{
  value: ThemePreference;
  label: string;
  icon: string;
}> = [
  { value: "dark", label: "Dark", icon: "moon" },
  { value: "light", label: "Light", icon: "sun" },
  { value: "system", label: "System", icon: "monitor" },
];

export function ThemeSwitcher() {
  const { theme, setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const current =
    options.find((option) => option.value === theme) ?? options[2];

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !rootRef.current?.contains(event.target)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  return (
    <div className="px-theme-switcher" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="px-icon-button px-theme-trigger"
        aria-label={`Appearance: ${current.label}`}
        aria-expanded={open}
        aria-controls="px-theme-options"
        title={`Appearance: ${current.label}`}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && open) {
            setOpen(false);
            triggerRef.current?.focus();
          }
        }}
      >
        <Icon name={current.icon} />
      </button>
      {open && (
        <div
          className="px-theme-menu"
          id="px-theme-options"
          role="group"
          aria-label="Appearance mode"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setOpen(false);
              triggerRef.current?.focus();
            }
          }}
          onBlur={(event) => {
            if (
              !(event.relatedTarget instanceof Node) ||
              !rootRef.current?.contains(event.relatedTarget)
            ) {
              setOpen(false);
            }
          }}
        >
          {options.map((option) => (
            <button
              type="button"
              key={option.value}
              className="px-theme-option"
              aria-pressed={theme === option.value}
              onClick={() => {
                setTheme(option.value);
                setOpen(false);
                triggerRef.current?.focus();
              }}
            >
              <Icon name={option.icon} size={15} />
              <span>{option.label}</span>
              {theme === option.value && (
                <Icon name="check" size={14} className="px-theme-check" />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
