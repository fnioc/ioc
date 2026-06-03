// In-memory test harness for the @fnioc/transformer.
//
// Drives a tiny virtual `ts.Program` over fixture sources and runs the
// transformer's `before` factory against it, returning the emitted JS text for
// each file plus the diagnostics the transformer raised. ts-patch is the
// production runner; tests invoke the transformer factory against a Program
// directly (the factory only needs `ts.Program` + `addDiagnostic`).
//
// The harness supports a multi-file virtual filesystem, including synthetic
// `package.json` files, so token generation (package-public vs app-internal)
// can be exercised deterministically without touching real `node_modules`.

import ts from "typescript";
import { createTransformerFactory } from "../src/transformer.js";
import type { Diagnostic } from "../src/diagnostics.js";

/** A virtual filesystem: absolute POSIX path → file contents. */
export type VirtualFiles = Record<string, string>;

export interface TransformResult {
  /** Emitted JS text, keyed by the source file's virtual path. */
  readonly outputs: Record<string, string>;
  /** Emitted JS text for the single entry file (convenience for 1-file tests). */
  readonly output: string;
  /** Diagnostics the transformer raised, in emission order. */
  readonly diagnostics: readonly Diagnostic[];
}

const DEFAULT_ROOT = "/virtual";

export interface TransformOptions {
  /** Entry files to transform (absolute virtual paths). Defaults to all `.ts`. */
  readonly entry?: readonly string[];
  /** Extra compiler options merged over the harness defaults. */
  readonly compilerOptions?: ts.CompilerOptions;
}

/**
 * Compile `files` into an in-memory Program and run the transformer over the
 * entry files. Returns emitted text + raised diagnostics.
 */
export function transform(
  files: VirtualFiles,
  options: TransformOptions = {},
): TransformResult {
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ["lib.es2022.d.ts"],
    strict: true,
    skipLibCheck: true,
    noEmitOnError: false,
    types: [],
    ...options.compilerOptions,
  };

  const libFileName = ts.getDefaultLibFileName(compilerOptions);
  const libSourcePath = ts.getDefaultLibFilePath(compilerOptions);

  const host: ts.CompilerHost = {
    getSourceFile(fileName, languageVersion) {
      const text = readVirtualOrReal(files, fileName, libFileName, libSourcePath);
      if (text === undefined) {return undefined;}
      return ts.createSourceFile(fileName, text, languageVersion, true);
    },
    getDefaultLibFileName: () => libFileName,
    getDefaultLibLocation: () => libSourcePath.replace(/[^/\\]+$/, ""),
    writeFile: () => undefined,
    getCurrentDirectory: () => DEFAULT_ROOT,
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists(fileName) {
      return (
        Object.prototype.hasOwnProperty.call(files, fileName) ||
        fileName === libFileName ||
        fileName === libSourcePath ||
        ts.sys.fileExists(fileName)
      );
    },
    readFile(fileName) {
      return readVirtualOrReal(files, fileName, libFileName, libSourcePath);
    },
    directoryExists(dirName) {
      if (anyFileUnder(files, dirName)) {return true;}
      return ts.sys.directoryExists?.(dirName) ?? false;
    },
    getDirectories(dirName) {
      return ts.sys.getDirectories?.(dirName) ?? [];
    },
    realpath: (f) => f,
  };

  const entry =
    options.entry ??
    Object.keys(files).filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"));

  const program = ts.createProgram(entry.slice(), compilerOptions, host);

  const diagnostics: Diagnostic[] = [];
  const factory = createTransformerFactory(
    program,
    {
      addDiagnostic(d: Diagnostic) {
        diagnostics.push(d);
        return diagnostics.length;
      },
    },
    {
      // Let token generation see the virtual `package.json` files so the
      // package-public vs app-internal distinction is testable in-memory.
      readFile: (path) =>
        Object.prototype.hasOwnProperty.call(files, path)
          ? files[path]
          : ts.sys.readFile(path),
    },
  );

  const outputs: Record<string, string> = {};
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });

  for (const fileName of entry) {
    const sourceFile = program.getSourceFile(fileName);
    if (!sourceFile) {throw new Error(`entry file not in program: ${fileName}`);}
    const result = ts.transform(sourceFile, [factory], compilerOptions);
    const transformed = result.transformed[0]!;
    outputs[fileName] = printer.printFile(transformed as ts.SourceFile);
    result.dispose();
  }

  return {
    outputs,
    output: outputs[entry[0]!] ?? "",
    diagnostics,
  };
}

function readVirtualOrReal(
  files: VirtualFiles,
  fileName: string,
  libFileName: string,
  libSourcePath: string,
): string | undefined {
  if (Object.prototype.hasOwnProperty.call(files, fileName)) {
    return files[fileName];
  }
  if (fileName === libFileName || fileName === libSourcePath) {
    return ts.sys.readFile(libSourcePath);
  }
  // Allow the real default-lib directory through so Promise/primitives resolve.
  return ts.sys.readFile(fileName);
}

function anyFileUnder(files: VirtualFiles, dir: string): boolean {
  const normalized = dir.endsWith("/") ? dir : dir + "/";
  return Object.keys(files).some((f) => f.startsWith(normalized));
}

/** Convenience: build a one-file fixture under the default virtual root. */
export function fixture(source: string, name = "app.ts"): VirtualFiles {
  return { [`${DEFAULT_ROOT}/${name}`]: source };
}

export const ROOT = DEFAULT_ROOT;
