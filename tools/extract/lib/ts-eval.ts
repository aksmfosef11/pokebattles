/**
 * Static evaluation helpers over PokéRogue's TypeScript source using the classic TS compiler API (ts5).
 * Nothing here executes PokéRogue code: we only walk syntax trees.
 */
import fs from "node:fs";
import path from "node:path";
import ts from "ts5";

const sourceCache = new Map<string, ts.SourceFile>();

export function parseFile(file: string): ts.SourceFile {
  const abs = path.resolve(file);
  let sf = sourceCache.get(abs);
  if (!sf) {
    const text = fs.readFileSync(abs, "utf8");
    sf = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    sourceCache.set(abs, sf);
  }
  return sf;
}

export function parseText(name: string, text: string): ts.SourceFile {
  return ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });

/** Raw source of a node without comments, whitespace-collapsed onto one line. */
export function rawText(node: ts.Node): string {
  const sf = node.getSourceFile();
  let text: string;
  try {
    text = printer.printNode(ts.EmitHint.Unspecified, node, sf);
  } catch {
    text = node.getText(sf);
  }
  return text.replace(/\s*\n\s*/g, " ").trim();
}

export function relPos(node: ts.Node, root: string): string {
  const sf = node.getSourceFile();
  const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  return `${path.relative(root, sf.fileName).replace(/\\/g, "/")}:${line + 1}`;
}

export function unwrap(node: ts.Expression): ts.Expression {
  let n = node;
  for (;;) {
    if (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n)) n = n.expression;
    else if (ts.isSatisfiesExpression(n)) n = n.expression;
    else if (ts.isTypeAssertionExpression(n)) n = n.expression;
    else return n;
  }
}

export function walk(node: ts.Node, visit: (n: ts.Node) => boolean | void): void {
  const rec = (n: ts.Node) => {
    if (visit(n) === false) return;
    ts.forEachChild(n, rec);
  };
  rec(node);
}

export function findAll<T extends ts.Node>(root: ts.Node, pred: (n: ts.Node) => n is T): T[] {
  const out: T[] = [];
  walk(root, n => {
    if (pred(n)) out.push(n);
  });
  return out;
}

export function findFunction(sf: ts.SourceFile, name: string): ts.FunctionDeclaration | undefined {
  return findAll(sf, ts.isFunctionDeclaration).find(f => f.name?.text === name);
}

export function findClass(sf: ts.SourceFile, name: string): ts.ClassDeclaration | undefined {
  return findAll(sf, ts.isClassDeclaration).find(c => c.name?.text === name);
}

export function propName(name: ts.PropertyName, ev?: Evaluator): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name) && ev) {
    const v = ev.eval(name.expression);
    if (typeof v.value === "string" || typeof v.value === "number") return String(v.value);
  }
  return undefined;
}

/** Map of property name -> initializer for an object literal. */
export function objectProps(obj: ts.ObjectLiteralExpression, ev?: Evaluator): Map<string, ts.Expression> {
  const m = new Map<string, ts.Expression>();
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p)) {
      const k = propName(p.name, ev);
      if (k !== undefined) m.set(k, p.initializer);
    } else if (ts.isShorthandPropertyAssignment(p)) {
      m.set(p.name.text, p.name);
    }
  }
  return m;
}

// #region Enums

export interface EnumInfo {
  name: string;
  file: string;
  /** "enum" declaration or `const X = {...} as const` object */
  style: "enum" | "const-object";
  members: Map<string, number | string>;
  isStringEnum: boolean;
}

export class EnumRegistry {
  readonly enums = new Map<string, EnumInfo>();
  readonly duplicates: string[] = [];

  addSourceFile(sf: ts.SourceFile): void {
    for (const stmt of sf.statements) {
      if (ts.isEnumDeclaration(stmt)) this.addEnum(stmt, sf);
      else if (ts.isVariableStatement(stmt)) {
        for (const d of stmt.declarationList.declarations) {
          if (!ts.isIdentifier(d.name) || !d.initializer) continue;
          const init = unwrap(d.initializer);
          if (!ts.isObjectLiteralExpression(init)) continue;
          if (!/^[A-Z][A-Za-z0-9]*$/.test(d.name.text)) continue;
          const members = new Map<string, number | string>();
          let ok = init.properties.length > 0;
          for (const p of init.properties) {
            if (!ts.isPropertyAssignment(p) || !(ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) {
              ok = false;
              break;
            }
            const v = unwrap(p.initializer);
            const num = literalNumber(v);
            if (num !== undefined) members.set(p.name.text, num);
            else if (ts.isStringLiteral(v)) members.set(p.name.text, v.text);
            else {
              ok = false;
              break;
            }
          }
          // Only UPPER_SNAKE member objects are treated as enum-likes.
          if (ok && [...members.keys()].every(k => /^[A-Z0-9_]+$/.test(k))) {
            this.register({
              name: d.name.text,
              file: sf.fileName,
              style: "const-object",
              members,
              isStringEnum: [...members.values()].every(v => typeof v === "string"),
            });
          }
        }
      }
    }
    // Enums nested in namespaces/functions are ignored (PokéRogue does not use them for data).
  }

  private addEnum(decl: ts.EnumDeclaration, sf: ts.SourceFile): void {
    const members = new Map<string, number | string>();
    let next = 0;
    for (const m of decl.members) {
      const name = propName(m.name) ?? m.name.getText(sf);
      let value: number | string | undefined;
      if (m.initializer) {
        value = this.evalEnumInit(m.initializer, members);
      } else value = next;
      if (value === undefined) value = next; // unresolvable initializer: best effort
      members.set(name, value);
      if (typeof value === "number") next = value + 1;
    }
    this.register({
      name: decl.name.text,
      file: sf.fileName,
      style: "enum",
      members,
      isStringEnum: [...members.values()].every(v => typeof v === "string"),
    });
  }

  private evalEnumInit(e: ts.Expression, local: Map<string, number | string>): number | string | undefined {
    e = unwrap(e);
    const n = literalNumber(e);
    if (n !== undefined) return n;
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
    if (ts.isIdentifier(e) && local.has(e.text)) return local.get(e.text);
    if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression)) {
      const other = this.enums.get(e.expression.text);
      if (other?.members.has(e.name.text)) return other.members.get(e.name.text);
    }
    if (ts.isBinaryExpression(e)) {
      const l = this.evalEnumInit(e.left, local);
      const r = this.evalEnumInit(e.right, local);
      if (typeof l === "number" && typeof r === "number") {
        switch (e.operatorToken.kind) {
          case ts.SyntaxKind.LessThanLessThanToken:
            return l << r;
          case ts.SyntaxKind.BarToken:
            return l | r;
          case ts.SyntaxKind.PlusToken:
            return l + r;
          case ts.SyntaxKind.MinusToken:
            return l - r;
          case ts.SyntaxKind.AsteriskToken:
            return l * r;
        }
      }
    }
    return undefined;
  }

  private register(info: EnumInfo): void {
    if (this.enums.has(info.name)) {
      this.duplicates.push(`${info.name} (${path.basename(info.file)} vs ${path.basename(this.enums.get(info.name)!.file)})`);
      return;
    }
    this.enums.set(info.name, info);
  }

  get(name: string): EnumInfo | undefined {
    return this.enums.get(name);
  }

  value(enumName: string, member: string): number | string {
    const e = this.enums.get(enumName);
    if (!e || !e.members.has(member)) throw new Error(`Unknown enum member ${enumName}.${member}`);
    return e.members.get(member)!;
  }

  /** member name for a numeric value (first match, like TS reverse mapping) */
  nameOf(enumName: string, value: number | string): string | undefined {
    const e = this.enums.get(enumName);
    if (!e) return undefined;
    for (const [k, v] of e.members) if (v === value) return k;
    return undefined;
  }

  memberNames(enumName: string): string[] {
    return [...(this.enums.get(enumName)?.members.keys() ?? [])];
  }
}

function literalNumber(e: ts.Expression): number | undefined {
  if (ts.isNumericLiteral(e)) return Number(e.text);
  if (ts.isPrefixUnaryExpression(e) && ts.isNumericLiteral(e.operand)) {
    if (e.operator === ts.SyntaxKind.MinusToken) return -Number(e.operand.text);
    if (e.operator === ts.SyntaxKind.PlusToken) return Number(e.operand.text);
  }
  return undefined;
}

// #endregion

// #region Expression evaluation

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export interface Ev {
  value: Json;
  /** number | string | boolean | null | undefined | enum:<Name> | const:<NAME> | array | object | raw */
  kind: string;
  /** For enum refs: the member name and numeric/string value */
  enumRef?: { enum: string; member: string; value: number | string };
}

export interface EvaluatorOptions {
  /** Identifier -> literal constant (e.g. EVOLVE_MOVE = 0) */
  constants?: Map<string, number | string | boolean>;
}

export class Evaluator {
  constructor(
    readonly enums: EnumRegistry,
    readonly opts: EvaluatorOptions = {},
  ) {}

  /**
   * Evaluate an expression to JSON:
   *  - numeric enums -> member name, string enums -> their string value
   *  - literals / arrays / plain objects -> JSON
   *  - anything else -> raw source text (kind "raw")
   */
  eval(node: ts.Expression): Ev {
    const e = unwrap(node);
    const num = literalNumber(e);
    if (num !== undefined) return { value: num, kind: "number" };
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return { value: e.text, kind: "string" };
    if (e.kind === ts.SyntaxKind.TrueKeyword) return { value: true, kind: "boolean" };
    if (e.kind === ts.SyntaxKind.FalseKeyword) return { value: false, kind: "boolean" };
    if (e.kind === ts.SyntaxKind.NullKeyword) return { value: null, kind: "null" };
    if (ts.isIdentifier(e)) {
      if (e.text === "undefined") return { value: null, kind: "undefined" };
      const c = this.opts.constants?.get(e.text);
      if (c !== undefined) return { value: c, kind: `const:${e.text}` };
      return { value: rawText(e), kind: "raw" };
    }
    if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression)) {
      const info = this.enums.get(e.expression.text);
      const member = e.name.text;
      if (info?.members.has(member)) {
        const v = info.members.get(member)!;
        return {
          value: info.isStringEnum ? (v as string) : member,
          kind: `enum:${info.name}`,
          enumRef: { enum: info.name, member, value: v },
        };
      }
    }
    if (ts.isArrayLiteralExpression(e)) {
      if (e.elements.some(el => ts.isSpreadElement(el) || ts.isOmittedExpression(el)))
        return { value: rawText(e), kind: "raw" };
      return { value: e.elements.map(el => this.eval(el).value), kind: "array" };
    }
    if (ts.isObjectLiteralExpression(e)) {
      const out: { [k: string]: Json } = {};
      for (const p of e.properties) {
        if (!ts.isPropertyAssignment(p)) return { value: rawText(e), kind: "raw" };
        const k = propName(p.name, this);
        if (k === undefined) return { value: rawText(e), kind: "raw" };
        out[k] = this.eval(p.initializer).value;
      }
      return { value: out, kind: "object" };
    }
    return { value: rawText(e), kind: "raw" };
  }

  /** Enum reference -> {enum, member, value} or undefined. */
  enumRef(node: ts.Expression | undefined): Ev["enumRef"] | undefined {
    if (!node) return undefined;
    return this.eval(node).enumRef;
  }

  /** Evaluate a list of call arguments into the {args, argKinds} pair used in outputs. */
  args(nodes: readonly ts.Expression[]): { args: Json[]; argKinds: string[] } {
    const evs = nodes.map(n => this.eval(n));
    return { args: evs.map(v => v.value), argKinds: evs.map(v => v.kind) };
  }
}

// #endregion

// #region Builder chains

export interface ChainCall {
  name: string;
  args: readonly ts.Expression[];
  node: ts.CallExpression;
}

/**
 * `new X(...).a(...).b(...)` -> { base: NewExpression, calls: [a, b] } (in source order).
 */
export function unwindChain(expr: ts.Expression): { base: ts.Expression; calls: ChainCall[] } {
  const calls: ChainCall[] = [];
  let e = unwrap(expr);
  while (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)) {
    calls.unshift({ name: e.expression.name.text, args: e.arguments, node: e });
    e = unwrap(e.expression.expression);
  }
  return { base: e, calls };
}

export function newExprClass(e: ts.Expression): string | undefined {
  const u = unwrap(e);
  if (ts.isNewExpression(u) && ts.isIdentifier(u.expression)) return u.expression.text;
  return undefined;
}

/** Leading comments (text) attached before a node. */
export function leadingComments(node: ts.Node): string[] {
  const sf = node.getSourceFile();
  const ranges = ts.getLeadingCommentRanges(sf.text, node.pos) ?? [];
  return ranges.map(r => sf.text.slice(r.pos, r.end));
}

// #endregion

export { ts };
