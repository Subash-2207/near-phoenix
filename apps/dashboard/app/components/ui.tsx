"use client";

import {
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ComponentProps,
  type ReactNode,
} from "react";
import Link from "next/link";
import {
  animate,
  motion,
  MotionConfig,
  useMotionValue,
  useSpring,
} from "motion/react";
import { useMotionPreferences } from "./motion-preferences";
import "./ui.css";

type MagneticTarget = (dx: number, dy: number, proximity: number) => void;
const magneticTargets = new Map<HTMLElement, MagneticTarget>();

type MagneticButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  href?: never;
};
type MagneticLinkProps = Omit<
  ComponentProps<typeof Link>,
  "className" | "style"
> & {
  className?: string;
  style?: React.CSSProperties;
};

/** Opt-in primary action with spring-backed movement from the delegated pointer. */
export function MagneticButton(props: MagneticButtonProps | MagneticLinkProps) {
  const { reduceMotion: reduce } = useMotionPreferences();
  const nodeRef = useRef<HTMLElement | null>(null);
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const scale = useMotionValue(1);
  const springX = useSpring(x, { stiffness: 320, damping: 30, mass: 0.42 });
  const springY = useSpring(y, { stiffness: 320, damping: 30, mass: 0.42 });
  const springScale = useSpring(scale, {
    stiffness: 320,
    damping: 30,
    mass: 0.42,
  });

  useEffect(() => {
    const node = nodeRef.current;
    const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)");
    if (!node || reduce) return;

    const stopX = springX.on("change", (value) =>
      node.style.setProperty("--mag-x", `${value}px`),
    );
    const stopY = springY.on("change", (value) =>
      node.style.setProperty("--mag-y", `${value}px`),
    );
    const stopScale = springScale.on("change", (value) =>
      node.style.setProperty("--mag-scale", `${value}`),
    );
    const move: MagneticTarget = (dx, dy, proximity) => {
      node.style.setProperty("--mag-proximity", `${proximity}`);
      x.set(Math.max(-6, Math.min(6, dx * 0.08 * proximity)));
      y.set(Math.max(-6, Math.min(6, dy * 0.08 * proximity)));
      scale.set(1 + proximity * 0.10);
    };
    const reset = () => {
      x.set(0);
      y.set(0);
      scale.set(1);
      springX.jump(0);
      springY.jump(0);
      springScale.jump(1);
      node.style.removeProperty("--mag-x");
      node.style.removeProperty("--mag-y");
      node.style.removeProperty("--mag-scale");
      node.style.removeProperty("--mag-proximity");
    };
    const syncPointer = () => {
      if (finePointer.matches) magneticTargets.set(node, move);
      else {
        magneticTargets.delete(node);
        reset();
      }
    };
    syncPointer();
    finePointer.addEventListener("change", syncPointer);
    return () => {
      magneticTargets.delete(node);
      finePointer.removeEventListener("change", syncPointer);
      stopX();
      stopY();
      stopScale();
      reset();
    };
  }, [reduce, scale, springScale, springX, springY, x, y]);

  const className =
    `${props.className ?? ""} button button-primary magnetic-button`.trim();
  const setNode = (node: HTMLElement | null) => {
    nodeRef.current = node;
  };
  const transform =
    "translate3d(var(--mag-x, 0px), var(--mag-y, 0px), 0) scale(var(--mag-scale, 1))";

  if ("href" in props && props.href !== undefined) {
    const {
      href,
      className: _className,
      children,
      style,
      ...linkProps
    } = props;
    return (
      <Link
        {...linkProps}
        ref={setNode}
        href={href}
        className={className}
        style={{ ...style, transform }}
      >
        <span className="magnetic-button__content">{children}</span>
      </Link>
    );
  }

  const { className: _className, children, style, ...buttonProps } = props;
  return (
    <button
      {...buttonProps}
      ref={setNode}
      type={buttonProps.type ?? "button"}
      className={className}
      style={{ ...style, transform }}
    >
      <span className="magnetic-button__content">{children}</span>
    </button>
  );
}

export function MotionProvider({ children }: { children: ReactNode }) {
  const { reduceMotion } = useMotionPreferences();
  return (
    <MotionConfig
      reducedMotion={reduceMotion ? "always" : "user"}
      transition={{ type: "spring", stiffness: 220, damping: 28 }}
    >
      {children}
    </MotionConfig>
  );
}

export function Reveal({
  children,
  delay = 0,
  className = "",
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  const { reduceMotion: reduce } = useMotionPreferences();
  return (
    <motion.div
      className={className}
      initial={reduce ? false : { opacity: 0, y: 12 }}
      animate={reduce ? { opacity: 1, y: 0 } : undefined}
      whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.16 }}
      transition={{
        duration: reduce ? 0 : 0.45,
        delay: reduce ? 0 : delay,
        ease: [0.22, 1, 0.36, 1],
      }}
    >
      {children}
    </motion.div>
  );
}

/** One delegated, fine-pointer cursor system. It is absent on touch/reduced-motion devices. */
export function AmbientCursor() {
  const { reduceMotion: reduce } = useMotionPreferences();
  const [ready, setReady] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const rawX = useMotionValue(-100);
  const rawY = useMotionValue(-100);
  const ringX = useSpring(rawX, { stiffness: 420, damping: 38, mass: 0.32 });
  const ringY = useSpring(rawY, { stiffness: 420, damping: 38, mass: 0.32 });
  const hoverTarget = useRef<Element | null>(null);
  const magneticTarget = useRef<HTMLElement | null>(null);
  const spotlightTarget = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const root = document.querySelector<HTMLElement>(".px-shell");
    const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)");
    if (!root || reduce) return;

    let frame = 0;
    let listening = false;
    let hasPosition = false;
    let latestPointer: { x: number; y: number; target: Element | null } | null = null;
    let actionTargets: HTMLElement[] = [];
    const collectActions = () => {
      actionTargets = Array.from(root.querySelectorAll<HTMLElement>(
        "button, a.button, a.mn-primary, a.mn-quiet-link, .px-top-link",
      ));
    };
    collectActions();
    const actionObserver = new MutationObserver(() => {
      collectActions();
      if (magneticTarget.current?.matches(":disabled, [aria-disabled='true']")) {
        resetMagnetic();
      }
    });
    actionObserver.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["disabled", "aria-disabled"],
    });

    const interactive =
      "a, button, [role='button'], summary, .card-tilt, .rn-node, .ep-step";
    const resetMagnetic = () => {
      const current = magneticTarget.current;
      if (current) {
        magneticTargets.get(current)?.(0, 0, 0);
        current.removeAttribute("data-near");
        current.style.removeProperty("--near");
        current.style.removeProperty("--near-dx");
        current.style.removeProperty("--near-dy");
      }
      magneticTarget.current = null;
    };
    const resetSpotlight = () => {
      spotlightTarget.current?.removeAttribute("data-spotlight");
      spotlightTarget.current?.style.removeProperty("--spot-x");
      spotlightTarget.current?.style.removeProperty("--spot-y");
      spotlightTarget.current = null;
    };
    const reset = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      latestPointer = null;
      hasPosition = false;
      ringX.stop();
      ringY.stop();
      setReady(false);
      setExpanded(false);
      hoverTarget.current = null;
      resetMagnetic();
      resetSpotlight();
    };
    const updatePointer = () => {
      frame = 0;
      const pointer = latestPointer;
      if (!pointer || document.hidden || !finePointer.matches) return;
      rawX.set(pointer.x);
      rawY.set(pointer.y);
      if (!hasPosition) {
        ringX.jump(pointer.x);
        ringY.jump(pointer.y);
        hasPosition = true;
        setReady(true);
      }

      const target = pointer.target;
      const nextHover = target?.closest(interactive) ?? null;
      if (nextHover !== hoverTarget.current) {
        hoverTarget.current = nextHover;
        setExpanded(Boolean(nextHover));
      }
      const card = target?.closest<HTMLElement>(".card-tilt") ?? null;
      if (card) {
        if (spotlightTarget.current !== card) resetSpotlight();
        spotlightTarget.current = card;
        const bounds = card.getBoundingClientRect();
        card.style.setProperty("--spot-x", `${pointer.x - bounds.left}px`);
        card.style.setProperty("--spot-y", `${pointer.y - bounds.top}px`);
        card.dataset.spotlight = "on";
      } else {
        resetSpotlight();
      }

      const magnetRadius = 120;
      let nearest: HTMLElement | null = null;
      let nearestDistance = magnetRadius;
      let nearestDx = 0;
      let nearestDy = 0;
      const modal = document.querySelector("dialog[open]");
      for (const candidate of actionTargets) {
        if (!candidate.isConnected || !root.contains(candidate)) continue;
        if (modal && !modal.contains(candidate)) continue;
        if (candidate.matches(":disabled, [aria-disabled='true']")) continue;
        const bounds = candidate.getBoundingClientRect();
        if (bounds.width === 0 || bounds.height === 0) continue;
        const dx = pointer.x - (bounds.left + bounds.width / 2);
        const dy = pointer.y - (bounds.top + bounds.height / 2);
        const edgeX = Math.max(
          bounds.left,
          Math.min(bounds.right, pointer.x),
        );
        const edgeY = Math.max(
          bounds.top,
          Math.min(bounds.bottom, pointer.y),
        );
        const distance = Math.hypot(
          pointer.x - edgeX,
          pointer.y - edgeY,
        );
        if (distance < nearestDistance) {
          nearest = candidate;
          nearestDistance = distance;
          nearestDx = dx;
          nearestDy = dy;
        }
      }

      if (nearest !== magneticTarget.current) resetMagnetic();
      if (nearest) {
        magneticTarget.current = nearest;
        const proximity = 1 - nearestDistance / magnetRadius;
        nearest.dataset.near = "true";
        nearest.style.setProperty("--near", `${proximity}`);
        nearest.style.setProperty("--near-dx", `${Math.max(-4, Math.min(4, nearestDx * proximity * .05))}px`);
        nearest.style.setProperty("--near-dy", `${Math.max(-4, Math.min(4, nearestDy * proximity * .05))}px`);
        magneticTargets.get(nearest)?.(nearestDx, nearestDy, proximity);
      }
    };
    const onPointerMove = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (event.pointerType !== "mouse" || !target || !root.contains(target)) {
        reset();
        return;
      }
      latestPointer = {
        x: event.clientX,
        y: event.clientY,
        target,
      };
      if (!frame) frame = requestAnimationFrame(updatePointer);
    };
    const onPointerOut = (event: PointerEvent) => {
      if (!event.relatedTarget) reset();
    };
    const syncListeners = () => {
      reset();
      const enabled = finePointer.matches && !document.hidden;
      if (enabled && !listening) {
        window.addEventListener("pointermove", onPointerMove, { passive: true });
        window.addEventListener("pointerout", onPointerOut, { passive: true });
        listening = true;
      } else if (!enabled && listening) {
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerout", onPointerOut);
        listening = false;
      }
    };
    syncListeners();
    window.addEventListener("blur", reset);
    window.addEventListener("scroll", reset, { passive: true });
    document.addEventListener("visibilitychange", syncListeners);
    finePointer.addEventListener("change", syncListeners);
    return () => {
      actionObserver.disconnect();
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerout", onPointerOut);
      window.removeEventListener("blur", reset);
      window.removeEventListener("scroll", reset);
      document.removeEventListener("visibilitychange", syncListeners);
      finePointer.removeEventListener("change", syncListeners);
      reset();
    };
  }, [reduce, rawX, rawY, ringX, ringY]);

  if (reduce) return null;
  return (
    <>
      <motion.span
        className={`px-custom-cursor px-cursor-follower ${ready ? "is-visible" : ""} ${expanded ? "is-expanded" : ""}`}
        style={{ x: ringX, y: ringY }}
        aria-hidden="true"
      />
      <motion.span
        className={`px-custom-cursor px-cursor-spotlight ${ready ? "is-visible" : ""}`}
        style={{ x: rawX, y: rawY }}
        aria-hidden="true"
      />
    </>
  );
}

/** A small, opt-in tilt surface for summary cards; mouse only and fully spring-cleaned. */
export function TiltSection({
  children,
  className,
  accent,
}: {
  children: ReactNode;
  className?: string;
  accent?: string;
}) {
  const { reduceMotion: reduce } = useMotionPreferences();
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const rotateX = useSpring(x, { stiffness: 220, damping: 24, mass: 0.35 });
  const rotateY = useSpring(y, { stiffness: 220, damping: 24, mass: 0.35 });
  const pointerCapability = useRef<MediaQueryList | null>(null);
  useEffect(() => {
    const reset = () => {
      x.set(0);
      y.set(0);
      rotateX.jump(0);
      rotateY.jump(0);
    };
    if (reduce) {
      reset();
      return;
    }
    const media = window.matchMedia("(hover: hover) and (pointer: fine)");
    pointerCapability.current = media;
    const onCapabilityChange = () => {
      if (!media.matches) reset();
    };
    const onVisibilityChange = () => {
      if (document.hidden) reset();
    };
    window.addEventListener("blur", reset);
    document.addEventListener("visibilitychange", onVisibilityChange);
    media.addEventListener("change", onCapabilityChange);
    return () => {
      window.removeEventListener("blur", reset);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      media.removeEventListener("change", onCapabilityChange);
      pointerCapability.current = null;
      reset();
    };
  }, [reduce, x, y, rotateX, rotateY]);
  return (
    <motion.section
      className={className}
      data-accent={accent}
      style={{ transformPerspective: 1100, rotateX, rotateY }}
      onPointerMove={reduce ? undefined : (event) => {
        if (event.pointerType !== "mouse" || !pointerCapability.current?.matches) return;
        const rect = event.currentTarget.getBoundingClientRect();
        x.set(
          ((rect.top + rect.height / 2 - event.clientY) / rect.height) * 2.5,
        );
        y.set(
          ((event.clientX - (rect.left + rect.width / 2)) / rect.width) * 2.5,
        );
      }}
      onPointerLeave={reduce ? undefined : () => {
        x.set(0);
        y.set(0);
      }}
    >
      {children}
    </motion.section>
  );
}

/** Use only for measurements, never bigint amounts, identities, hashes, or nonces. */
export function AnimatedNumber({
  value,
  decimals = 0,
  suffix = "",
}: {
  value: number | null | undefined;
  decimals?: number;
  suffix?: string;
}) {
  const { reduceMotion: reduce } = useMotionPreferences();
  const [display, setDisplay] = useState(value);
  const previous = useRef(value);
  useEffect(() => {
    if (
      value == null ||
      !Number.isFinite(value) ||
      reduce ||
      previous.current == null
    ) {
      previous.current = value;
      setDisplay(value);
      return;
    }
    const from = previous.current;
    previous.current = value;
    const controls = animate(from, value, {
      duration: 0.65,
      ease: "easeOut",
      onUpdate: setDisplay,
    });
    return () => controls.stop();
  }, [value, reduce]);
  return (
    <span className="px-number">
      {value != null &&
      Number.isFinite(value) &&
      display != null &&
      Number.isFinite(display)
        ? `${display.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}${suffix}`
        : "—"}
    </span>
  );
}

export function CopyButton({
  value,
  label = "Copy value",
}: {
  value: string;
  label?: string;
}) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setStatus("copied");
    } catch {
      setStatus("failed");
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setStatus("idle"), 2400);
  };
  return (
    <span className="px-copy-wrap">
      <button
        type="button"
        className="px-copy"
        onClick={() => void copy()}
        aria-label={label}
        title={label}
      >
        <Icon name={status === "copied" ? "check" : "copy"} size={14} />
      </button>
      <span className="px-copy-status" role="status">
        {status === "copied"
          ? "Copied"
          : status === "failed"
            ? "Copy unavailable"
            : ""}
      </span>
    </span>
  );
}

export function GlassCard({
  children,
  className = "",
  title,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  const { reduceMotion: reduce } = useMotionPreferences();
  return (
    <motion.section
      className={`px-glass ${className}`}
      whileHover={reduce ? undefined : { y: -2 }}
      transition={{ duration: 0.2 }}
    >
      {title && <h2>{title}</h2>}
      {children}
    </motion.section>
  );
}

const paths: Record<string, ReactNode> = {
  shield: (
    <>
      <path d="m12 3 8 3v5c0 5-4 8-8 10-4-2-8-5-8-10V6l8-3Z" />
      <path d="m8 12 3 3 5-6" />
    </>
  ),
  layers: (
    <>
      <path d="m3 7 9-4 9 4-9 4-9-4Zm0 5 9 4 9-4M3 17l9 4 9-4" />
    </>
  ),
  fingerprint: (
    <>
      <path d="M6 18c2-3 1-7 2-9a4 4 0 0 1 8 1c0 5-1 8-3 11M3 13v-3a9 9 0 0 1 18 0v3M10 19c1-3 2-5 2-9M18 19c2-4 2-6 2-9" />
    </>
  ),
  play: <path d="m8 4 12 8-12 8V4Z" />,
  alert: (
    <>
      <path d="m12 3 10 18H2L12 3Z" />
      <path d="M12 9v5m0 3v.2" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6m0-10v.2" />
    </>
  ),
  overview: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </>
  ),
  recovery: (
    <>
      <circle cx="12" cy="5" r="2.5" />
      <circle cx="5" cy="18" r="2.5" />
      <circle cx="19" cy="18" r="2.5" />
      <path d="m10.8 7.3-4.6 8.4M13.2 7.3l4.6 8.4M7.5 18h9" />
    </>
  ),
  security: (
    <>
      <path d="m12 3 8 3v5c0 5-4 8-8 10-4-2-8-5-8-10V6l8-3Z" />
      <path d="m8 12 3 3 5-6" />
    </>
  ),
  escrow: (
    <>
      <rect x="3" y="5" width="18" height="15" rx="3" />
      <path d="M3 9h18M16 13h5M6 5V3h11" />
      <circle cx="16" cy="14" r=".5" />
    </>
  ),
  sentinel: (
    <>
      <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  explorer: (
    <>
      <path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z" />
      <path d="m4 7.5 8 4.5 8-4.5M12 12v9M8 5.3l8 4.5" />
    </>
  ),
  analytics: (
    <>
      <path d="M4 3v17h17M8 15v-4M13 15V6M18 15v-7" />
    </>
  ),
  "token-economics": (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M8 16V8l8 8V8M8 8h3M13 16h3" />
    </>
  ),
  methodology: (
    <>
      <path d="M5 3h11l3 3v15H5V3ZM9 8h6M9 12h6M9 16h4" />
    </>
  ),
  developers: (
    <>
      <path d="m8 7-5 5 5 5M16 7l5 5-5 5M14 4l-4 16" />
    </>
  ),
  about: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6M12 7v.5" />
    </>
  ),
  moon: <path d="M20.4 15.5A8.5 8.5 0 0 1 8.5 3.6 8.5 8.5 0 1 0 20.4 15.5Z" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42" />
    </>
  ),
  monitor: (
    <>
      <rect x="3" y="4" width="18" height="13" rx="2" />
      <path d="M8 21h8m-4-4v4" />
    </>
  ),
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m16 16 5 5" />
    </>
  ),
  bell: (
    <>
      <path d="M18 8a6 6 0 0 0-12 0c0 7-2 7-2 9h16c0-2-2-2-2-9ZM10 21h4" />
    </>
  ),
  wallet: (
    <>
      <rect x="3" y="6" width="18" height="14" rx="3" />
      <path d="M3 9V5a2 2 0 0 1 2-2h12v3M21 11h-6v5h6M17 13.5h.1" />
    </>
  ),
  collapse: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16m7-11-3 3 3 3" />
    </>
  ),
  menu: (
    <>
      <path d="M4 6h16M4 12h16M4 18h16" />
    </>
  ),
  close: <path d="m6 6 12 12M6 18 18 6" />,
  arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
  external: (
    <>
      <path d="M14 3h7v7M21 3l-11 11M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5" />
    </>
  ),
  copy: (
    <>
      <rect x="8" y="8" width="12" height="13" rx="2" />
      <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" />
    </>
  ),
  check: <path d="m5 12 4 4L19 6" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  activity: <path d="M2 12h5l3-8 4 16 3-8h5" />,
  lock: (
    <>
      <rect x="5" y="10" width="14" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 4v6h-6M4 20v-6h6" />
      <path d="M5.1 8a8 8 0 0 1 13.2-2L20 10M4 14l1.7 4A8 8 0 0 0 19 16" />
    </>
  ),
  spark: (
    <path d="m12 2 2.7 7.3L22 12l-7.3 2.7L12 22l-2.7-7.3L2 12l7.3-2.7L12 2Z" />
  ),
};
export function Icon({
  name,
  size = 18,
  className = "",
}: {
  name: string;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {paths[name] ?? paths.activity}
    </svg>
  );
}
