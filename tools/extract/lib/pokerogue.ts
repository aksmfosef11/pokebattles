/**
 * Extracts game data from PokéRogue's TypeScript source by walking its AST (never executing it).
 */
import fs from "node:fs";
import path from "node:path";
import {
  type ChainCall,
  EnumRegistry,
  type Ev,
  Evaluator,
  findAll,
  findClass,
  findFunction,
  type Json,
  leadingComments,
  newExprClass,
  objectProps,
  parseFile,
  parseText,
  rawText,
  relPos,
  ts,
  unwindChain,
  unwrap,
} from "./ts-eval.ts";
import { listFilesRecursive } from "./util.ts";

// #region Report

export interface Unparseable {
  where: string;
  what: string;
  text: string;
}

export class Report {
  unparseable: Unparseable[] = [];
  warnings: string[] = [];
  notes: string[] = [];
  unknownMoveCalls = new Map<string, number>();
  unknownAbilityCalls = new Map<string, number>();

  bad(where: string, what: string, node?: ts.Node | string): void {
    const text = typeof node === "string" ? node : node ? rawText(node).slice(0, 400) : "";
    this.unparseable.push({ where, what, text });
  }
  warn(msg: string): void {
    this.warnings.push(msg);
  }
}

// #endregion

// #region Context

export interface Ctx {
  root: string; // vendor/pokerogue
  src: string; // vendor/pokerogue/src
  enums: EnumRegistry;
  ev: Evaluator;
  constants: Map<string, number | string | boolean>;
  report: Report;
}

function findSrcFile(src: string, rel: string, grepFallback: RegExp): string {
  const direct = path.join(src, rel);
  if (fs.existsSync(direct)) return direct;
  // File locations move between PokéRogue versions: fall back to a content search.
  for (const f of listFilesRecursive(src)) {
    if (!f.endsWith(".ts")) continue;
    if (grepFallback.test(fs.readFileSync(f, "utf8"))) return f;
  }
  throw new Error(`Could not locate ${rel} (pattern ${grepFallback})`);
}

export function createContext(pokerogueDir: string): Ctx {
  const src = path.join(pokerogueDir, "src");
  const report = new Report();
  const enums = new EnumRegistry();
  const files = listFilesRecursive(src).filter(f => f.endsWith(".ts") && !f.endsWith(".d.ts"));
  // enums/ first so cross-file enum initializers resolve, then everything else that declares an enum-like.
  const enumDir = path.join(src, "enums") + path.sep;
  const ordered = [...files.filter(f => f.startsWith(enumDir)), ...files.filter(f => !f.startsWith(enumDir))];
  const enumRe = /\benum\s+[A-Z]\w*\s*\{|\bconst\s+[A-Z]\w*\s*=\s*\{/;
  for (const f of ordered) {
    const text = fs.readFileSync(f, "utf8");
    if (!enumRe.test(text)) continue;
    enums.addSourceFile(parseFile(f));
  }
  for (const d of enums.duplicates) report.notes.push(`duplicate enum-like name ignored: ${d}`);

  // Literal constants (EVOLVE_MOVE, RELEARN_MOVE, ...)
  const constants = new Map<string, number | string | boolean>();
  const constFile = findSrcFile(src, "constants.ts", /export const RELEARN_MOVE\s*=/);
  for (const stmt of parseFile(constFile).statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const d of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || !d.initializer) continue;
      const init = unwrap(d.initializer);
      if (ts.isNumericLiteral(init)) constants.set(d.name.text, Number(init.text));
      else if (ts.isPrefixUnaryExpression(init) && ts.isNumericLiteral(init.operand))
        constants.set(d.name.text, init.operator === ts.SyntaxKind.MinusToken ? -Number(init.operand.text) : Number(init.operand.text));
      else if (ts.isStringLiteral(init)) constants.set(d.name.text, init.text);
      else if (init.kind === ts.SyntaxKind.TrueKeyword) constants.set(d.name.text, true);
      else if (init.kind === ts.SyntaxKind.FalseKeyword) constants.set(d.name.text, false);
    }
  }
  const ev = new Evaluator(enums, { constants });
  return { root: pokerogueDir, src, enums, ev, constants, report };
}

const lower = (s: string | null | undefined) => (s == null ? null : s.toLowerCase());

// #endregion

// #region Moves

export interface AttrOut {
  name: string;
  args: Json[];
  argKinds: string[];
  implicit?: true;
  condition?: string;
}

export interface MoveOut {
  /** MoveId value (null for G-Max moves, which have no MoveId member) */
  id: number | null;
  key: string;
  class: string;
  type: string;
  category: string;
  power: number | null;
  accuracy: number | null;
  pp: number;
  chance: number | null;
  priority: number;
  generation: number;
  target: string;
  flags: string[];
  attrs: AttrOut[];
  chargeAttrs?: AttrOut[];
  conditions?: { raw: string; sequence: number | null }[];
  restrictions?: string[];
  chargeText?: string;
  /** PokéRogue wraps these in `Unused` comments (Z-moves, Max moves, ...). */
  unused?: true;
  otherCalls?: { name: string; args: Json[] }[];
}

interface MoveClassInfo {
  /** Move-ctor param name -> resolver from the subclass `new` args */
  resolve(newArgs: readonly ts.Expression[]): Map<string, ts.Expression | undefined>;
  implicitAttrs: { whenType: string; attr: AttrOut }[];
}

const MARKER_ORDER = ["condition", "restriction", "targetsAllyDefault", "edgeCase", "partial", "unimplemented"];

export function extractMoves(ctx: Ctx): { moves: MoveOut[]; gmax: MoveOut[]; flagOrder: string[] } {
  const { ev, enums, report } = ctx;
  const file = findSrcFile(ctx.src, "data/moves/move.ts", /export function initMoves\(/);
  const sf = parseFile(file);

  // --- Move base class: ctor param names, default flags, builder -> flag map
  const moveClass = findClass(sf, "Move");
  if (!moveClass) throw new Error("Move class not found");
  const moveCtor = moveClass.members.find(ts.isConstructorDeclaration)!;
  const moveParams = moveCtor.parameters.map(p => p.name.getText(sf));

  const flagBits = enums.get("MoveFlags");
  if (!flagBits) throw new Error("MoveFlags enum not found");
  const bitName = new Map<number, string>(); // bit -> output flag name
  const builderFlag = new Map<string, { flag: string; param?: string; paramDefault?: boolean }>();
  for (const m of moveClass.members) {
    if (!ts.isMethodDeclaration(m) || !m.body || !ts.isIdentifier(m.name)) continue;
    const method = m.name.text;
    for (const call of findAll(m.body, ts.isCallExpression)) {
      if (!ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== "setFlag") continue;
      const ref = ev.enumRef(call.arguments[0]);
      if (!ref || ref.enum !== "MoveFlags") continue;
      const on = call.arguments[1];
      if (on && ts.isIdentifier(on)) {
        const p = m.parameters.find(pp => pp.name.getText(sf) === on.text);
        const def = p?.initializer?.kind === ts.SyntaxKind.TrueKeyword;
        builderFlag.set(method, { flag: ref.member, param: on.text, paramDefault: def });
      } else builderFlag.set(method, { flag: ref.member });
      if (!bitName.has(ref.value as number)) bitName.set(ref.value as number, method);
    }
  }
  const flagOrder: string[] = [];
  for (const [member, value] of flagBits.members) {
    if (value === 0) continue;
    if (!bitName.has(value as number)) bitName.set(value as number, member.toLowerCase());
    flagOrder.push(bitName.get(value as number)!);
  }

  // Default flags set in the Move constructor: `if (<param> === Enum.X) this.setFlag(MoveFlags.Y, true)`
  const ctorDefaults: { param: string; member: string; flag: string }[] = [];
  for (const ifs of findAll(moveCtor.body!, ts.isIfStatement)) {
    const c = ifs.expression;
    if (!ts.isBinaryExpression(c) || c.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken) continue;
    if (!ts.isIdentifier(c.left)) continue;
    const ref = ev.enumRef(c.right);
    if (!ref) continue;
    for (const call of findAll(ifs.thenStatement, ts.isCallExpression)) {
      if (!ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== "setFlag") continue;
      const fl = ev.enumRef(call.arguments[0]);
      if (fl) ctorDefaults.push({ param: c.left.text, member: ref.member, flag: fl.member });
    }
  }
  if (ctorDefaults.length === 0) report.warn("No default move flags found in Move constructor (makesContact defaults may be wrong)");

  // --- Subclass constructors -> Move ctor params
  const classInfo = new Map<string, MoveClassInfo>();
  const buildClassInfo = (name: string): MoveClassInfo | undefined => {
    if (classInfo.has(name)) return classInfo.get(name);
    const cls = findClass(sf, name);
    if (!cls) return undefined;
    const heritage = cls.heritageClauses?.[0]?.types[0]?.expression;
    let info: MoveClassInfo | undefined;
    const ctor = cls.members.find(ts.isConstructorDeclaration);
    if (!ctor && heritage && ts.isCallExpression(heritage) && ts.isIdentifier(heritage.arguments[0])) {
      // class ChargingAttackMove extends ChargeMove(AttackMove, "...") {}
      info = buildClassInfo(heritage.arguments[0].text);
    } else if (ctor?.body) {
      const params = ctor.parameters.map(p => ({ name: p.name.getText(sf), def: p.initializer }));
      const superCall = findAll(ctor.body, ts.isCallExpression).find(c => c.expression.kind === ts.SyntaxKind.SuperKeyword);
      if (!superCall) return undefined;
      const mapping = superCall.arguments.map(a => {
        if (ts.isIdentifier(a)) {
          const idx = params.findIndex(p => p.name === a.text);
          if (idx >= 0) return { idx, def: params[idx].def };
        }
        return { lit: a };
      });
      const implicitAttrs: MoveClassInfo["implicitAttrs"] = [];
      for (const ifs of findAll(ctor.body, ts.isIfStatement)) {
        const c = ifs.expression;
        if (
          ts.isBinaryExpression(c)
          && ts.isPropertyAccessExpression(c.left)
          && c.left.expression.kind === ts.SyntaxKind.ThisKeyword
          && c.left.name.text === "type"
        ) {
          const t = ev.enumRef(c.right);
          for (const call of findAll(ifs.thenStatement, ts.isCallExpression)) {
            if (!ts.isPropertyAccessExpression(call.expression)) continue;
            const mname = call.expression.name.text;
            if (mname === "addAttr" && call.arguments[0] && ts.isNewExpression(call.arguments[0])) {
              const ne = call.arguments[0];
              implicitAttrs.push({
                whenType: t!.member,
                attr: { name: ne.expression.getText(sf), ...ev.args(ne.arguments ?? []), implicit: true },
              });
            } else if (mname === "attr" && call.arguments[0]) {
              implicitAttrs.push({
                whenType: t!.member,
                attr: { name: call.arguments[0].getText(sf), ...ev.args(call.arguments.slice(1)), implicit: true },
              });
            }
          }
        }
      }
      info = {
        resolve(newArgs) {
          const out = new Map<string, ts.Expression | undefined>();
          mapping.forEach((m, i) => {
            const pname = moveParams[i];
            if ("lit" in m) out.set(pname, m.lit);
            else out.set(pname, newArgs[m.idx] ?? m.def);
          });
          return out;
        },
        implicitAttrs,
      };
    }
    if (info) classInfo.set(name, info);
    return info;
  };

  const numOr = (e: ts.Expression | undefined, where: string, what: string): number => {
    if (!e) return Number.NaN;
    const v = ev.eval(e);
    if (typeof v.value === "number") return v.value;
    report.bad(where, `${what} is not a number`, e);
    return Number.NaN;
  };

  const buildMove = (element: ts.Expression, unused: boolean, allowUnknownKey: boolean): MoveOut | undefined => {
    const where = relPos(element, ctx.root);
    const { base, calls } = unwindChain(element);
    const cls = newExprClass(base);
    if (!cls || !ts.isNewExpression(base)) {
      report.bad(where, "move element is not a `new XMove(...)` chain", element);
      return undefined;
    }
    const info = buildClassInfo(cls);
    if (!info) {
      report.bad(where, `unknown move class ${cls}`, element);
      return undefined;
    }
    const p = info.resolve(base.arguments ?? []);
    const idExpr = p.get("id");
    let key: string;
    let id: number | null;
    const idRef = ev.enumRef(idExpr);
    if (idRef && idRef.enum === "MoveId") {
      key = idRef.member;
      id = idRef.value as number;
    } else if (allowUnknownKey && idExpr && ts.isPropertyAccessExpression(idExpr)) {
      key = idExpr.name.text; // e.g. commented-out G_MAX_* moves that have no MoveId member
      id = null;
    } else {
      report.bad(where, "move id is not a MoveId member", idExpr ?? element);
      return undefined;
    }
    if (key === "NONE") return undefined; // placeholder entry (its constructor args are not meaningful)
    const typeRef = ev.enumRef(p.get("type"));
    const catRef = ev.enumRef(p.get("category"));
    const targetRef = ev.enumRef(p.get("defaultMoveTarget"));
    if (!typeRef || !catRef || !targetRef) {
      report.bad(where, `${key}: could not resolve type/category/target`, element);
      return undefined;
    }
    const power = numOr(p.get("power"), where, "power");
    const accuracy = numOr(p.get("accuracy"), where, "accuracy");
    const pp = numOr(p.get("pp"), where, "pp");
    const chance = numOr(p.get("chance"), where, "chance");
    const priority = numOr(p.get("priority"), where, "priority");
    const generation = numOr(p.get("generation"), where, "generation");

    let flags = 0;
    const setFlag = (flagMember: string, on: boolean) => {
      const bit = flagBits.members.get(flagMember) as number;
      if (on) flags |= bit;
      else flags ^= bit; // PokéRogue's setFlag(false) XORs
    };
    const paramMembers: Record<string, string> = {
      category: catRef.member,
      defaultMoveTarget: targetRef.member,
      type: typeRef.member,
    };
    for (const d of ctorDefaults) if (paramMembers[d.param] === d.member) setFlag(d.flag, true);

    const attrs: AttrOut[] = [];
    for (const ia of info.implicitAttrs) if (ia.whenType === typeRef.member) attrs.push({ ...ia.attr });
    const chargeAttrs: AttrOut[] = [];
    const conditions: { raw: string; sequence: number | null }[] = [];
    const restrictions: string[] = [];
    const markers = new Set<string>();
    const otherCalls: { name: string; args: Json[] }[] = [];
    let target = targetRef.member;
    let chargeText: string | undefined;

    for (const c of calls) {
      const bf = builderFlag.get(c.name);
      if (bf) {
        let on = true;
        if (bf.param) {
          const a = c.args[0];
          on = a ? ev.eval(a).value === true : !!bf.paramDefault;
        }
        setFlag(bf.flag, on);
        if (c.name === "affectedByGravity") {
          /* also adds a use restriction; the flag captures it */
        }
        continue;
      }
      switch (c.name) {
        case "attr":
        case "chargeAttr": {
          const [clsArg, ...rest] = c.args;
          const out: AttrOut = { name: clsArg ? clsArg.getText(sf) : "?", ...ev.args(rest) };
          (c.name === "attr" ? attrs : chargeAttrs).push(out);
          break;
        }
        case "addAttr": {
          const a = c.args[0] && unwrap(c.args[0]);
          if (a && ts.isNewExpression(a)) attrs.push({ name: a.expression.getText(sf), ...ev.args(a.arguments ?? []) });
          else {
            attrs.push({ name: "?", args: [a ? rawText(a) : ""], argKinds: ["raw"] });
            report.bad(where, `${key}: addAttr with non-new argument`, c.node);
          }
          break;
        }
        case "target": {
          const r = ev.enumRef(c.args[0]);
          if (r) target = r.member;
          else report.bad(where, `${key}: target() arg not a MoveTarget`, c.node);
          break;
        }
        case "condition": {
          const seq = c.args[1] ? ev.eval(c.args[1]).value : null;
          conditions.push({ raw: c.args[0] ? rawText(c.args[0]) : "", sequence: typeof seq === "number" ? seq : null });
          markers.add("condition");
          break;
        }
        case "restriction":
          restrictions.push(c.args.map(a => rawText(a)).join(", "));
          markers.add("restriction");
          break;
        case "edgeCase":
        case "partial":
        case "unimplemented":
        case "targetsAllyDefault":
          markers.add(c.name);
          break;
        case "chargeText":
          chargeText = c.args[0] ? rawText(c.args[0]) : "";
          break;
        default:
          otherCalls.push({ name: c.name, args: c.args.map(a => ev.eval(a).value) });
          ctx.report.unknownMoveCalls.set(c.name, (ctx.report.unknownMoveCalls.get(c.name) ?? 0) + 1);
      }
    }

    const flagList: string[] = [];
    for (const [member, value] of flagBits.members) {
      if (value === 0) continue;
      if (flags & (value as number)) flagList.push(bitName.get(value as number)!);
    }
    for (const m of MARKER_ORDER) if (markers.has(m)) flagList.push(m);

    const out: MoveOut = {
      id,
      key,
      class: cls,
      type: typeRef.member.toLowerCase(),
      category: catRef.member.toLowerCase(),
      power: power < 0 ? null : power,
      accuracy: accuracy < 0 ? null : accuracy,
      pp,
      chance: chance < 0 ? null : chance,
      priority,
      generation,
      target,
      flags: flagList,
      attrs,
    };
    if (chargeAttrs.length) out.chargeAttrs = chargeAttrs;
    if (conditions.length) out.conditions = conditions;
    if (restrictions.length) out.restrictions = restrictions;
    if (chargeText !== undefined) out.chargeText = chargeText;
    if (unused) out.unused = true;
    if (otherCalls.length) out.otherCalls = otherCalls;
    return out;
  };

  const initMoves = findFunction(sf, "initMoves");
  if (!initMoves?.body) throw new Error("initMoves() not found");
  const push = findAll(initMoves.body, ts.isCallExpression).find(
    c => ts.isPropertyAccessExpression(c.expression) && c.expression.name.text === "push",
  );
  if (!push) throw new Error("allMoves.push(...) not found in initMoves");

  const moves: MoveOut[] = [];
  let inUnused = false;
  for (const el of push.arguments) {
    for (const cmt of leadingComments(el)) {
      const hasStart = /\bUnused\b/.test(cmt.replace(/End\s+Unused/g, ""));
      const hasEnd = /End\s+Unused/.test(cmt);
      if (hasStart && !hasEnd) inUnused = true;
      else if (hasEnd && !hasStart) inUnused = false;
      // a single comment containing both = a fully commented-out block; state unchanged
    }
    const m = buildMove(el, inUnused, false);
    if (!m) continue;
    if (m.key === "NONE") continue; // placeholder entry
    moves.push(m);
  }

  // G-Max moves: commented out in both MoveId and initMoves. Parse the comment body as TS.
  const gmax: MoveOut[] = [];
  const blockRe = /\/\*\s*Unused\s*\n([\s\S]*?)End\s+Unused\s*\*\//g;
  for (const match of sf.text.matchAll(blockRe)) {
    if (!/MoveId\.G_MAX_/.test(match[1])) continue;
    const inner = parseText(`${file}#gmax`, `const __gmax = [\n${match[1]}\n];`);
    const decl = inner.statements[0] as ts.VariableStatement;
    const arr = unwrap(decl.declarationList.declarations[0].initializer!) as ts.ArrayLiteralExpression;
    for (const el of arr.elements) {
      const m = buildMove(el, true, true);
      if (m) gmax.push(m);
    }
  }

  const seen = new Set<string>();
  for (const m of moves) {
    if (seen.has(m.key)) report.warn(`duplicate move ${m.key}`);
    seen.add(m.key);
  }
  const missing = enums.memberNames("MoveId").filter(k => k !== "NONE" && !seen.has(k));
  if (missing.length) report.warn(`MoveId members with no initMoves entry: ${missing.join(", ")}`);
  moves.sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  return { moves, gmax, flagOrder };
}

// #endregion

// #region Abilities

export interface AbilityOut {
  id: number;
  key: string;
  generation: number;
  postSummonPriority: number;
  attrs: AttrOut[];
  flags: string[];
  conditions?: string[];
  unused?: true;
  otherCalls?: { name: string; args: Json[] }[];
}

export function extractAbilities(ctx: Ctx): AbilityOut[] {
  const { ev, report } = ctx;
  const file = findSrcFile(ctx.src, "data/abilities/init-abilities.ts", /export function initAbilities\(/);
  const sf = parseFile(file);
  const abilityFile = findSrcFile(ctx.src, "data/abilities/ability.ts", /export class AbBuilder\b/);
  const builder = findClass(parseFile(abilityFile), "AbBuilder");
  const flagMethods: string[] = [];
  if (builder) {
    for (const m of builder.members) {
      if (ts.isMethodDeclaration(m) && m.body && ts.isIdentifier(m.name) && /this\.flags\s*\|=/.test(m.body.getText()))
        flagMethods.push(m.name.text);
    }
  } else report.warn("AbBuilder class not found; ability flags limited to known names");
  const knownFlags = flagMethods.length
    ? flagMethods
    : ["bypassFaint", "ignorable", "unsuppressable", "uncopiable", "unreplaceable", "partial", "unimplemented"];
  const markerOrder = [...knownFlags.filter(f => f !== "partial" && f !== "unimplemented"), "condition", "edgeCase", "partial", "unimplemented"];

  const init = findFunction(sf, "initAbilities");
  if (!init?.body) throw new Error("initAbilities() not found");
  const push = findAll(init.body, ts.isCallExpression).find(
    c => ts.isPropertyAccessExpression(c.expression) && c.expression.name.text === "push",
  );
  if (!push) throw new Error("allAbilities.push(...) not found");
  const out: AbilityOut[] = [];
  let inUnused = false;
  for (const el of push.arguments) {
    for (const cmt of leadingComments(el)) {
      const hasStart = /\bUnused\b/.test(cmt.replace(/End\s+Unused/g, ""));
      const hasEnd = /End\s+Unused/.test(cmt);
      if (hasStart && !hasEnd) inUnused = true;
      else if (hasEnd && !hasStart) inUnused = false;
    }
    const where = relPos(el, ctx.root);
    const { base, calls } = unwindChain(el);
    if (!ts.isNewExpression(base) || !base.arguments?.length) {
      report.bad(where, "ability element is not `new AbBuilder(...)`", el);
      continue;
    }
    const idRef = ev.enumRef(base.arguments[0]);
    if (!idRef || idRef.enum !== "AbilityId") {
      report.bad(where, "ability id is not an AbilityId member", el);
      continue;
    }
    if (idRef.member === "NONE") continue;
    const gen = ev.eval(base.arguments[1]).value;
    const prio = base.arguments[2] ? ev.eval(base.arguments[2]).value : 0;
    const attrs: AttrOut[] = [];
    const flags = new Set<string>();
    const conditions: string[] = [];
    const otherCalls: { name: string; args: Json[] }[] = [];
    for (const c of calls) {
      if (knownFlags.includes(c.name)) {
        flags.add(c.name);
        continue;
      }
      switch (c.name) {
        case "attr": {
          const [clsArg, ...rest] = c.args;
          attrs.push({ name: clsArg?.getText(sf) ?? "?", ...ev.args(rest) });
          break;
        }
        case "conditionalAttr": {
          const [cond, clsArg, ...rest] = c.args;
          attrs.push({ name: clsArg?.getText(sf) ?? "?", ...ev.args(rest), condition: cond ? rawText(cond) : "" });
          break;
        }
        case "condition":
          conditions.push(c.args[0] ? rawText(c.args[0]) : "");
          flags.add("condition");
          break;
        case "edgeCase":
          flags.add("edgeCase");
          break;
        case "build":
          break;
        default:
          otherCalls.push({ name: c.name, args: c.args.map(a => ev.eval(a).value) });
          report.unknownAbilityCalls.set(c.name, (report.unknownAbilityCalls.get(c.name) ?? 0) + 1);
      }
    }
    const a: AbilityOut = {
      id: idRef.value as number,
      key: idRef.member,
      generation: typeof gen === "number" ? gen : Number.NaN,
      postSummonPriority: typeof prio === "number" ? prio : 0,
      attrs,
      flags: markerOrder.filter(f => flags.has(f)),
    };
    if (conditions.length) a.conditions = conditions;
    if (inUnused) a.unused = true;
    if (otherCalls.length) a.otherCalls = otherCalls;
    out.push(a);
  }
  const seen = new Set(out.map(a => a.key));
  const missing = ctx.enums.memberNames("AbilityId").filter(k => k !== "NONE" && !seen.has(k));
  if (missing.length) report.warn(`AbilityId members with no initAbilities entry: ${missing.join(", ")}`);
  out.sort((a, b) => a.id - b.id);
  return out;
}

// #endregion

// #region Species

export interface StatsOut {
  hp: number;
  atk: number;
  def: number;
  spa: number;
  spd: number;
  spe: number;
}
export interface AbilitiesOut {
  a1: string;
  a2: string | null;
  hidden: string | null;
}
export interface FormOut {
  formKey: string;
  formName: string;
  formIndex: number;
  formSpriteKey: string;
  types: string[];
  abilities: AbilitiesOut;
  baseStats: StatsOut;
  bst: number;
  height: number;
  weight: number;
  catchRate: number;
  baseFriendship: number;
  baseExp: number;
  genderDiffs: boolean;
  isStarterSelectable: boolean;
  isUnobtainable: boolean;
}
export interface SpeciesOut {
  id: number;
  nationalDex: number;
  key: string;
  generation: number;
  types: string[];
  abilities: AbilitiesOut;
  baseStats: StatsOut;
  bst: number;
  height: number;
  weight: number;
  catchRate: number;
  baseFriendship: number;
  baseExp: number;
  growthRate: string;
  malePercent: number | null;
  genderDiffs: boolean;
  isSubLegendary: boolean;
  isLegendary: boolean;
  isMythical: boolean;
  canChangeForm: boolean;
  starter: string;
  starterCost: number | null;
  eggTier: string | null;
  prevolution: string | null;
  passives: Record<string, string>;
  forms: FormOut[];
}
export interface EvolutionOut {
  to: string;
  preFormKey: string | null;
  evoFormKey: string | null;
  level: number;
  item: string | null;
  condition: string | null;
  conditionData: Json | null;
  evoDelay: Json | null;
  class: string;
}
export interface FormChangeOut {
  preFormKey: string;
  formKey: string;
  trigger: string;
  item: string | null;
  itemActive: boolean | null;
  triggerDetail: Json;
  quiet: boolean;
  conditions: string[];
  raw: string;
  /** Added at runtime by PokéRogue's SpeciesDataRegistry.initReverseFormChanges (not in source) */
  synthesized?: true;
}
export interface RawSpeciesData {
  species: SpeciesOut;
  evolutions: EvolutionOut[];
  formChanges: FormChangeOut[];
  levelMoves: [number, string][];
  formLevelMoves: Record<string, [number, string][]>;
  tms: string[];
  formTms: Record<string, string[]>;
}

function triggerShortName(cls: string): string {
  let s = cls.replace(/^SpeciesFormChange/, "").replace(/Trigger$/, "");
  if (cls === "SpeciesDefaultFormMatchTrigger") s = "DefaultFormMatch";
  if (cls === "MeloettaFormChangePostMoveTrigger") s = "MeloettaPostMove";
  return s.charAt(0).toLowerCase() + s.slice(1);
}

export function extractSpecies(ctx: Ctx): RawSpeciesData[] {
  const { ev, report } = ctx;
  const dir = path.join(ctx.src, "data/balance/species");
  let files: string[] = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith(".ts")).map(f => path.join(dir, f)) : [];
  if (!files.length) {
    files = listFilesRecursive(ctx.src).filter(f => f.endsWith(".ts") && /new PokemonSpecies\(\{/.test(fs.readFileSync(f, "utf8")));
  }
  files.sort();
  const out: RawSpeciesData[] = [];
  const byKey = new Map<string, RawSpeciesData>();

  const typeOf = (e: ts.Expression | undefined): string | null => {
    if (!e) return null;
    const r = ev.enumRef(e);
    return r ? r.member.toLowerCase() : null;
  };
  const abilityKey = (e: ts.Expression | undefined): string | null => {
    const r = ev.enumRef(e);
    if (!r) return null;
    return r.member === "NONE" ? null : r.member;
  };
  const num = (e: ts.Expression | undefined): number => {
    if (!e) return Number.NaN;
    const v = ev.eval(e).value;
    return typeof v === "number" ? v : Number.NaN;
  };
  const bool = (e: ts.Expression | undefined, def = false): boolean => {
    if (!e) return def;
    const v = ev.eval(e).value;
    return typeof v === "boolean" ? v : def;
  };
  const str = (e: ts.Expression | undefined): string | null => {
    if (!e) return null;
    const v = ev.eval(e);
    if (typeof v.value === "string") return v.value;
    if (v.kind === "null" || v.kind === "undefined") return null;
    return null;
  };
  const stats = (p: Map<string, ts.Expression>): StatsOut => ({
    hp: num(p.get("baseHp")),
    atk: num(p.get("baseAtk")),
    def: num(p.get("baseDef")),
    spa: num(p.get("baseSpatk")),
    spd: num(p.get("baseSpdef")),
    spe: num(p.get("baseSpd")),
  });
  const moveKey = (e: ts.Expression, where: string): string | null => {
    const r = ev.enumRef(e);
    if (r?.enum === "MoveId") return r.member;
    report.bad(where, "expected MoveId member", e);
    return null;
  };
  const levelMoves = (e: ts.Expression | undefined, where: string): [number, string][] => {
    const res: [number, string][] = [];
    if (!e) return res;
    const arr = unwrap(e);
    if (!ts.isArrayLiteralExpression(arr)) {
      report.bad(where, "levelMoves is not an array literal", e);
      return res;
    }
    for (const el of arr.elements) {
      const pair = unwrap(el as ts.Expression);
      if (!ts.isArrayLiteralExpression(pair) || pair.elements.length < 2) {
        report.bad(where, "levelMoves entry is not [level, move]", el);
        continue;
      }
      const lvl = ev.eval(pair.elements[0] as ts.Expression).value;
      const mv = moveKey(pair.elements[1] as ts.Expression, where);
      if (typeof lvl !== "number" || !mv) {
        report.bad(where, "levelMoves entry unresolved", el);
        continue;
      }
      res.push([lvl, mv]);
    }
    return res;
  };
  const moveList = (e: ts.Expression | undefined, where: string, selfKey: string): string[] => {
    const res: string[] = [];
    if (!e) return res;
    const arr = unwrap(e);
    if (!ts.isArrayLiteralExpression(arr)) {
      report.bad(where, `${selfKey}: move list is not an array literal`, e);
      return res;
    }
    for (const el of arr.elements) {
      if (ts.isSpreadElement(el)) {
        // `...genData[SpeciesId.X].tms.filter(tm => tm !== MoveId.A && tm !== MoveId.B)` / `...genData[SpeciesId.X].tms`
        let inner = unwrap(el.expression);
        const excluded = new Set<string>();
        let ok = true;
        if (ts.isCallExpression(inner) && ts.isPropertyAccessExpression(inner.expression) && inner.expression.name.text === "filter") {
          const fn = inner.arguments[0];
          if (fn && ts.isArrowFunction(fn) && !ts.isBlock(fn.body)) {
            const collect = (b: ts.Expression) => {
              b = unwrap(b);
              if (ts.isBinaryExpression(b) && b.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
                collect(b.left);
                collect(b.right);
              } else if (ts.isBinaryExpression(b) && b.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken) {
                const r = ev.enumRef(b.right) ?? ev.enumRef(b.left);
                if (r?.enum === "MoveId") excluded.add(r.member);
                else ok = false;
              } else ok = false;
            };
            collect(fn.body);
          } else ok = false;
          inner = unwrap(inner.expression.expression);
        }
        let refKey: string | undefined;
        let refProp: string | undefined;
        if (ts.isPropertyAccessExpression(inner) && ts.isElementAccessExpression(inner.expression)) {
          refProp = inner.name.text;
          refKey = ev.enumRef(inner.expression.argumentExpression)?.member;
        }
        const ref = refKey ? byKey.get(refKey) : undefined;
        if (!ok || !ref || (refProp !== "tms" && refProp !== "levelMoves")) {
          report.bad(where, `${selfKey}: unsupported spread in move list`, el);
          continue;
        }
        const src = refProp === "tms" ? ref.tms : ref.levelMoves.map(x => x[1]);
        for (const m of src) if (!excluded.has(m)) res.push(m);
        report.notes.push(`${selfKey}: move list spread from ${refKey}.${refProp}${excluded.size ? ` minus ${[...excluded].join(", ")}` : ""}`);
        continue;
      }
      const mv = moveKey(el, where);
      if (mv) res.push(mv);
    }
    return res;
  };
  const keyedRecord = <T>(e: ts.Expression | undefined, fn: (v: ts.Expression) => T, where: string): Record<string, T> => {
    const res: Record<string, T> = {};
    if (!e) return res;
    const obj = unwrap(e);
    if (!ts.isObjectLiteralExpression(obj)) {
      report.bad(where, "expected object literal", e);
      return res;
    }
    for (const p of obj.properties) {
      if (!ts.isPropertyAssignment(p)) {
        report.bad(where, "unsupported property in record", p);
        continue;
      }
      let k: string | undefined;
      if (ts.isComputedPropertyName(p.name)) {
        const v = ev.eval(p.name.expression);
        if (typeof v.value === "string" || typeof v.value === "number") k = String(v.value);
      } else if (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) || ts.isNumericLiteral(p.name)) k = p.name.text;
      if (k === undefined) {
        report.bad(where, "unresolvable record key", p);
        continue;
      }
      res[k] = fn(p.initializer);
    }
    return res;
  };

  for (const file of files) {
    const sf = parseFile(file);
    for (const bin of findAll(sf, ts.isBinaryExpression)) {
      if (bin.operatorToken.kind !== ts.SyntaxKind.EqualsToken) continue;
      if (!ts.isElementAccessExpression(bin.left)) continue;
      const keyRef = ev.enumRef(bin.left.argumentExpression);
      if (!keyRef || keyRef.enum !== "SpeciesId") continue;
      const obj = unwrap(bin.right);
      if (!ts.isObjectLiteralExpression(obj)) continue;
      const where = relPos(bin, ctx.root);
      const d = objectProps(obj);
      const specNew = d.get("species") && unwrap(d.get("species")!);
      if (!specNew || !ts.isNewExpression(specNew) || !specNew.arguments?.[0] || !ts.isObjectLiteralExpression(unwrap(specNew.arguments[0]))) {
        report.bad(where, `${keyRef.member}: species is not new PokemonSpecies({...})`, bin.right);
        continue;
      }
      const sp = objectProps(unwrap(specNew.arguments[0]) as ts.ObjectLiteralExpression);
      const idRef = ev.enumRef(sp.get("id"));
      if (!idRef) {
        report.bad(where, `${keyRef.member}: species id unresolved`, specNew);
        continue;
      }
      const key = idRef.member;
      const id = idRef.value as number;
      const types = [typeOf(sp.get("type1")), typeOf(sp.get("type2"))].filter((t): t is string => !!t);
      const forms: FormOut[] = [];
      const formsExpr = sp.get("forms") && unwrap(sp.get("forms")!);
      if (formsExpr) {
        if (!ts.isArrayLiteralExpression(formsExpr)) report.bad(where, `${key}: forms is not an array literal`, formsExpr);
        else
          formsExpr.elements.forEach((fe, i) => {
            const fn = unwrap(fe as ts.Expression);
            if (!ts.isNewExpression(fn) || !fn.arguments?.[0] || !ts.isObjectLiteralExpression(unwrap(fn.arguments[0]))) {
              report.bad(where, `${key}: form ${i} is not new PokemonForm({...})`, fe);
              return;
            }
            const fp = objectProps(unwrap(fn.arguments[0]) as ts.ObjectLiteralExpression);
            const formKey = str(fp.get("formKey")) ?? "";
            const spriteKey = fp.has("formSpriteKey") ? str(fp.get("formSpriteKey")) : null;
            const fst = stats(fp);
            forms.push({
              formKey,
              formName: str(fp.get("formName")) ?? "",
              formIndex: i,
              formSpriteKey: spriteKey ?? formKey,
              types: [typeOf(fp.get("type1")), typeOf(fp.get("type2"))].filter((t): t is string => !!t),
              abilities: {
                a1: abilityKey(fp.get("ability1")) ?? "NONE",
                a2: abilityKey(fp.get("ability2")),
                hidden: abilityKey(fp.get("abilityHidden")),
              },
              baseStats: fst,
              bst: num(fp.get("baseTotal")),
              height: num(fp.get("height")),
              weight: num(fp.get("weight")),
              catchRate: num(fp.get("catchRate")),
              baseFriendship: num(fp.get("baseFriendship")),
              baseExp: num(fp.get("baseExp")),
              genderDiffs: bool(fp.get("genderDiffs")),
              isStarterSelectable: fp.has("isStarterSelectable") ? bool(fp.get("isStarterSelectable")) : !formKey,
              isUnobtainable: bool(fp.get("isUnobtainable")),
            });
            const sum = Object.values(fst).reduce((a, b) => a + b, 0);
            if (sum !== num(fp.get("baseTotal"))) report.warn(`${key}:${formKey} baseTotal ${num(fp.get("baseTotal"))} != sum of stats ${sum}`);
          });
      }
      const st = stats(sp);
      const sum = Object.values(st).reduce((a, b) => a + b, 0);
      if (sum !== num(sp.get("baseTotal"))) report.warn(`${key} baseTotal ${num(sp.get("baseTotal"))} != sum of stats ${sum}`);
      const malePct = sp.get("malePercent") ? ev.eval(sp.get("malePercent")!).value : null;

      // passives
      const passives: Record<string, string> = {};
      const pe = d.get("passives") && unwrap(d.get("passives")!);
      if (pe) {
        if (ts.isObjectLiteralExpression(pe)) Object.assign(passives, keyedRecord(pe, v => ev.enumRef(v)?.member ?? rawText(v), where));
        else {
          const r = ev.enumRef(pe);
          if (r) passives["0"] = r.member;
          else report.bad(where, `${key}: passives unresolved`, pe);
        }
      }

      const species: SpeciesOut = {
        id,
        nationalDex: id % 2000,
        key,
        generation: num(sp.get("generation")),
        types,
        abilities: {
          a1: abilityKey(sp.get("ability1")) ?? "NONE",
          a2: abilityKey(sp.get("ability2")),
          hidden: abilityKey(sp.get("abilityHidden")),
        },
        baseStats: st,
        bst: num(sp.get("baseTotal")),
        height: num(sp.get("height")),
        weight: num(sp.get("weight")),
        catchRate: num(sp.get("catchRate")),
        baseFriendship: num(sp.get("baseFriendship")),
        baseExp: num(sp.get("baseExp")),
        growthRate: ev.enumRef(sp.get("growthRate"))?.member ?? "?",
        malePercent: typeof malePct === "number" ? malePct : null,
        genderDiffs: bool(sp.get("genderDiffs")),
        isSubLegendary: bool(sp.get("subLegendary")),
        isLegendary: bool(sp.get("legendary")),
        isMythical: bool(sp.get("mythical")),
        canChangeForm: bool(sp.get("canChangeForm")),
        starter: ev.enumRef(d.get("starter"))?.member ?? key,
        starterCost: d.has("starterCost") ? num(d.get("starterCost")) : null,
        eggTier: ev.enumRef(d.get("eggTier"))?.member ?? null,
        prevolution: null,
        passives,
        forms,
      };

      // evolutions
      const evolutions: EvolutionOut[] = [];
      const evExpr = d.get("evolutions") && unwrap(d.get("evolutions")!);
      if (evExpr && ts.isArrayLiteralExpression(evExpr)) {
        for (const ee of evExpr.elements) {
          const ne = unwrap(ee as ts.Expression);
          if (!ts.isNewExpression(ne) || !ne.arguments?.[0] || !ts.isObjectLiteralExpression(unwrap(ne.arguments[0]))) {
            report.bad(where, `${key}: evolution is not new SpeciesEvolution({...})`, ee);
            continue;
          }
          const ep = objectProps(unwrap(ne.arguments[0]) as ts.ObjectLiteralExpression);
          const cls = ne.expression.getText(sf);
          const itemRef = ev.enumRef(ep.get("item"));
          const cond = ep.get("condition");
          evolutions.push({
            to: ev.enumRef(ep.get("speciesId"))?.member ?? "?",
            preFormKey: cls === "SpeciesEvolution" ? null : str(ep.get("preFormKey")),
            evoFormKey: cls === "SpeciesEvolution" ? null : str(ep.get("evoFormKey")),
            level: num(ep.get("level")),
            item: itemRef && itemRef.member !== "NONE" ? itemRef.member : null,
            condition: cond ? rawText(cond) : null,
            conditionData: cond ? (() => {
              const v = ev.eval(cond);
              return v.kind === "object" ? [v.value] : v.value;
            })() : null,
            evoDelay: ep.get("evoDelay") ? ev.eval(ep.get("evoDelay")!).value : null,
            class: cls,
          });
        }
      } else if (evExpr) report.bad(where, `${key}: evolutions is not an array literal`, evExpr);

      // form changes
      const formChanges: FormChangeOut[] = [];
      const fcExpr = d.get("formChanges") && unwrap(d.get("formChanges")!);
      const triggerInfo = (t: ts.Expression): { detail: Json; item: string | null; itemActive: boolean | null; short: string } => {
        const tn = unwrap(t);
        if (!ts.isNewExpression(tn)) return { detail: { raw: rawText(tn) }, item: null, itemActive: null, short: "raw" };
        const cls = tn.expression.getText(sf);
        const args = tn.arguments ?? [];
        if (cls === "SpeciesFormChangeCompoundTrigger") {
          const parts = args.map(a => triggerInfo(a));
          const it = parts.find(p => p.item);
          return {
            detail: { class: cls, triggers: parts.map(p => p.detail) },
            item: it?.item ?? null,
            itemActive: it?.itemActive ?? null,
            short: "compound",
          };
        }
        const a = ev.args(args);
        let item: string | null = null;
        let itemActive: boolean | null = null;
        if (cls === "SpeciesFormChangeItemTrigger") {
          item = ev.enumRef(args[0])?.member ?? null;
          itemActive = args[1] ? ev.eval(args[1]).value === true : true;
        }
        return { detail: { class: cls, args: a.args, argKinds: a.argKinds }, item, itemActive, short: triggerShortName(cls) };
      };
      if (fcExpr && ts.isArrayLiteralExpression(fcExpr)) {
        for (const fe of fcExpr.elements) {
          const ne = unwrap(fe as ts.Expression);
          if (!ts.isNewExpression(ne) || !ne.arguments?.[0] || !ts.isObjectLiteralExpression(unwrap(ne.arguments[0]))) {
            report.bad(where, `${key}: form change is not new SpeciesFormChange({...})`, fe);
            continue;
          }
          const fp = objectProps(unwrap(ne.arguments[0]) as ts.ObjectLiteralExpression);
          const trig = fp.get("trigger");
          const ti = trig ? triggerInfo(trig) : { detail: null, item: null, itemActive: null, short: "none" };
          const condsExpr = fp.get("conditions") && unwrap(fp.get("conditions")!);
          const conds: string[] =
            condsExpr && ts.isArrayLiteralExpression(condsExpr) ? condsExpr.elements.map(c => rawText(c)) : condsExpr ? [rawText(condsExpr)] : [];
          formChanges.push({
            preFormKey: str(fp.get("preFormKey")) ?? "",
            formKey: str(fp.get("evoFormKey")) ?? "",
            trigger: ti.short,
            item: ti.item,
            itemActive: ti.itemActive,
            triggerDetail: ti.detail,
            quiet: bool(fp.get("quiet")),
            conditions: conds,
            raw: rawText(ne),
          });
        }
      } else if (fcExpr) report.bad(where, `${key}: formChanges is not an array literal`, fcExpr);

      const rec: RawSpeciesData = {
        species,
        evolutions,
        formChanges,
        levelMoves: levelMoves(d.get("levelMoves"), where),
        formLevelMoves: keyedRecord(d.get("formLevelMoves"), v => levelMoves(v, where), where),
        tms: [],
        formTms: {},
      };
      byKey.set(key, rec);
      rec.tms = moveList(d.get("tms"), where, key);
      rec.formTms = keyedRecord(d.get("formTms"), v => moveList(v, where, key), where);
      for (const k of d.keys()) {
        if (!["species", "starter", "starterCost", "evolutions", "formChanges", "eggTier", "passives", "levelMoves", "formLevelMoves", "tms", "formTms"].includes(k))
          report.notes.push(`${key}: ignored species-data property "${k}"`);
      }
      if (byKey.size !== out.length + 1) report.warn(`duplicate species definition ${key}`);
      out.push(rec);
    }
  }

  // Reverse item form changes (PokéRogue adds these at runtime in initReverseFormChanges)
  for (const rec of out) {
    const list = rec.formChanges;
    const add: FormChangeOut[] = [];
    for (const fc of list) {
      if (!fc.item) continue;
      if (list.some(c => c.preFormKey === fc.formKey && c.formKey === fc.preFormKey)) continue;
      add.push({
        preFormKey: fc.formKey,
        formKey: fc.preFormKey,
        trigger: "item",
        item: fc.item,
        itemActive: false,
        triggerDetail: { class: "SpeciesFormChangeItemTrigger", args: [fc.item, false], argKinds: ["enum:FormChangeItem", "boolean"] },
        quiet: false,
        conditions: [],
        raw: `new SpeciesFormChange({ speciesId: SpeciesId.${rec.species.key}, preFormKey: ${JSON.stringify(fc.formKey)}, evoFormKey: ${JSON.stringify(fc.preFormKey)}, trigger: new SpeciesFormChangeItemTrigger(FormChangeItem.${fc.item}, false) })`,
        synthesized: true,
      });
    }
    list.push(...add);
  }

  // prevolutions (SpeciesDataRegistry.initPreEvolutions): walk from every starter, skipping mega evolutions
  const megaKeys = new Set(["mega", "mega-x", "mega-y", "mega-z", "mega-original", "mega-curly", "mega-droopy", "mega-stretchy"]);
  const setPrevo = (k: string, seen: Set<string>) => {
    const rec = byKey.get(k);
    if (!rec || seen.has(k)) return;
    seen.add(k);
    for (const e of rec.evolutions) {
      if (e.evoFormKey && megaKeys.has(e.evoFormKey)) continue;
      const t = byKey.get(e.to);
      if (!t) continue;
      t.species.prevolution = k;
      setPrevo(e.to, seen);
    }
  };
  for (const rec of out) {
    if (rec.species.starterCost) {
      rec.species.prevolution = null;
      setPrevo(rec.species.key, new Set());
    }
  }

  out.sort((a, b) => a.species.id - b.species.id);
  const missing = ctx.enums.memberNames("SpeciesId").filter(k => k !== "NONE" && !byKey.has(k));
  if (missing.length) report.warn(`SpeciesId members without species data: ${missing.join(", ")}`);
  return out;
}

/** PokéRogue's SpeciesDataRegistry.getFormKey: default form = forms[0].formKey */
function defaultFormKey(rec: RawSpeciesData): string {
  return rec.species.forms[0]?.formKey ?? "";
}
function resolveFormKey(rec: RawSpeciesData, form?: string): string {
  const forms = rec.species.forms;
  if (!forms.length) return "";
  if (form == null) return forms[0].formKey;
  return forms.some(f => f.formKey === form) ? form : forms[0].formKey;
}

export function buildLearnsets(recs: RawSpeciesData[]): Record<string, [number, string][]> {
  const out: Record<string, [number, string][]> = {};
  const stableByLevel = (list: [number, string][]) =>
    list.map((x, i) => [x, i] as const).sort((a, b) => a[0][0] - b[0][0] || a[1] - b[1]).map(x => x[0]);
  for (const rec of recs) {
    const def = defaultFormKey(rec);
    out[rec.species.key] = stableByLevel([...rec.levelMoves, ...(rec.formLevelMoves[def] ?? [])]);
    for (const fk of Object.keys(rec.formLevelMoves)) {
      if (fk === def) continue;
      out[`${rec.species.key}:${fk}`] = stableByLevel([...rec.levelMoves, ...rec.formLevelMoves[fk]]);
    }
  }
  return out;
}

/** Effective TMs per PokéRogue SpeciesDataRegistry.getTms (inherits the prevolution chain). */
export function buildTms(recs: RawSpeciesData[], moveOrder: string[]): { byMove: Record<string, string[]>; formOnlyExceptions: string[] } {
  const byKey = new Map(recs.map(r => [r.species.key, r]));
  const getTms = (key: string, form?: string, depth = 0): string[] => {
    const rec = byKey.get(key)!;
    const fk = resolveFormKey(rec, form);
    const tms = [...rec.tms, ...(rec.formTms[fk] ?? [])];
    if (rec.species.prevolution && depth < 10) tms.push(...getTms(rec.species.prevolution, form ? fk : undefined, depth + 1));
    return [...new Set(tms)];
  };
  const learners = new Map<string, string[]>();
  const exceptions: string[] = [];
  const add = (move: string, who: string) => {
    if (!learners.has(move)) learners.set(move, []);
    learners.get(move)!.push(who);
  };
  for (const rec of recs) {
    const base = new Set(getTms(rec.species.key));
    for (const m of base) add(m, rec.species.key);
    const def = defaultFormKey(rec);
    for (const f of rec.species.forms) {
      if (f.formKey === def) continue;
      const formSet = getTms(rec.species.key, f.formKey);
      for (const m of formSet) if (!base.has(m)) add(m, `${rec.species.key}:${f.formKey}`);
      for (const m of base) if (!formSet.includes(m)) exceptions.push(`${rec.species.key}:${f.formKey} lacks ${m}`);
    }
  }
  const byMove: Record<string, string[]> = {};
  const speciesOrder = new Map(recs.map((r, i) => [r.species.key, i]));
  const ord = (s: string) => (speciesOrder.get(s.split(":")[0]) ?? 1e9) + (s.includes(":") ? 0.5 : 0);
  for (const m of moveOrder) {
    const l = learners.get(m);
    if (l) byMove[m] = [...new Set(l)].sort((a, b) => ord(a) - ord(b) || (a < b ? -1 : 1));
  }
  for (const m of learners.keys()) if (!(m in byMove)) byMove[m] = learners.get(m)!;
  return { byMove, formOnlyExceptions: exceptions };
}

// #endregion

// #region Egg moves / TM tiers

export function extractEggMoves(ctx: Ctx): Record<string, string[]> {
  const { ev, report } = ctx;
  const file = findSrcFile(ctx.src, "data/balance/moves/egg-moves.ts", /export const speciesEggMoves\s*=/);
  const sf = parseFile(file);
  const decl = findAll(sf, ts.isVariableDeclaration).find(d => ts.isIdentifier(d.name) && d.name.text === "speciesEggMoves");
  const obj = decl?.initializer && unwrap(decl.initializer);
  if (!obj || !ts.isObjectLiteralExpression(obj)) throw new Error("speciesEggMoves not found");
  const out: Record<string, string[]> = {};
  for (const p of obj.properties) {
    if (!ts.isPropertyAssignment(p) || !ts.isComputedPropertyName(p.name)) {
      report.bad(relPos(p, ctx.root), "egg-move entry not [SpeciesId.X]: [...]", p);
      continue;
    }
    const k = ev.enumRef(p.name.expression)?.member;
    const v = ev.eval(p.initializer);
    if (!k || v.kind !== "array") {
      report.bad(relPos(p, ctx.root), "egg-move entry unresolved", p);
      continue;
    }
    out[k] = v.value as string[];
  }
  return out;
}

export function extractTmTiers(ctx: Ctx): Record<string, string> {
  const { ev, report } = ctx;
  const file = findSrcFile(ctx.src, "data/balance/tm-pool-tiers.ts", /export const tmPoolTiers\b/);
  const sf = parseFile(file);
  const decl = findAll(sf, ts.isVariableDeclaration).find(d => ts.isIdentifier(d.name) && d.name.text === "tmPoolTiers");
  const obj = decl?.initializer && unwrap(decl.initializer);
  if (!obj || !ts.isObjectLiteralExpression(obj)) throw new Error("tmPoolTiers not found");
  const out: Record<string, string> = {};
  for (const p of obj.properties) {
    if (!ts.isPropertyAssignment(p) || !ts.isComputedPropertyName(p.name)) continue;
    const k = ev.enumRef(p.name.expression)?.member;
    const v = ev.enumRef(p.initializer)?.member;
    if (!k || !v) {
      report.bad(relPos(p, ctx.root), "tm tier entry unresolved", p);
      continue;
    }
    out[k] = v;
  }
  return out;
}

// #endregion

// #region Type chart

export function extractTypeChart(ctx: Ctx): Record<string, Record<string, number>> {
  const { ev } = ctx;
  const file = findSrcFile(ctx.src, "data/type.ts", /function getTypeChartMultiplier\(/);
  const sf = parseFile(file);
  const fn = findFunction(sf, "getTypeChartMultiplier") ?? findFunction(sf, "getTypeDamageMultiplier");
  if (!fn?.body) throw new Error("type chart function not found");
  const [attName, defName] = fn.parameters.map(p => p.name.getText(sf));
  const pt = ctx.enums.get("PokemonType")!;
  const types = [...pt.members.entries()].filter(([, v]) => typeof v === "number" && v >= 0).map(([k]) => k);

  const run = (att: string, def: string): number => {
    const env: Record<string, string> = { [attName]: att, [defName]: def };
    const cond = (e: ts.Expression): boolean => {
      e = unwrap(e);
      if (ts.isBinaryExpression(e)) {
        const k = e.operatorToken.kind;
        if (k === ts.SyntaxKind.BarBarToken) return cond(e.left) || cond(e.right);
        if (k === ts.SyntaxKind.AmpersandAmpersandToken) return cond(e.left) && cond(e.right);
        if (k === ts.SyntaxKind.EqualsEqualsEqualsToken || k === ts.SyntaxKind.ExclamationEqualsEqualsToken) {
          const l = ts.isIdentifier(e.left) ? env[e.left.text] : ev.enumRef(e.left)?.member;
          const r = ts.isIdentifier(e.right) ? env[e.right.text] : ev.enumRef(e.right)?.member;
          return k === ts.SyntaxKind.EqualsEqualsEqualsToken ? l === r : l !== r;
        }
      }
      throw new Error(`unsupported condition ${rawText(e)}`);
    };
    const exec = (stmts: readonly ts.Statement[]): number | undefined => {
      for (const s of stmts) {
        const r = execOne(s);
        if (r !== undefined) return r;
      }
      return undefined;
    };
    const execOne = (s: ts.Statement): number | undefined => {
      if (ts.isReturnStatement(s)) {
        const v = s.expression ? ev.eval(s.expression).value : null;
        if (typeof v !== "number") throw new Error(`non-numeric return ${rawText(s)}`);
        return v;
      }
      if (ts.isBlock(s)) return exec(s.statements);
      if (ts.isIfStatement(s)) {
        if (cond(s.expression)) return execOne(s.thenStatement);
        return s.elseStatement ? execOne(s.elseStatement) : undefined;
      }
      if (ts.isSwitchStatement(s)) {
        const disc = unwrap(s.expression);
        const val = ts.isIdentifier(disc) ? env[disc.text] : undefined;
        const clauses = s.caseBlock.clauses;
        let start = clauses.findIndex(c => ts.isCaseClause(c) && ev.enumRef(c.expression)?.member === val);
        if (start < 0) start = clauses.findIndex(c => ts.isDefaultClause(c));
        if (start < 0) return undefined;
        for (let i = start; i < clauses.length; i++) {
          for (const st of clauses[i].statements) {
            if (st.kind === ts.SyntaxKind.BreakStatement) return undefined;
            const r = execOne(st);
            if (r !== undefined) return r;
          }
        }
        return undefined;
      }
      throw new Error(`unsupported statement in type chart: ${rawText(s).slice(0, 80)}`);
    };
    const r = exec(fn.body!.statements);
    if (r === undefined) throw new Error(`no multiplier for ${att} -> ${def}`);
    return r;
  };

  const chart: Record<string, Record<string, number>> = {};
  for (const a of types) {
    chart[a.toLowerCase()] = {};
    for (const d of types) chart[a.toLowerCase()][d.toLowerCase()] = run(a, d);
  }
  return chart;
}

// #endregion

// #region Misc lookups used by i18n

/** `function f(x: E) { switch (x) { case E.A: return "a"; ... } }` -> { A: "a" } */
export function switchReturnMap(ctx: Ctx, relFile: string, fnName: string): Record<string, string> {
  const file = findSrcFile(ctx.src, relFile, new RegExp(`function ${fnName}\\(`));
  const fn = findFunction(parseFile(file), fnName);
  const out: Record<string, string> = {};
  if (!fn?.body) return out;
  for (const sw of findAll(fn.body, ts.isSwitchStatement)) {
    let pending: string[] = [];
    for (const c of sw.caseBlock.clauses) {
      if (ts.isCaseClause(c)) {
        const r = ctx.ev.enumRef(c.expression);
        if (r) pending.push(r.member);
      }
      if (!c.statements.length) continue;
      let val: string | undefined;
      for (const st of c.statements) {
        walk2(st, n => {
          if (val) return;
          if (ts.isReturnStatement(n) && n.expression) {
            const v = ctx.ev.eval(n.expression);
            if (v.kind === "string") val = v.value as string;
          }
          if (ts.isCallExpression(n) && n.arguments[0] && /i18next\.t$/.test(n.expression.getText())) {
            const v = ctx.ev.eval(n.arguments[0]);
            if (v.kind === "string") val = v.value as string;
          }
        });
      }
      if (val) for (const p of pending) out[p] = val;
      pending = [];
    }
  }
  return out;
}

function walk2(n: ts.Node, f: (n: ts.Node) => void): void {
  f(n);
  ts.forEachChild(n, c => walk2(c, f));
}

/** `static readonly items: Record<Stat, string> = { [Stat.HP]: "hp_up", ... }` inside a class */
export function classStaticRecord(ctx: Ctx, relFile: string, className: string, prop: string): Record<string, string> {
  const file = findSrcFile(ctx.src, relFile, new RegExp(`class ${className}\\b`));
  const cls = findClass(parseFile(file), className);
  const out: Record<string, string> = {};
  const p = cls?.members.find(m => ts.isPropertyDeclaration(m) && m.name.getText() === prop) as ts.PropertyDeclaration | undefined;
  const init = p?.initializer && unwrap(p.initializer);
  if (!init || !ts.isObjectLiteralExpression(init)) return out;
  const v = ctx.ev.eval(init);
  if (v.kind === "object") for (const [k, val] of Object.entries(v.value as Record<string, Json>)) if (typeof val === "string") out[k] = val;
  return out;
}

export type { ChainCall, Ev };

// #endregion
