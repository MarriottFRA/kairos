import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Link,
  Stack,
  Typography,
} from "@mui/material";
import { alpha, useTheme } from "@mui/material/styles";
import LoginIcon from "@mui/icons-material/Login";
import PersonAddAltRoundedIcon from "@mui/icons-material/PersonAddAltRounded";
import LightModeIcon from "@mui/icons-material/LightMode";
import DarkModeIcon from "@mui/icons-material/DarkMode";
import KairosMark from "../components/KairosMark";
import { brokerErrorCode, describeBrokerError } from "../services/auth";
import { useSettingsStore } from "../store/settings";

// ────────────────────────────────────────────────────────────
// 0) ROUTING + CONSTANTS
// ────────────────────────────────────────────────────────────

const REDIRECT_AFTER_LOGIN = "/signed-in-landing/home";
const SUPPORT_EMAIL = "EMEAReportingSupport@marriott.com";

// window.authApi is typed globally (src/services/auth.ts).

// ────────────────────────────────────────────────────────────
// 1) SCENE PALETTE (kept in sync with src/theme/settings.ts)
// ────────────────────────────────────────────────────────────

type SceneMode = "light" | "dark";

interface SceneVars {
  bg: string; panel: string; text: string; muted: string; faint2: string;
  line: string; accent: string; accent2: string; tint: string; scrim: string;
  accentText: string;
}

function sceneVars(mode: SceneMode): SceneVars {
  return mode === "dark"
    ? {
        bg: "#0a0d13", panel: "#0f141d", text: "#eef2f7",
        muted: "rgba(238,242,247,.52)", faint2: "rgba(238,242,247,.18)",
        line: "rgba(238,242,247,.09)", accent: "#34e0ab", accent2: "#5bb0ff",
        tint: "rgba(52,224,171,.07)", scrim: "rgba(10,13,19,.9)", accentText: "#04140d",
      }
    : {
        bg: "#f4f6f8", panel: "#ffffff", text: "#0f1620",
        muted: "rgba(15,22,32,.52)", faint2: "rgba(15,22,32,.18)",
        line: "rgba(15,22,32,.09)", accent: "#0d7d6b", accent2: "#2b6fd4",
        tint: "rgba(13,125,107,.06)", scrim: "rgba(244,246,248,.9)", accentText: "#ffffff",
      };
}

// ────────────────────────────────────────────────────────────
// 2) SCENE DATA MODEL (decorative — deterministic, no real data)
// ────────────────────────────────────────────────────────────

const BW = 1920, BH = 1080, ROWH = 34, K = 10, LABELW = 110;
const ACTIVE = K - 2; // active fill row sits above the bottom fade so slotting is visible

interface PositionRow { name: string; base: string; bonus: string; benefits: string; pto: string; total: string; }
interface DeptModel { name: string; annual: number; months: number[]; }

function buildPositions(): PositionRow[] {
  // deliberately generic labels — real role names would read as real salaries
  const names = Array.from({ length: 12 }, (_, i) => `Position ${i + 1}`);
  return names.map((name, i) => {
    const base = 78000 + ((i * 6100) % 64000);
    const bonus = Math.round(base * (0.08 + (i % 5) * 0.02));
    const benefits = Math.round(base * 0.19);
    const pto = 15 + ((i * 3) % 12);
    const k = (n: number) => "$" + Math.round(n / 1000) + "k";
    return { name, base: k(base), bonus: k(bonus), benefits: k(benefits), pto: pto + "d", total: k(base + bonus + benefits) };
  });
}

function buildModel(): DeptModel[] {
  const depts: [string, number][] = [
    ["Rooms Division", 3420000], ["Food & Beverage", 1980000], ["Front Office", 2640000],
    ["Housekeeping", 1240000], ["Sales & Marketing", 1560000], ["Finance", 980000],
    ["Culinary", 760000], ["Engineering", 1180000], ["Spa & Leisure", 890000],
    ["Admin & General", 640000],
  ];
  return depts.map(([name, annual], i) => {
    const w: number[] = [];
    for (let m = 0; m < 12; m++) w.push(1 + 0.2 * Math.sin((m / 12) * Math.PI * 2 + i * 0.7) + (((i * 37 + m * 13) % 9) / 40));
    const sw = w.reduce((a, b) => a + b, 0);
    const months = w.map((x) => Math.round(annual * x / sw));
    months[11] += annual - months.reduce((a, b) => a + b, 0);
    return { name, annual, months };
  });
}

const MONTH_LABELS = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];

// ────────────────────────────────────────────────────────────
// 2b) BURST CHOREOGRAPHY — locked-in tuning for the volley animation.
//     Read a few times per volley (never per frame), so named constants
//     cost nothing over inline literals and stay readable.
// ────────────────────────────────────────────────────────────

const BURST = {
  speed: 0.75,                              // master tempo — 2 = whole choreography twice as fast (scales gaps, sweeps, flights, settle)
  originsMin: 1, originsMax: 5,             // ledger cells that fire per cycle (centre-weighted → mostly 2–4)
  originCols: [1, 2, 3, 5],                 // eligible ledger columns (1 BASE · 2 BONUS · 3 BENEFITS · 5 TOTAL)
  splitsMin: 1, splitsMax: 3,               // tokens per month cell → 12–36 tokens per burst
  burstGapMinMs: 150, burstGapMaxMs: 2000,  // delay between one origin's burst and the next
  burstSpreadMinMs: 380, burstSpreadMaxMs: 900, // launch stagger inside a burst (left→right sweep)
  splitLagMs: 110,                          // extra lag between siblings aimed at the same cell
  launchJitterMs: 140,                      // random per-token launch wobble
  flightMinMs: 950, flightMaxMs: 1700,      // per-token flight time
  spawnJitterX: 10, spawnJitterY: 8,        // ± scatter around the origin cell's text (baseline px; 0 = spawn dead-centre)
  arcJitterX: 120, arcJitterY: 200,         // ± mid-flight bezier control-point wobble — bigger = loopier, curvier paths
  originFlashMs: 700,                       // ledger source-cell highlight duration
  originWall: "1px solid rgba(242,140,54,.55)", // slightly-orange 'cell wall' around the firing ledger cell ("" = none)
  settleMinMs: 350, settleMaxMs: 900,       // pause after the last landing before the grid scrolls
  interCycleMs: 130,                        // idle gap after the scroll before the next volley
  breatherChance: 0.18,                     // odds a cycle is followed by a longer lull — keeps the rhythm from feeling metronomic
  breatherMinMs: 700, breatherMaxMs: 2400,  // length of that lull
  pauseFadeMs: 450,                         // in-flight tokens fade out over this long when auth pauses the scene
};

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const randi = (a: number, b: number) => (a + Math.random() * (b - a + 1)) | 0;
// Centre-weighted random (two dice instead of one): values cluster mid-range
// with rare outliers, so jitter and flight times read organic, not uniformly
// noisy. Use for anything the eye tracks; keep flat rand for scheduling gaps.
const randc = (a: number, b: number) => a + ((Math.random() + Math.random()) / 2) * (b - a);
const randci = (a: number, b: number) => Math.round(randc(a, b));

// ────────────────────────────────────────────────────────────
// 3) SCENE CONTROLLER — runs the animation OUTSIDE React's render
//    cycle. The RAF loop only paints the <canvas>; grid cells are
//    mutated imperatively at burst/scroll cadence (a few times/sec),
//    never per-frame. Fully torn down on stop().
// ────────────────────────────────────────────────────────────

interface Token {
  c: number; amt: number; sx: number; sy: number; cx: number; cy: number;
  tx: number; ty: number; startAt: number; dur: number; text: string; col: string;
  tw: number; // label width — measured once on first draw, not per frame
}

interface SceneEls {
  sceneEl: HTMLDivElement;
  ledgerBodyEl: HTMLDivElement;
  gridBodyEl: HTMLDivElement;
  canvasEl: HTMLCanvasElement;
}

class SceneController {
  private els: SceneEls;
  private getMode: () => SceneMode;
  private onPeriods: (n: number) => void;

  private model = buildModel();
  private D = this.model.length;
  private ledgerCount: number;

  private scale = 1;
  private ctx: CanvasRenderingContext2D | null = null;
  private tokens: Token[] = [];
  private pendingBursts = 0;
  private settling = true; // blocks maybeSettle() until cycle() has planned a volley
  private originFlash = new Map<HTMLElement, ReturnType<typeof setTimeout>>();

  private head = 0;
  private periods = 0;
  private activeVals = new Array(12).fill(0);
  private seedCache: Record<string, { dept: string; vals: number[] }> = {};

  private cellRefs: HTMLSpanElement[][] = [];
  private rowRefs: HTMLDivElement[] = [];
  private nameRefs: HTMLSpanElement[] = [];
  private flashTimers: Array<ReturnType<typeof setTimeout> | null> = new Array(12).fill(null);

  private raf = 0;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private alive = false;
  private paused = false;
  private onResize = () => this.resize();
  private onVisibility = () => this.setPaused(document.hidden, /*visibilityDriven*/ true);

  constructor(els: SceneEls, ledgerCount: number, getMode: () => SceneMode, onPeriods: (n: number) => void) {
    this.els = els;
    this.ledgerCount = ledgerCount;
    this.getMode = getMode;
    this.onPeriods = onPeriods;
  }

  // ── lifecycle ──
  start() {
    this.alive = true;
    this.ctx = this.els.canvasEl.getContext("2d");
    this.buildGrid();
    this.renderAll();
    this.resize();
    window.addEventListener("resize", this.onResize);
    document.addEventListener("visibilitychange", this.onVisibility);
    this.raf = requestAnimationFrame(this.loop);
    this.setT(() => this.cycle(), 700);
  }

  stop() {
    this.alive = false;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.clearTimers();
    this.flashTimers.forEach((t) => t && clearTimeout(t));
    this.originFlash.forEach((t) => clearTimeout(t));
    this.originFlash.clear();
    window.removeEventListener("resize", this.onResize);
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.ctx = null;
  }

  setPaused(p: boolean, visibilityDriven = false) {
    if (!this.alive) return;
    // Auth-driven pause must win over the visibility handler flipping back.
    if (visibilityDriven && this.authPaused) return;
    if (!visibilityDriven) this.authPaused = p;
    if (p === this.paused) return;
    this.paused = p;
    if (p) {
      this.clearTimers(); // no further bursts/scrolls either way
      this.pendingBursts = 0;
      this.settling = true;
      if (!visibilityDriven && this.tokens.length > 0) {
        // auth pause with tokens mid-air: let them fade for a beat before the
        // loop halts, instead of freezing them on the canvas
        this.fadeAt = performance.now();
        if (!this.raf) this.raf = requestAnimationFrame(this.loop);
      } else {
        // hidden tab (RAF is throttled anyway) or nothing in flight: hard stop
        cancelAnimationFrame(this.raf);
        this.raf = 0;
        this.tokens.length = 0;
        this.ctx?.clearRect(0, 0, BW, BH);
      }
    } else {
      this.fadeAt = 0;
      this.tokens.length = 0;
      this.activeVals.fill(0);
      this.renderRow(ACTIVE);
      if (!this.raf) this.raf = requestAnimationFrame(this.loop); // one frame to clear leftover canvas paint
      this.setT(() => this.cycle(), 300); // fresh volley on resume
    }
  }
  private authPaused = false;
  private fadeAt = 0;

  private setT(fn: () => void, ms: number) {
    const id = setTimeout(() => {
      this.timers.delete(id);
      if (this.alive && !this.paused) fn();
    }, ms);
    this.timers.add(id);
    return id;
  }
  private clearTimers() {
    this.timers.forEach((id) => clearTimeout(id));
    this.timers.clear();
  }

  // ── layout ──
  resize() {
    this.scale = Math.min(window.innerWidth / BW, window.innerHeight / BH);
    this.els.sceneEl.style.transform = `translate(-50%,-50%) scale(${this.scale.toFixed(4)})`;
    const c = this.els.canvasEl;
    // The canvas draws in the 1920×1080 baseline space and its CSS box is that
    // full 1920×1080 (it lives inside the pre-scale scene). The backing store
    // must therefore be ≥ that box, or the browser upscales it and the tokens
    // blur / stop seating in the cells. Back it at 1920×1080 × dpr (capped for
    // perf) — the sceneRef transform then scales the whole thing down crisply.
    const dpr = Math.min(1.5, window.devicePixelRatio || 1);
    c.width = Math.round(BW * dpr);
    c.height = Math.round(BH * dpr);
    this.ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // ── grid DOM (built once, mutated imperatively) ──
  private buildGrid() {
    const body = this.els.gridBodyEl;
    // StrictMode double-mounts the scene: a previous controller's rows are
    // still in the DOM, and appending after them would leave this controller
    // driving invisible duplicates below the viewport mask (the visible rows
    // then never receive landings). Rebuild from a clean slate.
    body.replaceChildren();
    this.rowRefs.length = 0;
    this.nameRefs.length = 0;
    this.cellRefs.length = 0;
    body.style.willChange = "transform";
    for (let i = 0; i <= K; i++) {
      const row = document.createElement("div");
      row.style.cssText =
        `display:grid;grid-template-columns:${LABELW}px repeat(12,1fr);align-items:center;height:${ROWH}px;border-bottom:1px solid var(--line)`;
      const name = document.createElement("span");
      name.style.cssText = "font-size:12.5px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
      row.appendChild(name);
      const cells: HTMLSpanElement[] = [];
      for (let c = 0; c < 12; c++) {
        const cell = document.createElement("span");
        cell.style.cssText =
          "font-size:11px;font-family:'IBM Plex Mono',monospace;font-variant-numeric:tabular-nums;text-align:right;padding:0 1px;transition:color .4s ease,background .4s ease";
        row.appendChild(cell);
        cells.push(cell);
      }
      body.appendChild(row);
      this.rowRefs.push(row);
      this.nameRefs.push(name);
      this.cellRefs.push(cells);
    }
  }

  private seeded(s: number) {
    const key = String(s);
    if (this.seedCache[key]) return this.seedCache[key];
    const dept = this.model[((s % this.D) + this.D) % this.D];
    const vals = dept.months.map((v, m) => {
      const n = Math.sin(s * 12.9898 + m * 78.233) * 43758.5453;
      const frac = n - Math.floor(n);
      return Math.round(v * (1 + (frac - 0.5) * 0.14));
    });
    this.seedCache[key] = { dept: dept.name, vals };
    return this.seedCache[key];
  }

  private fmtK(n: number) {
    n = Math.round(n / 1000);
    return n >= 1000 ? (n / 1000).toFixed(1) + "m" : n + "k";
  }

  private renderRow(i: number) {
    const s = this.head + i;
    const isActive = i === ACTIVE;
    const isBlank = i > ACTIVE;
    const seed = this.seeded(s);
    this.nameRefs[i].textContent = seed.dept;
    this.nameRefs[i].style.opacity = isBlank ? "0.32" : "1";
    const cells = this.cellRefs[i];
    for (let c = 0; c < 12; c++) {
      let val: number, dim: boolean;
      if (isActive) { val = this.activeVals[c]; dim = val <= 0; }
      else if (isBlank) { val = 0; dim = true; }
      else { val = seed.vals[c]; dim = false; }
      cells[c].textContent = dim ? "·" : this.fmtK(val);
      cells[c].style.color = dim ? "var(--faint2)" : "var(--text)";
      cells[c].style.background = "transparent";
    }
  }

  private renderAll() {
    for (let i = 0; i <= K; i++) this.renderRow(i);
  }

  private flashActiveCell(c: number) {
    const cell = this.cellRefs[ACTIVE][c];
    cell.textContent = this.fmtK(this.activeVals[c]);
    cell.style.color = "var(--accent)";
    cell.style.background = "var(--tint)";
    if (this.flashTimers[c]) clearTimeout(this.flashTimers[c]!);
    this.flashTimers[c] = setTimeout(() => {
      cell.style.color = "var(--text)";
      cell.style.background = "transparent";
    }, 420);
  }

  /** Subtle highlight on the ledger cell a burst originates from — the
      counterpart of flashActiveCell on the landing side. Saves and restores
      the cell's own inline colour (e.g. the accent on the TOTAL column). */
  private flashOriginCell(el: HTMLElement) {
    const prev = el.dataset.kPrevColor ?? el.style.color;
    el.dataset.kPrevColor = prev;
    el.style.transition = "color .25s ease, background .25s ease";
    el.style.borderRadius = "4px";
    el.style.color = "var(--accent)";
    el.style.background = "var(--tint)";
    el.style.outline = BURST.originWall;
    el.style.outlineOffset = "-1px";
    const pending = this.originFlash.get(el);
    if (pending) clearTimeout(pending);
    this.originFlash.set(el, setTimeout(() => {
      el.style.color = prev;
      el.style.background = "transparent";
      el.style.outline = "none";
      delete el.dataset.kPrevColor;
      this.originFlash.delete(el);
    }, BURST.originFlashMs));
  }

  // ── measurement (baseline coordinate space) ──
  private toLocal(er: DOMRect) {
    const sr = this.els.sceneEl.getBoundingClientRect();
    const F = sr.width / BW || 1;
    return { x: (er.left - sr.left) / F, y: (er.top - sr.top) / F, w: er.width / F, h: er.height / F };
  }
  /** A specific ledger cell: its element (for the origin flash) plus a spawn
      point over its right-aligned figure, so tokens visibly leave that cell. */
  private ledgerCell(row: number, col: number) {
    const rowEl = this.els.ledgerBodyEl.children[row] as HTMLElement | undefined;
    const el = rowEl?.children[col] as HTMLElement | undefined;
    if (!el) return null;
    const b = this.toLocal(el.getBoundingClientRect());
    return { el, x: b.x + b.w * 0.72, y: b.y + b.h / 2 };
  }

  /** Centres of the active row's 12 month cells — measured once per burst
      instead of once per token. */
  private activeRowTargets() {
    const rowEl = this.rowRefs[ACTIVE];
    if (!rowEl) return null;
    const b = this.toLocal(rowEl.getBoundingClientRect());
    const colW = (b.w - LABELW) / 12;
    const y = b.y + b.h / 2;
    return MONTH_LABELS.map((_, c) => ({ x: b.x + LABELW + (c + 0.5) * colW, y }));
  }

  private tokenColors() {
    return this.getMode() === "dark" ? { a: "#34e0ab", b: "#5bb0ff" } : { a: "#0d7d6b", b: "#2b6fd4" };
  }

  // ── animation cycle ──
  // One cycle = a volley: 1–4 distinct ledger cells each fire a staggered
  // burst of 12–36 value tokens that seat into the active row's 12 month
  // cells. The grid scrolls only after the last token has landed.
  private cycle() {
    if (!this.alive || this.paused) return;
    this.settling = false;
    const seed = this.seeded(this.head + ACTIVE);

    // pick distinct origin cells in the position ledger — centre-weighted so
    // most volleys use a mid pack, with the extremes as occasional accents
    const nOrigins = randci(BURST.originsMin, BURST.originsMax);
    const origins: { row: number; col: number }[] = [];
    const taken = new Set<string>();
    while (origins.length < nOrigins) {
      const row = (Math.random() * this.ledgerCount) | 0;
      const col = BURST.originCols[(Math.random() * BURST.originCols.length) | 0];
      const key = row + ":" + col;
      if (!taken.has(key)) { taken.add(key); origins.push({ row, col }); }
    }

    // split each month's target across the origins (integer-conserving, so
    // the row lands exactly on seed.vals and never jumps when it scrolls up)
    const shares: number[][] = origins.map(() => new Array(12).fill(0));
    for (let c = 0; c < 12; c++) {
      const w = origins.map(() => 0.35 + Math.random());
      const sw = w.reduce((a, b) => a + b, 0);
      let left = seed.vals[c];
      origins.forEach((_, i) => {
        const part = i === origins.length - 1 ? left : Math.round((seed.vals[c] * w[i]) / sw);
        shares[i][c] = part;
        left -= part;
      });
    }

    // stagger the bursts so origins never fire in unison
    this.pendingBursts = origins.length;
    let at = 0;
    origins.forEach((o, i) => {
      this.setT(() => this.fireBurst(o, shares[i]), at);
      at += rand(BURST.burstGapMinMs, BURST.burstGapMaxMs) / BURST.speed;
    });
  }

  /** One origin cell spraying its share of the row: ≥1 token per month cell,
      launched as a loose left→right sweep. */
  private fireBurst(origin: { row: number; col: number }, share: number[]) {
    this.pendingBursts--;
    if (!this.alive || this.paused) return;
    const from = this.ledgerCell(origin.row, origin.col);
    const targets = this.activeRowTargets();
    if (!from || !targets) { this.maybeSettle(); return; }
    this.flashOriginCell(from.el);

    const tc = this.tokenColors();
    const now = performance.now();
    const spread = rand(BURST.burstSpreadMinMs, BURST.burstSpreadMaxMs) / BURST.speed;
    for (let c = 0; c < 12; c++) {
      let left = share[c];
      if (left <= 0) continue;
      const k = randi(BURST.splitsMin, BURST.splitsMax);
      for (let s = 0; s < k && left > 0; s++) {
        const amt = s === k - 1 ? left : Math.max(1, Math.round(left * rand(0.3, 0.6)));
        left -= amt;
        const tgt = targets[c];
        const mx = (from.x + tgt.x) / 2, my = (from.y + tgt.y) / 2;
        this.tokens.push({
          c, amt,
          sx: from.x + randc(-BURST.spawnJitterX, BURST.spawnJitterX),
          sy: from.y + randc(-BURST.spawnJitterY, BURST.spawnJitterY),
          cx: mx + randc(-BURST.arcJitterX / 2, BURST.arcJitterX / 2),
          cy: my + randc(-BURST.arcJitterY / 2, BURST.arcJitterY / 2),
          tx: tgt.x, ty: tgt.y,
          startAt: now + (c / 12) * spread + (s * BURST.splitLagMs + Math.random() * BURST.launchJitterMs) / BURST.speed,
          dur: randc(BURST.flightMinMs, BURST.flightMaxMs) / BURST.speed,
          text: "$" + this.fmtK(amt), col: Math.random() < 0.22 ? tc.b : tc.a, tw: 0,
        });
      }
    }
    // the paint loop parks itself when idle — wake it for this burst
    if (!this.raf) this.raf = requestAnimationFrame(this.loop);
  }

  /** Once every burst has fired and every token has landed, pause briefly,
      then advance the grid. */
  private maybeSettle() {
    if (this.settling || this.pendingBursts > 0 || this.tokens.length > 0) return;
    this.settling = true;
    this.setT(() => this.scrollStep(), rand(BURST.settleMinMs, BURST.settleMaxMs) / BURST.speed);
  }

  private scrollStep() {
    if (!this.alive || this.paused) return;
    const body = this.els.gridBodyEl;
    body.style.transition = "transform .55s cubic-bezier(.4,0,.2,1)";
    body.style.transform = `translateY(${-ROWH}px)`;
    this.setT(() => {
      this.head++;
      this.periods++;
      this.onPeriods(this.periods + K); // live status line, as in the original
      this.activeVals = new Array(12).fill(0);
      body.style.transition = "none";
      body.style.transform = "translateY(0)";
      this.renderAll();
      // occasional longer lull between volleys — an even beat reads mechanical
      const breather = Math.random() < BURST.breatherChance ? rand(BURST.breatherMinMs, BURST.breatherMaxMs) : 0;
      this.setT(() => this.cycle(), (BURST.interCycleMs + breather) / BURST.speed);
    }, 570);
  }

  // ── canvas paint (per-frame; no React work) ──
  private qb(a: number, b: number, c: number, t: number) { const u = 1 - t; return u * u * a + 2 * u * b * t + t * t * c; }
  private roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
    ctx.beginPath(); ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  private drawTokens(now: number, fade = 1) {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.clearRect(0, 0, BW, BH);
    ctx.font = "600 13px 'IBM Plex Mono', monospace";
    ctx.textBaseline = "middle";
    const dark = this.getMode() === "dark";
    for (let i = this.tokens.length - 1; i >= 0; i--) {
      const p = this.tokens[i];
      // time-based progress → identical speed on 60Hz and 144Hz displays
      const t = (now - p.startAt) / p.dur;
      if (t < 0) continue;
      if (t >= 1) {
        this.activeVals[p.c] += p.amt;
        this.flashActiveCell(p.c);
        this.tokens[i] = this.tokens[this.tokens.length - 1]; // O(1) swap-pop
        this.tokens.pop();
        continue;
      }
      const x = this.qb(p.sx, p.cx, p.tx, t), y = this.qb(p.sy, p.cy, p.ty, t);
      let a = 1;
      if (t < 0.12) a = t / 0.12; else if (t > 0.82) a = Math.max(0, (1 - t) / 0.18);
      const sc = t > 0.82 ? 0.55 + 0.45 * ((1 - t) / 0.18) : 1;
      const pt = Math.max(0, t - 0.05);
      const px = this.qb(p.sx, p.cx, p.tx, pt), py = this.qb(p.sy, p.cy, p.ty, pt);
      ctx.strokeStyle = p.col; ctx.globalAlpha = a * fade * 0.16; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(x, y); ctx.stroke();
      if (!p.tw) p.tw = ctx.measureText(p.text).width; // measured once per token
      const w = (p.tw + 15) * sc, hh = 24 * sc;
      ctx.globalAlpha = a * fade;
      ctx.fillStyle = dark ? "rgba(16,21,29,.82)" : "rgba(255,255,255,.92)";
      ctx.strokeStyle = p.col; ctx.lineWidth = 1;
      this.roundRect(ctx, x - w / 2, y - hh / 2, w, hh, 6); ctx.fill(); ctx.stroke();
      ctx.fillStyle = p.col; ctx.save(); ctx.translate(x, y); ctx.scale(sc, sc);
      ctx.textAlign = "center"; ctx.fillText(p.text, 0, 1); ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  private loop = (now: number) => {
    if (!this.alive) return;
    if (this.paused) {
      // fade-out tail after an auth pause: keep painting at dropping opacity,
      // then wipe the canvas and halt for good — zero work from then on
      if (!this.fadeAt) { this.raf = 0; return; }
      const f = 1 - (now - this.fadeAt) / Math.max(1, BURST.pauseFadeMs);
      if (f <= 0 || this.tokens.length === 0) {
        this.fadeAt = 0;
        this.tokens.length = 0;
        this.ctx?.clearRect(0, 0, BW, BH);
        this.raf = 0;
        return;
      }
      this.drawTokens(now, f);
      this.raf = requestAnimationFrame(this.loop);
      return;
    }
    this.drawTokens(now);
    if (this.tokens.length === 0) {
      // canvas is clear — park the RAF until the next burst wakes it (zero
      // per-frame work between volleys)
      this.raf = 0;
      this.maybeSettle();
      return;
    }
    this.raf = requestAnimationFrame(this.loop);
  };
}

// ────────────────────────────────────────────────────────────
// 4) BACKGROUND SCENE (React shell + imperative controller)
// ────────────────────────────────────────────────────────────

function BudgetScene({ mode, paused, onPeriods }: { mode: SceneMode; paused: boolean; onPeriods: (n: number) => void }) {
  const ledger = useMemo(buildPositions, []);
  const sceneRef = useRef<HTMLDivElement>(null);
  const ledgerBodyRef = useRef<HTMLDivElement>(null);
  const gridBodyRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ctrlRef = useRef<SceneController | null>(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const onPeriodsRef = useRef(onPeriods);
  onPeriodsRef.current = onPeriods;

  useEffect(() => {
    if (!sceneRef.current || !ledgerBodyRef.current || !gridBodyRef.current || !canvasRef.current) {
      return;
    }
    const ctrl = new SceneController(
      {
        sceneEl: sceneRef.current,
        ledgerBodyEl: ledgerBodyRef.current,
        gridBodyEl: gridBodyRef.current,
        canvasEl: canvasRef.current,
      },
      ledger.length,
      () => modeRef.current,
      (n) => onPeriodsRef.current(n)
    );
    ctrlRef.current = ctrl;
    ctrl.start();
    return () => { ctrl.stop(); ctrlRef.current = null; };
  }, [ledger.length]);

  // Pause/stop the loop the moment auth starts (before unmount) → zero CPU.
  useEffect(() => { ctrlRef.current?.setPaused(paused); }, [paused]);

  return (
    <div
      ref={sceneRef}
      aria-hidden
      style={{
        position: "absolute", left: "50%", top: "50%", width: BW, height: BH,
        transform: "translate(-50%,-50%) scale(1)", transformOrigin: "center center", zIndex: 1,
      }}
    >
      {/* position ledger, top-left (static) */}
      <div
        style={{
          position: "absolute", top: 66, left: 60, width: 600, opacity: 0.5,
          filter: "blur(1.5px)", // backgrounded depth-of-field, as in the original design
          WebkitMaskImage: "radial-gradient(150% 140% at 6% 6%,#000 42%,transparent 90%)",
          maskImage: "radial-gradient(150% 140% at 6% 6%,#000 42%,transparent 90%)",
        }}
      >
        <div style={{ fontSize: 12, fontWeight: 600, letterSpacing: ".16em", color: "var(--muted)", marginBottom: 12, fontFamily: "'IBM Plex Mono',monospace" }}>
          POSITION LEDGER · ANNUAL COMPENSATION
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1.5fr .9fr .9fr .95fr .55fr .95fr", fontFamily: "'IBM Plex Mono',monospace", fontSize: 10.5, borderBottom: "1px solid var(--line)", paddingBottom: 8, marginBottom: 2, color: "var(--muted)", letterSpacing: ".05em" }}>
          <span>POSITION</span><span style={{ textAlign: "right" }}>BASE</span><span style={{ textAlign: "right" }}>BONUS</span>
          <span style={{ textAlign: "right" }}>BENEFITS</span><span style={{ textAlign: "right" }}>PTO</span><span style={{ textAlign: "right" }}>TOTAL</span>
        </div>
        <div ref={ledgerBodyRef}>
          {ledger.map((e, i) => (
            <div key={i} style={{ display: "grid", gridTemplateColumns: "1.5fr .9fr .9fr .95fr .55fr .95fr", fontFamily: "'IBM Plex Mono',monospace", fontSize: 12, padding: "6px 0", borderBottom: "1px solid var(--line)" }}>
              <span style={{ fontFamily: "Inter,sans-serif" }}>{e.name}</span>
              <span style={{ textAlign: "right" }}>{e.base}</span>
              <span style={{ textAlign: "right", opacity: 0.75 }}>{e.bonus}</span>
              <span style={{ textAlign: "right", opacity: 0.75 }}>{e.benefits}</span>
              <span style={{ textAlign: "right", opacity: 0.6 }}>{e.pto}</span>
              <span style={{ textAlign: "right", color: "var(--accent)" }}>{e.total}</span>
            </div>
          ))}
        </div>
      </div>

      {/* monthly budget grid ticker, right side — opacity kept equal to the
          position ledger above so both tables read at the same lightness */}
      <div style={{ position: "absolute", bottom: 210, right: 60, width: 900, opacity: 0.5, filter: "blur(0.6px)" }}>
        <div style={{ fontSize: 12, fontWeight: 600, letterSpacing: ".16em", color: "var(--muted)", marginBottom: 12, fontFamily: "'IBM Plex Mono',monospace", textAlign: "right" }}>
          MONTHLY BUDGET GRID · USD
        </div>
        <div style={{ display: "grid", gridTemplateColumns: `${LABELW}px repeat(12, 1fr)`, borderBottom: "1px solid var(--line)", paddingBottom: 7, marginBottom: 4 }}>
          <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: ".05em", color: "var(--muted)" }}>DEPARTMENT</span>
          {MONTH_LABELS.map((label, i) => (
            <span key={i} style={{ fontSize: 10, fontWeight: 600, color: "var(--muted)", textAlign: "right", fontFamily: "'IBM Plex Mono',monospace" }}>{label}</span>
          ))}
        </div>
        <div style={{
          height: K * ROWH, overflow: "hidden",
          WebkitMaskImage: "linear-gradient(180deg,transparent 0,#000 24%,#000 92%,transparent 100%)",
          maskImage: "linear-gradient(180deg,transparent 0,#000 24%,#000 92%,transparent 100%)",
        }}>
          <div ref={gridBodyRef} />
        </div>
      </div>

      {/* flying tokens (baseline coordinate space) */}
      <canvas ref={canvasRef} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 2 }} />
    </div>
  );
}

// ────────────────────────────────────────────────────────────
// 5) AUTH HOOK (unchanged behaviour)
// ────────────────────────────────────────────────────────────

type AuthState = {
  initialized: boolean;
  loading: boolean;
  isAuthenticated: boolean;
  user: any | null;
  error: string | null;
};

function useIpcAuth() {
  const [state, setState] = useState<AuthState>({
    initialized: false, loading: false, isAuthenticated: false, user: null, error: null,
  });

  useEffect(() => {
    let mounted = true;
    const check = async () => {
      try {
        if (!window.authApi) {
          if (mounted) {
            setState((s) => ({
              ...s, initialized: true,
              error: s.error ?? "Auth bridge unavailable. Please ensure preload exposes window.authApi.",
            }));
          }
          return;
        }
        const status = await window.authApi.getStatus();
        if (!mounted) return;
        const authed = status.securityLevel >= 2;
        setState((s) => ({
          ...s, isAuthenticated: authed,
          user: authed ? { securityLevel: status.securityLevel } : null, initialized: true,
        }));
      } catch {
        if (mounted) {
          setState((s) => ({ ...s, initialized: true, error: "Failed to check authentication status. Please try again." }));
        }
      }
    };
    void check();
    return () => { mounted = false; };
  }, []);

  const clearError = useCallback(() => setState((s) => ({ ...s, error: null })), []);
  const cancelLogin = useCallback(() => setState((s) => ({ ...s, loading: false, error: null })), []);

  return { ...state, clearError, cancelLogin };
}

// ────────────────────────────────────────────────────────────
// 6) MAIN COMPONENT
// ────────────────────────────────────────────────────────────

export default function Landing() {
  const navigate = useNavigate();
  const theme = useTheme();
  const mode = theme.palette.mode as SceneMode;
  const v = sceneVars(mode);

  const themeMode = useSettingsStore((s) => s.themeMode);
  const toggleTheme = useSettingsStore((s) => s.toggleTheme);

  const { initialized, loading, isAuthenticated, user, error, clearError } = useIpcAuth();

  const [msVerifying, setMsVerifying] = useState(false);
  const [msError, setMsError] = useState<string | null>(null);

  // The scene must stop the instant an auth action starts (broker popup /
  // navigation) so it burns zero CPU behind the loading overlay, and it fully
  // unloads when SessionGate unmounts this page on navigation.
  const authBusy = loading || msVerifying || isAuthenticated;

  const runMicrosoftEntrance = useCallback(
    async (target: "/login" | "/register") => {
      if (!window.authApi) {
        setMsError("Auth bridge unavailable. Please restart the app.");
        return;
      }
      setMsError(null);
      setMsVerifying(true);
      try {
        const { email } = await window.authApi.beginMicrosoftSignIn();
        navigate(target, { state: { msEmail: email } });
      } catch (err) {
        const code = brokerErrorCode(err);
        if (code !== "cancelled") {
          setMsError(
            code ? describeBrokerError(code)
              : err instanceof Error ? err.message : "Marriott SSO sign-in failed."
          );
        }
      } finally {
        setMsVerifying(false);
      }
    },
    [navigate]
  );

  useEffect(() => {
    if (isAuthenticated && user) {
      // long enough for the shell's .5s "opening workspace" fade to play
      const t = setTimeout(() => navigate(REDIRECT_AFTER_LOGIN, { replace: true }), 450);
      return () => clearTimeout(t);
    }
  }, [isAuthenticated, user, navigate]);

  const busy = loading || msVerifying;

  // CSS custom properties power both the scene and the foreground chrome.
  const rootVars = {
    "--bg": v.bg, "--panel": v.panel, "--text": v.text, "--muted": v.muted,
    "--faint2": v.faint2, "--line": v.line, "--accent": v.accent, "--accent2": v.accent2,
    "--tint": v.tint, "--scrim": v.scrim, "--accentText": v.accentText,
  } as React.CSSProperties;

  return (
    <Box
      sx={{
        position: "fixed", inset: 0, overflow: "hidden", userSelect: "none",
        fontFamily: "Inter, system-ui, sans-serif", color: "var(--text)", background: "var(--bg)",
        "@keyframes kUp": { from: { opacity: 0, transform: "translateY(14px)" }, to: { opacity: 1, transform: "none" } },
        "@keyframes kFade": { from: { opacity: 0 }, to: { opacity: 1 } },
        "@keyframes kBlink": { "0%,100%": { opacity: 1 }, "50%": { opacity: 0.25 } },
        "@keyframes kSpin": { to: { transform: "rotate(360deg)" } },
        // "opening workspace" exit, as in the original design: the whole shell
        // fades and eases up a touch while we hand over to the app
        transition: "opacity .5s ease, transform .5s ease",
        opacity: isAuthenticated ? 0 : 1,
        transform: isAuthenticated ? "scale(1.015)" : "none",
      }}
      style={rootVars}
    >
      {/* background animated scene */}
      <BudgetScene mode={mode} paused={authBusy} onPeriods={() => {}} />
      {/* center scrim (viewport-fixed) */}
      <Box sx={{ position: "absolute", inset: 0, zIndex: 3, pointerEvents: "none", background: "radial-gradient(ellipse 34% 42% at 50% 50%, var(--scrim) 0%, var(--scrim) 46%, transparent 78%)" }} />
      {/* top bar */}
      <Box sx={{ position: "absolute", top: 26, left: 34, right: 34, display: "flex", alignItems: "center", justifyContent: "flex-end", zIndex: 6, animation: "kFade .7s ease both" }}>
        <Button
          onClick={() => void toggleTheme()}
          aria-label="Toggle theme"
          sx={{
            minWidth: 0, width: 34, height: 34, p: 0, borderRadius: "9px",
            border: "1px solid var(--line)", background: "var(--panel)", color: "var(--muted)",
            "&:hover": { color: "var(--text)", borderColor: "var(--text)", background: "var(--panel)" },
          }}
        >
          {themeMode === "light" ? <DarkModeIcon sx={{ fontSize: 16 }} /> : <LightModeIcon sx={{ fontSize: 16 }} />}
        </Button>
      </Box>
      {/* center brand + auth */}
      <Box sx={{ position: "absolute", inset: 0, zIndex: 5, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", px: 3, pointerEvents: "none" }}>
        {/* ring logo */}
        <KairosMark
          size={60}
          sx={{ mb: "22px", animation: "kUp .9s cubic-bezier(.2,.7,.2,1) both", animationDelay: ".05s" }}
        />

        <Box sx={{ fontSize: 64, fontWeight: 800, letterSpacing: "-.03em", lineHeight: 1, animation: "kUp .9s cubic-bezier(.2,.7,.2,1) both", animationDelay: ".15s" }}>
          Kairos
        </Box>
        <Box sx={{ mt: "13px", fontSize: 12, fontWeight: 600, letterSpacing: ".32em", color: "var(--muted)", animation: "kUp .9s cubic-bezier(.2,.7,.2,1) both", animationDelay: ".28s" }}>
          PAYROLL&nbsp;&nbsp;SPREAD&nbsp;&nbsp;TOOL
        </Box>

        {/* alerts */}
        <Box sx={{ pointerEvents: "auto", width: "100%", maxWidth: 380, mt: 3 }}>
          {!!error && (
            <Alert severity="error" onClose={clearError} sx={{ mb: 1.5, borderRadius: 3, textAlign: "left" }} aria-live="assertive">
              {error}
            </Alert>
          )}
          {!!msError && (
            <Alert severity="error" onClose={() => setMsError(null)} sx={{ mb: 1.5, borderRadius: 3, textAlign: "left" }} aria-live="assertive">
              {msError}
            </Alert>
          )}
        </Box>

        {/* auth actions */}
        <Box sx={{ mt: "34px", display: "flex", flexDirection: "column", alignItems: "center", gap: "13px", pointerEvents: "auto", animation: "kUp 1s cubic-bezier(.2,.7,.2,1) both", animationDelay: ".5s" }}>
          {!isAuthenticated ? (
            <>
              <Button
                onClick={() => runMicrosoftEntrance("/login")}
                disabled={busy}
                startIcon={busy ? <CircularProgress size={14} sx={{ color: "var(--accentText)" }} /> : <LoginIcon sx={{ fontSize: 18 }} />}
                sx={{
                  textTransform: "none", px: "46px", py: "14px", borderRadius: "11px",
                  background: "var(--accent)", color: "var(--accentText)", fontSize: 15, fontWeight: 600,
                  boxShadow: "0 10px 34px -14px var(--accent)",
                  "&:hover": { background: "var(--accent)", filter: "brightness(1.06)", transform: "translateY(-1px)" },
                  "&.Mui-disabled": { background: "var(--accent)", color: "var(--accentText)", opacity: 0.7 },
                }}
              >
                {busy ? "Verifying with Marriott SSO…" : "Sign in with Marriott SSO"}
              </Button>
              <Button
                onClick={() => runMicrosoftEntrance("/register")}
                disabled={busy}
                startIcon={<PersonAddAltRoundedIcon sx={{ fontSize: 18 }} />}
                sx={{
                  textTransform: "none", px: "28px", py: "11px", borderRadius: "11px", fontSize: 13.5, fontWeight: 600,
                  color: "var(--text)", background: "var(--panel)", border: "1px solid var(--line)",
                  "&:hover": { background: "var(--panel)", borderColor: "var(--text)" },
                }}
              >
                Register with Marriott SSO
              </Button>
            </>
          ) : (
            <Button
              onClick={() => navigate(REDIRECT_AFTER_LOGIN)}
              sx={{
                textTransform: "none", px: "46px", py: "14px", borderRadius: "11px",
                background: "var(--accent)", color: "var(--accentText)", fontSize: 15, fontWeight: 600,
                "&:hover": { background: "var(--accent)", filter: "brightness(1.06)" },
              }}
            >
              Enter Application
            </Button>
          )}

          <Box sx={{ display: "flex", alignItems: "center", gap: "10px", fontSize: 12.5, color: "var(--muted)" }}>
            <Link href={`mailto:${SUPPORT_EMAIL}`} sx={{ color: "var(--muted)", textDecoration: "none", "&:hover": { color: "var(--text)" } }}>
              Contact support
            </Link>
            <Box component="span" sx={{ opacity: 0.35 }}>·</Box>
            <Box component="span" sx={{ color: "var(--muted)" }}>Marriott SSO · Device-linked</Box>
          </Box>
        </Box>
      </Box>
      {/* footer */}
      <Box sx={{ position: "absolute", bottom: 22, left: 34, right: 34, display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 10.5, color: "var(--muted)", fontFamily: "'IBM Plex Mono',monospace", zIndex: 5, animation: "kFade .9s ease both", animationDelay: ".6s" }}>
        <span>Kairos PBT · v{__APP_VERSION__}</span>
        <Box component="span" sx={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <span>Made by EMEA FR&amp;A</span>
          <Box component="span" sx={{ opacity: 0.4 }}>·</Box>
          <span>Local-first · Secure by design</span>
        </Box>
      </Box>
      {/* initial connection overlay (kept minimal; scene is paused meanwhile) */}
      {!initialized && (
        <Box role="status" aria-live="polite" sx={{ position: "fixed", inset: 0, display: "grid", placeItems: "center", background: alpha(mode === "dark" ? "#000000" : "#ffffff", 0.4), backdropFilter: "blur(8px)", zIndex: 9999 }}>
          <Stack spacing={2} sx={{
            alignItems: "center"
          }}>
            <CircularProgress size={40} thickness={3} sx={{ color: "var(--accent)" }} />
            <Typography variant="body2" sx={{ color: "var(--text)" }}>Initializing secure connection…</Typography>
          </Stack>
        </Box>
      )}
    </Box>
  );
}
