// Diagnostic plumbing for the transformer.
//
// The transformer surfaces compile-time information back to the user via the
// host's `addDiagnostic` hook (ts-patch wires this to tsc's diagnostic stream).
// We keep a thin `Diagnostic` alias over `ts.Diagnostic` plus a small set of
// stable codes so tests can assert on category + code without matching message
// text.

import ts from "typescript";

/** A diagnostic the transformer raises. Alias kept for call-site clarity. */
export type Diagnostic = ts.Diagnostic;

/** The sink the transformer writes diagnostics to (ts-patch supplies this). */
export interface DiagnosticSink {
  addDiagnostic(diagnostic: Diagnostic): number;
}

/**
 * Stable numeric codes for transformer-emitted diagnostics. The high offset
 * keeps them clear of TypeScript's own code space. These are part of the
 * transformer's observable surface — tests assert on them.
 */
export const enum DiagnosticCode {
  /** A factory param's call signature doesn't match the target ctor's holes. */
  FactorySignatureMismatch = 990003,
  /**
   * A constructor / factory parameter whose type has no derivable token and
   * carries no `Inject<T, "tok">` brand — a hard compile error.
   */
  UnderivableToken = 990006,
  /**
   * A type reaches token derivation while still referencing an UNBOUND type
   * parameter — a bare generic class registered without an instantiation
   * expression (`add<IFoo<$<1>>>(Foo)` instead of `Foo<$<1>>` / `Foo<Concrete>`),
   * or a type parameter leaking into a token position. Hard compile error.
   */
  UnboundTypeParameter = 990007,
  /**
   * An open SERVICE token mixes concrete args and holes (`IFoo<$<1>,string>`,
   * `IFoo<IBar<$<1>>>`). v1 requires every type arg of an open service token to
   * be a bare hole (`IFoo<$<1>,$<2>>`; repeats like `IFoo<$<1>,$<1>>` are allowed).
   */
  MixedServiceTokenArgs = 990008,
  /**
   * An open template token on an `addValue` / factory registration. Open
   * registrations are class registrations only — a value or factory has no
   * per-closing construction the container could substitute into.
   */
  OpenTokenOnValueOrFactory = 990009,
  /**
   * A dependency slot references a hole (`$N`) that the service template does
   * not bind — substitution at close time would have no argument for it.
   */
  DepHoleNotInServiceTemplate = 990010,
}

const SOURCE = "@fnioc/transformer";

/** Build a diagnostic of `category` anchored at `node` in `file`. */
function diagnostic(
  category: ts.DiagnosticCategory,
  file: ts.SourceFile,
  node: ts.Node,
  code: DiagnosticCode,
  messageText: string,
): Diagnostic {
  return {
    file,
    start: node.getStart(file),
    length: node.getWidth(file),
    category,
    code,
    messageText,
    source: SOURCE,
  };
}

/** Build a warning diagnostic anchored at `node` in `file`. */
export function warning(
  file: ts.SourceFile,
  node: ts.Node,
  code: DiagnosticCode,
  messageText: string,
): Diagnostic {
  return diagnostic(ts.DiagnosticCategory.Warning, file, node, code, messageText);
}

/** Build an error diagnostic anchored at `node` in `file`. */
export function error(
  file: ts.SourceFile,
  node: ts.Node,
  code: DiagnosticCode,
  messageText: string,
): Diagnostic {
  return diagnostic(ts.DiagnosticCategory.Error, file, node, code, messageText);
}
