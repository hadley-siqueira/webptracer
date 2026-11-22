// The core runs in Node and in the browser; only the console is needed from the host.
declare const console: { log(...a: unknown[]): void; error(...a: unknown[]): void; warn(...a: unknown[]): void };
