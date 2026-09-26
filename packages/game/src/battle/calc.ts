import { CONTENT } from "../content/index.ts";
import type { TypeKey } from "../content/schema.ts";
import type { Battler } from "./types.ts";

export function stageMult(stage: number): number {
  return stage >= 0 ? (2 + stage) / 2 : 2 / (2 - stage);
}

export function accStageMult(stage: number): number {
  const s = Math.max(-6, Math.min(6, stage));
  return s >= 0 ? (3 + s) / 3 : 3 / (3 - s);
}

const CRIT_RATES = [1 / 24, 1 / 8, 1 / 2, 1];
export function critRate(stage: number): number {
  return CRIT_RATES[Math.max(0, Math.min(3, stage))]!;
}

export function typeMult(attack: TypeKey, defenders: readonly TypeKey[], opts?: { scrappy?: boolean }): number {
  let mult = 1;
  for (const d of defenders) {
    let m = CONTENT.typeChart[attack][d];
    if (m === 0 && opts?.scrappy && d === "ghost" && (attack === "normal" || attack === "fighting")) m = 1;
    mult *= m;
  }
  return mult;
}

/** 1 + 0.2n style additive stacking used for adjacent boosters. */
export function stackAdd(per: number, n: number): number {
  return 1 + per * n;
}

/** per^n by repeated multiplication (Math.pow is not guaranteed bit-identical across engines). */
export function stackMul(per: number, n: number): number {
  let v = 1;
  for (let i = 0; i < n; i++) v *= per;
  return v;
}

export function count(b: Battler, item: string): number {
  return b.items.counts.get(item) ?? 0;
}

export function hasType(b: Battler, type: TypeKey): boolean {
  return b.types.includes(type);
}

export function isGrounded(b: Battler): boolean {
  const balloon = (b.items.uses.get("AIR_BALLOON") ?? 0) > 0;
  return !b.types.includes("flying") && b.ability !== "LEVITATE" && !balloon;
}

/** Z-move power by the base move's power (mainline conversion table). */
export function zPower(base: number): number {
  if (base <= 55) return 100;
  if (base <= 65) return 120;
  if (base <= 75) return 140;
  if (base <= 85) return 160;
  if (base <= 95) return 175;
  if (base <= 100) return 180;
  if (base <= 110) return 185;
  if (base <= 125) return 190;
  if (base <= 130) return 195;
  return 200;
}

/** Max-move power by the base move's power (mainline conversion table). */
export function maxPower(base: number, type: TypeKey): number {
  const weak = type === "fighting" || type === "poison";
  const table = weak ? [70, 75, 80, 85, 90, 95, 100] : [90, 100, 110, 120, 130, 140, 150];
  if (base <= 40) return table[0]!;
  if (base <= 50) return table[1]!;
  if (base <= 60) return table[2]!;
  if (base <= 70) return table[3]!;
  if (base <= 100) return table[4]!;
  if (base <= 140) return table[5]!;
  return table[6]!;
}
