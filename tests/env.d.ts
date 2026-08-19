// This is a browser-agnostic package: Node's globals must NOT typecheck clean in
// src/. `console` is needed only by a test, so it is declared here rather than
// by installing @types/node, which would make every Node global available to
// source files that must not use them.
declare const console: { warn(...args: unknown[]): void; log(...args: unknown[]): void };
