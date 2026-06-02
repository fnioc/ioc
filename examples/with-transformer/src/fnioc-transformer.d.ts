// Loads @fnioc/transformer's `declare module "@fnioc/di"` augmentation into this
// example's TypeScript program so the type-driven authoring forms in main.ts
// (`services.add<IGreeter>(Greeter).as<"singleton">()`) type-check under plain
// `tsc`. di's published types no longer carry these token-free forms — they
// exist only with the transformer in the program, which is exactly the truth at
// runtime: build this example through `tspc` (the transformer plugin) and the
// forms lower to explicit-token registrations.
//
// A side-effect `.d.ts` (rather than a tsconfig `types` array) keeps automatic
// @types inclusion — `console` et al. — intact.
import "@fnioc/transformer";

// The Inject<T, K> phantom brand — pins a specific token for one ctor param,
// overriding the transformer's structural derivation. Declared here (rather than
// re-exported from @fnioc/core) so it is available to example source files without
// adding @fnioc/core as a direct dep. The brand uses the same TOK unique-symbol
// pattern as @fnioc/core's definition — the transformer detects it by the
// computed-property name `[TOK]` whose key identifier text is "TOK".
declare const TOK: unique symbol;
export type Inject<T, K extends string> = T & { readonly [TOK]?: K };
