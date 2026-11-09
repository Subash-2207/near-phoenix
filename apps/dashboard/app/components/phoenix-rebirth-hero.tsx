"use client";

import { useEffect, useId, useState } from "react";
import Link from "next/link";
import { motion } from "motion/react";
import { useMotionPreferences } from "./motion-preferences";
import { MagneticButton } from "./ui";
import "./phoenix-rebirth-hero.css";

type Point = readonly [number, number];

const leftOutline: Point[] = [
  [427, 251],
  [388, 229],
  [356, 194],
  [315, 158],
  [266, 128],
  [289, 173],
  [215, 144],
  [270, 194],
  [159, 192],
  [266, 222],
  [190, 247],
  [300, 260],
  [357, 281],
  [413, 280],
];

const phoenixOutline = [
  ...leftOutline,
  ...leftOutline
    .slice(0, -1)
    .reverse()
    .map(([x, y]) => [900 - x, y] as const),
  [477, 306],
  [462, 348],
  [450, 382],
  [438, 348],
  [423, 306],
];

const glyphSource = "01PHOENIXRECOVERYSTATEFLOW";
const glyphs = Array.from(glyphSource).map((character, index) => {
  const [targetX, targetY] =
    phoenixOutline[(index * 3) % phoenixOutline.length];
  return {
    character,
    x: (index * 173 + 61) % 900,
    y: (index * 97 + 37) % 520,
    targetX,
    targetY,
    delay: (index % 9) * 0.035,
  };
});

const fragments = Array.from({ length: 42 }, (_, index) => {
  const [targetX, targetY] =
    phoenixOutline[(index * 7) % phoenixOutline.length];
  return {
    x: (index * 211 + 103) % 900,
    y: (index * 137 + 59) % 520,
    targetX,
    targetY,
    radius: index % 6 === 0 ? 2.1 : 1.15,
    delay: (index % 13) * 0.018,
  };
});

export function PhoenixRebirthHero() {
  const { reduceMotion } = useMotionPreferences();
  const [phase, setPhase] = useState(0);
  const gradientId = useId().replace(/:/g, "");
  const revealText = phase >= 3 || reduceMotion === true;

  useEffect(() => {
    if (reduceMotion) {
      setPhase(3);
      return;
    }

    const forming = window.setTimeout(() => setPhase(1), 2000);
    const ignition = window.setTimeout(() => setPhase(2), 5000);
    const reveal = window.setTimeout(() => setPhase(3), 8000);
    return () => {
      window.clearTimeout(forming);
      window.clearTimeout(ignition);
      window.clearTimeout(reveal);
    };
  }, [reduceMotion]);

  return (
    <section className="rebirth-hero" aria-labelledby="rebirth-title">
      <div className="rebirth-ambient" aria-hidden="true" />
      <div className="rebirth-copy">
        <p className="rebirth-kicker">
          <span className="rebirth-status-mark" /> CYBERNETIC REBIRTH · PHOENIX
          V5.0
        </p>
        {!revealText && (
          <button
            type="button"
            className="rebirth-skip"
            onClick={() => setPhase(3)}
            aria-label="Skip the phoenix introduction animation"
          >
            Skip introduction
          </button>
        )}
        <h2 id="rebirth-title" aria-label="PHOENIX">
          {"PHOENIX".split("").map((letter, index) => (
            <motion.span
              key={`${letter}-${index}`}
              aria-hidden="true"
              initial={{ opacity: 0, y: 18 }}
              animate={
                revealText ? { opacity: 1, y: 0 } : { opacity: 0, y: 18 }
              }
              transition={{
                duration: reduceMotion ? 0 : 0.42,
                delay: reduceMotion || !revealText ? 0 : index * 0.075,
                ease: [0.22, 1, 0.36, 1],
              }}
            >
              {letter}
            </motion.span>
          ))}
        </h2>
        <motion.p
          className="rebirth-subtitle"
          initial={{ opacity: 0, y: 12 }}
          animate={revealText ? { opacity: 1, y: 0 } : { opacity: 0, y: 12 }}
          transition={{
            duration: reduceMotion ? 0 : 0.55,
            delay: reduceMotion || !revealText ? 0 : 0.48,
            ease: [0.22, 1, 0.36, 1],
          }}
        >
          A living continuity protocol for autonomous work.
        </motion.p>
        <motion.p
          className="rebirth-description"
          initial={{ opacity: 0, y: 8 }}
          animate={revealText ? { opacity: 1, y: 0 } : { opacity: 0, y: 8 }}
          transition={{
            duration: reduceMotion ? 0 : 0.48,
            delay: reduceMotion || !revealText ? 0 : 0.62,
          }}
        >
          When an agent falters, verified state gives the next one a place to
          begin.
        </motion.p>
        <motion.div
          className="rebirth-actions"
          inert={!revealText}
          initial={{ opacity: 0, y: 8 }}
          animate={revealText ? { opacity: 1, y: 0 } : { opacity: 0, y: 8 }}
          transition={{
            duration: reduceMotion ? 0 : 0.42,
            delay: reduceMotion || !revealText ? 0 : 0.78,
          }}
        >
          <MagneticButton href="/recovery">
            Explore recovery network <span aria-hidden="true">↗</span>
          </MagneticButton>
          <Link className="button button-secondary" href="/methodology">
            How PHOENIX works
          </Link>
        </motion.div>
        <p className="rebirth-disclosure">
          Concept visualization only · no live agent, recovery, or payment data
        </p>
      </div>

      <motion.div
        className={`rebirth-scene rebirth-scene-phase-${phase}`}
        aria-hidden="true"
        animate={{ scale: phase >= 2 ? (phase >= 3 ? 1 : 1.035) : 0.975 }}
        transition={{
          duration: reduceMotion ? 0 : phase >= 2 ? 1.35 : 2.6,
          ease: [0.22, 1, 0.36, 1],
        }}
      >
        <div className="rebirth-scene-label">
          <span>01—04</span>
          <span>
            {phase < 1
              ? "DIGITAL AWAKENING"
              : phase < 2
                ? "SIGNAL CONVERGENCE"
                : phase < 3
                  ? "CORE IGNITION"
                  : "PHOENIX FORMED"}
          </span>
        </div>
        <svg
          className="rebirth-svg"
          viewBox="0 0 900 520"
          preserveAspectRatio="xMidYMid meet"
          focusable="false"
        >
          <defs>
            <linearGradient
              id={`${gradientId}-metal`}
              x1="0"
              y1="0"
              x2="1"
              y2="1"
            >
              <stop offset="0" stopColor="#e7f3ff" stopOpacity=".92" />
              <stop offset=".28" stopColor="#8799b8" stopOpacity=".84" />
              <stop offset=".63" stopColor="#33445f" stopOpacity=".96" />
              <stop
                offset="1"
                stopColor="var(--cerulean-glow)"
                stopOpacity=".82"
              />
            </linearGradient>
            <linearGradient
              id={`${gradientId}-feather`}
              x1="0"
              y1="0"
              x2="1"
              y2="1"
            >
              <stop offset="0" stopColor="#b8ccdf" stopOpacity=".74" />
              <stop offset=".54" stopColor="#435774" stopOpacity=".9" />
              <stop
                offset="1"
                stopColor="var(--cerulean-glow)"
                stopOpacity=".8"
              />
            </linearGradient>
            <radialGradient id={`${gradientId}-core`}>
              <stop offset="0" stopColor="#c6fff7" />
              <stop offset=".23" stopColor="var(--cerulean-glow)" />
              <stop
                offset="1"
                stopColor="var(--cerulean-glow)"
                stopOpacity="0"
              />
            </radialGradient>
            <filter
              id={`${gradientId}-glow`}
              x="-100%"
              y="-100%"
              width="300%"
              height="300%"
            >
              <feGaussianBlur stdDeviation="8" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          <path
            className="rebirth-orbit"
            d="M124 282a326 160 0 1 0 652 0a326 160 0 1 0-652 0Z"
            pathLength="1"
          />
          <path
            className="rebirth-grid-line"
            d="M112 414h676M164 435h572M222 456h456"
          />
          <ellipse
            className="rebirth-floor-glow"
            cx="450"
            cy="410"
            rx="226"
            ry="36"
          />
          <motion.ellipse
            className="rebirth-energy-loop"
            cx="450"
            cy="252"
            rx="270"
            ry="142"
            initial={{ opacity: 0, scale: 0.94 }}
            animate={
              phase >= 3 && !reduceMotion
                ? { opacity: [0.08, 0.22, 0.08], scale: [0.98, 1.025, 0.98] }
                : phase >= 2
                  ? { opacity: 0.13, scale: 1 }
                  : { opacity: 0, scale: 0.94 }
            }
            transition={
              phase >= 3 && !reduceMotion
                ? { duration: 7.2, repeat: Infinity, ease: "easeInOut" }
                : { duration: reduceMotion ? 0 : 0.9, ease: "easeOut" }
            }
          />

          <g className="rebirth-glyph-field">
            {glyphs.map((glyph, index) => (
              <motion.g
                key={`${glyph.character}-${index}`}
                initial={{ x: glyph.x, y: glyph.y, opacity: 0 }}
                animate={
                  phase === 0
                    ? {
                        x: [glyph.x, glyph.x + (index % 2 ? 3 : -3)],
                        y: [glyph.y, glyph.y - 5],
                        opacity: [0.18, 0.66, 0.44],
                      }
                    : {
                        x: glyph.targetX,
                        y: glyph.targetY,
                        opacity: 0,
                      }
                }
                transition={
                  phase === 0
                    ? {
                        duration: 1.8 + (index % 4) * 0.3,
                        repeat: reduceMotion ? 0 : Infinity,
                        repeatType: "mirror",
                        delay: glyph.delay,
                        ease: "easeInOut",
                      }
                    : {
                        duration: reduceMotion ? 0 : 0.72,
                        delay: reduceMotion ? 0 : glyph.delay,
                        ease: [0.22, 1, 0.36, 1],
                      }
                }
              >
                <text className="rebirth-glyph" x="0" y="0">
                  {glyph.character}
                </text>
              </motion.g>
            ))}
          </g>

          <g className="rebirth-fragments">
            {fragments.map((fragment, index) => (
              <motion.g
                key={`fragment-${index}`}
                initial={{
                  x: fragment.x,
                  y: fragment.y,
                  opacity: 0,
                  scale: 0.5,
                }}
                animate={
                  phase >= 2
                    ? {
                        x: fragment.targetX,
                        y: fragment.targetY,
                        opacity: 0.36,
                        scale: 0.78,
                      }
                    : phase >= 1
                      ? {
                          x: fragment.targetX,
                          y: fragment.targetY,
                          opacity: 0.86,
                          scale: 1,
                        }
                      : { opacity: 0, scale: 0.5 }
                }
                transition={{
                  duration: reduceMotion ? 0 : 0.9,
                  delay: reduceMotion || phase < 1 ? 0 : fragment.delay,
                  ease: [0.22, 1, 0.36, 1],
                }}
              >
                <circle r={fragment.radius} className="rebirth-fragment" />
              </motion.g>
            ))}
          </g>

          {phase >= 2 && (
            <motion.circle
              className="rebirth-energy-wave"
              cx="450"
              cy="249"
              r="70"
              initial={{ opacity: 0.74, scale: 0.22 }}
              animate={{ opacity: 0, scale: 1.85 }}
              transition={{
                duration: reduceMotion ? 0 : 1.15,
                ease: "easeOut",
              }}
            />
          )}

          <motion.g
            className="rebirth-wings"
            style={{ transformBox: "view-box", transformOrigin: "50% 52%" }}
            initial={{ opacity: 0, scaleX: 0.78 }}
            animate={{
              opacity: phase >= 2 ? 1 : 0,
              scaleX: phase >= 3 ? [1, 1.025, 1] : phase >= 2 ? 1 : 0.78,
            }}
            transition={{
              opacity: { duration: reduceMotion ? 0 : 0.8 },
              scaleX:
                phase >= 3 && !reduceMotion
                  ? { duration: 5.8, repeat: Infinity, ease: "easeInOut" }
                  : { duration: reduceMotion ? 0 : 0.85, ease: "easeOut" },
            }}
          >
            <path
              className="rebirth-wing"
              d="M438 251C384 234 349 179 266 128l24 45-75-29 55 50-111-2 107 30-76 25 110 13 98 39 31-22Z"
              fill={`url(#${gradientId}-metal)`}
            />
            <path
              className="rebirth-wing"
              transform="translate(900 0) scale(-1 1)"
              d="M438 251C384 234 349 179 266 128l24 45-75-29 55 50-111-2 107 30-76 25 110 13 98 39 31-22Z"
              fill={`url(#${gradientId}-metal)`}
            />
            <path
              className="rebirth-feather-seam"
              d="m420 263-117-74m103 91-158-37m172 8-96-97"
            />
            <path
              className="rebirth-feather-seam"
              transform="translate(900 0) scale(-1 1)"
              d="m420 263-117-74m103 91-158-37m172 8-96-97"
            />
          </motion.g>

          <motion.g
            className="rebirth-body"
            initial={{ opacity: 0, y: 16 }}
            animate={phase >= 2 ? { opacity: 1, y: 0 } : { opacity: 0, y: 16 }}
            transition={{
              duration: reduceMotion ? 0 : 0.72,
              ease: [0.22, 1, 0.36, 1],
            }}
          >
            <path
              className="rebirth-tail"
              d="M443 286c-4 35-20 62-37 91 30-8 48-32 53-62 5 30 23 54 53 62-17-29-33-56-37-91Z"
              fill={`url(#${gradientId}-feather)`}
            />
            <path
              className="rebirth-neck"
              d="M443 217c-17-17-25-37-20-57 8-26 35-41 59-31 19 8 26 30 18 48l-18 31 16 34-48 22-20-25Z"
              fill={`url(#${gradientId}-metal)`}
            />
            <path
              className="rebirth-beak"
              d="m480 145 43 12-39 12Z"
              fill="#f5d99d"
            />
            <path
              className="rebirth-chest"
              d="M438 210c-23 13-35 39-31 70l43 45 43-45c4-31-8-57-31-70l-12 17Z"
              fill={`url(#${gradientId}-metal)`}
            />
            <path
              className="rebirth-chest-panel"
              d="m450 231 20 21-20 44-20-44Z"
            />
            <path
              className="rebirth-armor-line"
              d="m435 253 15 43 15-43m-31 19 16 9 16-9"
            />
            <path
              className="rebirth-leg"
              d="m438 314-5 23m29-23 5 23m-39 0h13m20 0h13"
            />
            <circle
              className="rebirth-eye-glow"
              cx="469"
              cy="139"
              r="13"
              fill={`url(#${gradientId}-core)`}
              filter={`url(#${gradientId}-glow)`}
            />
            <circle className="rebirth-eye" cx="471" cy="139" r="3.2" />
          </motion.g>
          <circle className="rebirth-orbit-point" cx="450" cy="410" r="3" />
        </svg>
      </motion.div>
      <div className="rebirth-coordinate" aria-hidden="true">
        <span>AGENT CONTINUITY</span>
        <span>IDENTITY · STATE · PROOF</span>
      </div>
      <a className="rebirth-scroll" href="#overview-signals">
        <span>Explore live signals</span>
        <span aria-hidden="true">↓</span>
      </a>
    </section>
  );
}
