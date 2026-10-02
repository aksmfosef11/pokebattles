import { CONTENT } from "../content/index.ts";
import type { MoveDef, StageStat } from "../content/schema.ts";
import { count, typeMult } from "./calc.ts";
import type { BattleSim } from "./sim.ts";
import type { Battler, ResolvedMove } from "./types.ts";

/**
 * Move choice modelled on PokéRogue's trainer AI: every usable move gets a benefit score against
 * its prospective targets, the best one is used, and 10% of the time the runner-up is (luck).
 */
export function chooseMove(sim: BattleSim, b: Battler): string {
  const vest = count(b, "ASSAULT_VEST") > 0;
  const open = b.moves.filter((m) => {
    if (!m.enabled || m.pp <= 0 || !CONTENT.moves[m.key]) return false;
    if (b.disabledMove && b.disabledMove.key === m.key && sim.tick < b.disabledMove.until) return false;
    if (vest && CONTENT.moves[m.key]!.category === "status") return false;
    return true;
  });
  // A Choice lock holds while its move can be used (out of PP or sealed, the Pokémon falls back on the rest).
  const locked = b.choiceLock && !b.dynamax ? open.filter((m) => m.key === b.choiceLock) : [];
  const usable = locked.length > 0 ? locked : open;
  if (usable.length === 0) return "STRUGGLE";
  const scored = usable
    .map((m, i) => ({ key: m.key, i, score: scoreMove(sim, b, m.key) }))
    .sort((x, y) => y.score - x.score || x.i - y.i);
  const second = scored[1];
  if (second && second.score > 0 && sim.rng.chance(0.1)) return second.key;
  return scored[0]!.key;
}

function stageRoom(b: Battler, stat: StageStat, delta: number): number {
  const cur = b.stages[stat];
  return delta > 0 ? Math.max(0, Math.min(delta, 6 - cur)) : Math.max(0, Math.min(-delta, cur + 6));
}

export function scoreMove(sim: BattleSim, b: Battler, key: string): number {
  const move = sim.resolveMove(b, key);
  const targets = sim.resolveTargets(b, move, true);
  if (move.category !== "status") return scoreAttack(sim, b, move, targets);
  return scoreStatus(sim, b, move, targets);
}

function scoreAttack(sim: BattleSim, b: Battler, move: ResolvedMove, targets: Battler[]): number {
  if (move.effects.some((e) => e.kind === "fakeOut") && b.actions > 1) return 0;
  const { type, boosted } = sim.moveType(b, move);
  const spread = targets.length > 1;
  let score = 0;
  for (const t of targets) {
    const eff = typeMult(type, t.types, { scrappy: b.ability === "SCRAPPY" });
    if (eff === 0) continue;
    let est: number;
    if (move.effects.some((e) => e.kind === "ohko")) {
      est = t.level > b.level ? 0 : t.hp * ((30 + Math.max(0, b.level - t.level)) / 100);
    } else {
      est = sim.computeDamage(b, t, move, type, boosted, { spread, crit: false, eff, roll: 92, estimate: true });
      const mh = move.effects.find((e) => e.kind === "multiHit");
      if (mh && mh.kind === "multiHit") est *= b.ability === "SKILL_LINK" ? mh.max : (mh.min + mh.max) / 2;
    }
    const acc = move.accuracy === null ? 1 : Math.min(1, move.accuracy / 100);
    let value = Math.min(1, est / Math.max(1, t.hp));
    if (est >= t.hp) value += 0.5;
    value *= acc;
    if (t.side === b.side) score -= value * 1.2;
    else score += value;
  }
  for (const e of move.effects) {
    if (e.kind === "recharge" && sim.sides[b.side].champion !== "lance") score *= 0.8;
    if (e.kind === "selfFaint") score *= b.hp * 3 < b.maxHp ? 1 : 0.2;
    if (e.kind === "charge" && !(e.skipIn && sim.weather() === e.skipIn)) score *= 0.55;
    if (e.kind === "recoil") score *= 0.95;
    if ((e.kind === "status" || e.kind === "flinch" || e.kind === "confuse") && !("self" in e && e.self)) {
      score += 0.1 * sim.effectChance(b, e.chance);
    }
  }
  return score;
}

function scoreStatus(sim: BattleSim, b: Battler, move: MoveDef, targets: Battler[]): number {
  const foes = targets.filter((t) => t.side !== b.side);
  const hpRatio = b.hp / b.maxHp;
  let score = 0;
  for (const e of move.effects) {
    switch (e.kind) {
      case "status":
        for (const t of foes) {
          if (t.status) continue;
          if (e.status === "slp") score += 0.6;
          else if (e.status === "par") score += sim.effSpeed(t) > sim.effSpeed(b) ? 0.45 : 0.25;
          else if (e.status === "brn") score += t.stats.atk > t.stats.spa ? 0.45 : 0.2;
          else if (e.status === "tox" || e.status === "psn") score += t.types.includes("poison") || t.types.includes("steel") ? 0 : 0.4;
          else score += 0.3;
        }
        break;
      case "confuse":
        for (const t of foes) if (t.confusion === 0) score += 0.3;
        break;
      case "stages": {
        if (e.target === "target") {
          for (const t of foes) for (const s of e.stats) score += 0.12 * stageRoom(t, s, e.delta);
        } else {
          if (hpRatio < 0.5) break;
          const who = e.target === "allies" ? sim.alliesOf(b, true) : [b];
          for (const w of who) for (const s of e.stats) score += (w.stages[s] >= 4 ? 0 : 0.15) * stageRoom(w, s, e.delta);
        }
        break;
      }
      case "heal":
        if (move.target === "allySide") {
          // Team heal (Life Dew): worth using when the allies on its side are hurt, not only the user.
          let team = 0;
          for (const a of targets) if (a.hp / a.maxHp < 0.5) team += (1 - a.hp / a.maxHp) * 1.2;
          score += Math.min(1.5, team);
        } else if (hpRatio < 0.5) score += (1 - hpRatio) * 1.2;
        break;
      case "rest":
        if (hpRatio < 0.35) score += 0.9;
        break;
      case "weather":
        if (sim.weather() !== e.weather) score += 0.35;
        break;
      case "terrain":
        if (sim.field.terrain !== e.terrain) score += 0.3;
        break;
      case "protect":
        if (b.protectChain === 0 && hpRatio < 0.5) score += 0.25;
        break;
      case "leechSeed":
        for (const t of foes) if (t.leechSeedBy === null && !t.types.includes("grass")) score += 0.35;
        break;
      case "screen": {
        const s = sim.sides[b.side].screens;
        if (s[e.screen] === 0) score += 0.4;
        break;
      }
      case "tailwind":
        if (sim.sides[b.side].tailwind === 0) score += 0.4;
        break;
      case "focusEnergy":
        if (b.critStage < 2) score += 0.25;
        break;
      case "bellyDrum":
        if (hpRatio > 0.6 && b.stages.atk < 2) score += 0.8;
        break;
      case "haze": {
        let foeBoosts = 0;
        for (const f of sim.enemiesOf(b)) for (const k of ["atk", "spa", "spe"] as const) foeBoosts += Math.max(0, f.stages[k]);
        score += 0.1 * foeBoosts;
        break;
      }
      case "cureTeam":
        score += 0.25 * sim.alliesOf(b, true).filter((a) => a.status).length;
        break;
      case "metronome":
        score += 0.45;
        break;
      case "transform":
        if (!b.transformedFrom) score += 0.6;
        break;
    }
  }
  return score;
}
