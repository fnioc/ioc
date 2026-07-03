import type { DepSlot, Token } from "./types.js";
import { isFactoryRef, isTypeArgRef, isUnionSlot } from "./guards.js";

/**
 * Closed-generic token grammar (canonical, recursive):
 *
 *     base<arg1,arg2>
 *
 * No whitespace around the `<` `>` `,` separators; each arg is itself a token
 * (possibly closed-generic, recursively). Literal-type args keep their interior
 * spaces and quotes (`"a" | "b"` — the parser is quote-aware, so commas and
 * angle brackets inside double quotes never count as separators).
 *
 * A hole is a token node that is exactly `$N` (decimal N ≥ 1); a token
 * containing a hole in any arg position is an *open template*.
 */

/** A token node that is exactly a hole: `$N`, decimal N ≥ 1. */
const HOLE_PATTERN = /^\$[1-9][0-9]*$/;

/** The result of parsing a closed-generic token: `base<arg1,arg2>`. */
export interface ParsedToken {
  readonly base: Token;
  readonly args: readonly Token[];
}

/**
 * Renders the canonical closed-generic form `base<arg1,arg2>`. With no args,
 * returns `base` unchanged. Args may themselves be closed-generic tokens
 * (nesting) or holes (`$N` — producing an open template).
 */
export function closeToken(base: Token, ...args: Token[]): Token {
  if (!args.length) {
    return base;
  }
  return `${base}<${args.join(",")}>`;
}

/**
 * Parses a closed-generic token into its base and top-level args.
 *
 * Returns `undefined` for non-generic tokens (no top-level `<`) AND for
 * malformed input (empty base, unbalanced brackets, empty arg, trailing text
 * after the closing `>`, unterminated quote) — callers fall through to their
 * exact-match / unregistered-token handling either way.
 *
 * The scan is depth-tracked over `<` / `>` and quote-aware for double quotes
 * (backslash escapes honored), so literal-type args like `"a,b" | "<c>"` split
 * correctly.
 */
export function parseToken(token: Token): ParsedToken | undefined {
  const open = token.indexOf("<");
  if (open <= 0) {
    // No `<` at all (not generic), or `<` first (empty base — malformed).
    return undefined;
  }
  const base = token.slice(0, open);
  if (base.includes(">") || base.includes('"')) {
    return undefined;
  }
  const args: Token[] = [];
  let depth = 1;
  let inQuote = false;
  let argStart = open + 1;
  for (let i = open + 1; i < token.length; i++) {
    const ch = token[i];
    if (inQuote) {
      if (ch === "\\") {
        i++;
      } else if (ch === '"') {
        inQuote = false;
      }
      continue;
    }
    if (ch === '"') {
      inQuote = true;
    } else if (ch === "<") {
      depth++;
    } else if (ch === ">") {
      depth--;
      if (!depth) {
        // The closing `>` must be the last character.
        if (i !== token.length - 1) {
          return undefined;
        }
        const last = token.slice(argStart, i);
        if (!last) {
          return undefined;
        }
        args.push(last);
        return { base, args };
      }
    } else if (ch === "," && depth === 1) {
      const arg = token.slice(argStart, i);
      if (!arg) {
        return undefined;
      }
      args.push(arg);
      argStart = i + 1;
    }
  }
  // Ran off the end without closing — unbalanced or unterminated quote.
  return undefined;
}

/**
 * True when `token` contains a hole (`$N`) at any depth — i.e. it is an open
 * template rather than a resolvable token. Grammar-aware: a `$N` inside a
 * quoted literal arg is NOT a hole.
 */
export function isOpenToken(token: Token): boolean {
  if (HOLE_PATTERN.test(token)) {
    return true;
  }
  const parsed = parseToken(token);
  if (!parsed) {
    return false;
  }
  return parsed.args.some(isOpenToken);
}

/**
 * Substitutes hole nodes in an open template with the supplied argument tokens
 * (1-based: `$1` → `args[0]`). Grammar-aware and recursive — a node that is
 * exactly `$N` is replaced by the arg token (which may itself be
 * closed-generic); this is NOT a naive string replace, so a `$N` inside a
 * quoted literal arg survives untouched.
 *
 * Throws `RangeError` when the template references a hole beyond the supplied
 * args — callers match arity before substituting.
 */
export function substituteToken(template: Token, args: readonly Token[]): Token {
  if (HOLE_PATTERN.test(template)) {
    return holeArg(Number(template.slice(1)), args);
  }
  const parsed = parseToken(template);
  if (!parsed) {
    return template;
  }
  return closeToken(parsed.base, ...parsed.args.map((a) => substituteToken(a, args)));
}

/**
 * Substitutes the supplied argument tokens through every slot of every
 * signature, producing the closed signatures for one closing of an open
 * registration:
 *   - a string token     → `substituteToken`,
 *   - a `FactoryRef`     → `type` and each `params` token substituted,
 *   - a `Union`          → members substituted recursively,
 *   - a `TypeArgRef`     → a `LiteralRef` carrying `args[typeArg - 1]` (the
 *                          substituted argument's token string),
 *   - a `LiteralRef` / `ScopeRef` → unchanged.
 */
export function substituteSignatures(
  signatures: readonly (readonly DepSlot[])[],
  args: readonly Token[],
): readonly (readonly DepSlot[])[] {
  return signatures.map((sig) => sig.map((slot) => substituteSlot(slot, args)));
}

/** Slot-level dispatch for `substituteSignatures`. */
function substituteSlot(slot: DepSlot, args: readonly Token[]): DepSlot {
  if (typeof slot === "string") {
    return substituteToken(slot, args);
  }
  if (isTypeArgRef(slot)) {
    return { value: holeArg(slot.typeArg, args) };
  }
  if (isFactoryRef(slot)) {
    const type = substituteToken(slot.type, args);
    if (slot.params) {
      return { type, params: slot.params.map((p) => substituteToken(p, args)) };
    }
    return { type };
  }
  if (isUnionSlot(slot)) {
    return { union: slot.union.map((m) => substituteSlot(m, args)) };
  }
  // ScopeRef / LiteralRef — nothing to substitute.
  return slot;
}

/** The arg token bound to hole `n` (1-based); throws when out of range. */
function holeArg(n: number, args: readonly Token[]): Token {
  const arg = args[n - 1];
  if (arg === undefined) {
    throw new RangeError(
      `Hole $${n} has no matching type argument (${args.length} supplied).`,
    );
  }
  return arg;
}
