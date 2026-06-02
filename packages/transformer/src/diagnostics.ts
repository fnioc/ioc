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
  /** A registered class already carries a manual `@signature` / `forCtor`. */
  AlreadyAnnotated = 990001,
  /** A registration's concrete argument could not be statically resolved. */
  DynamicRegistration = 990002,
  /** A factory param's call signature doesn't match the target ctor's holes. */
  FactorySignatureMismatch = 990003,
  /** A bare dep that should be declared `Promise<T>` (async-registered value). */
  AsyncMismatch = 990004,
  /** Two overload signatures of equal length for the same constructor. */
  OverloadAmbiguity = 990005,
  /**
   * A constructor / factory parameter whose type has no derivable token and
   * carries no `Inject<T, "tok">` brand — a hard compile error.
   */
  UnderivableToken = 990006,
}

const SOURCE = "@fnioc/transformer";

/** Build an informational diagnostic anchored at `node` in `file`. */
export function info(
  file: ts.SourceFile,
  node: ts.Node,
  code: DiagnosticCode,
  messageText: string,
): Diagnostic {
  return {
    file,
    start: node.getStart(file),
    length: node.getWidth(file),
    category: ts.DiagnosticCategory.Message,
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
  return {
    file,
    start: node.getStart(file),
    length: node.getWidth(file),
    category: ts.DiagnosticCategory.Warning,
    code,
    messageText,
    source: SOURCE,
  };
}

/** Build an error diagnostic anchored at `node` in `file`. */
export function error(
  file: ts.SourceFile,
  node: ts.Node,
  code: DiagnosticCode,
  messageText: string,
): Diagnostic {
  return {
    file,
    start: node.getStart(file),
    length: node.getWidth(file),
    category: ts.DiagnosticCategory.Error,
    code,
    messageText,
    source: SOURCE,
  };
}
