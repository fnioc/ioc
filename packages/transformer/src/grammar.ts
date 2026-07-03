// The closed-generic token grammar helpers the transformer needs at COMPILE time
// (`parseToken`, `isOpenToken`). Inlined here so the transformer depends on no
// runtime — @fnioc/core is now a pure-types package (nothing to import at
// runtime) and the transformer does not depend on @fnioc/di. The transformer
// hand-builds closed tokens via string templates elsewhere, so `closeToken` /
// `substituteToken` are not needed here.
//
// Grammar (canonical, recursive): `base<arg1,arg2>` — no whitespace around the
// separators; each arg is itself a token. A hole is a node that is exactly `$N`
// (decimal N ≥ 1); a token containing a hole in any arg position is open.

/** A token node that is exactly a hole: `$N`, decimal N ≥ 1. */
const HOLE_PATTERN = /^\$[1-9][0-9]*$/;

/** The result of parsing a closed-generic token into base + top-level args. */
export interface ParsedToken {
  readonly base: string;
  readonly args: readonly string[];
}

/**
 * Parses a closed-generic token into its base and top-level args. Returns
 * `undefined` for non-generic tokens (no top-level `<`) and malformed input
 * (empty base, unbalanced brackets, empty arg, trailing text, unterminated
 * quote). Depth-tracked and quote-aware for double quotes (backslash escapes
 * honored), so literal-type args like `"a,b" | "<c>"` split correctly.
 */
export function parseToken(token: string): ParsedToken | undefined {
  const open = token.indexOf("<");
  if (open <= 0) {
    return undefined;
  }
  const base = token.slice(0, open);
  if (base.includes(">") || base.includes('"')) {
    return undefined;
  }
  const args: string[] = [];
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
  return undefined;
}

/**
 * True when `token` contains a hole (`$N`) at any depth — i.e. it is an open
 * template rather than a resolvable token. Grammar-aware: a `$N` inside a quoted
 * literal arg is NOT a hole.
 */
export function isOpenToken(token: string): boolean {
  if (HOLE_PATTERN.test(token)) {
    return true;
  }
  const parsed = parseToken(token);
  if (!parsed) {
    return false;
  }
  return parsed.args.some(isOpenToken);
}
