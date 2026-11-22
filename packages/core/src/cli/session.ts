/** Output side of a terminal, implemented by the server (socket) or by tests. */
export interface Terminal {
  write(text: string): void;
  /** The session is ready for a new line of input. */
  ready(prompt: string, opts: { echo: boolean }): void;
}

/**
 * A console session. Line editing happens on the client (xterm); the session receives
 * complete lines, and answers to "?" (help) and Tab (completion) immediately.
 */
export interface CliSession {
  line(text: string): void;
  /** Help for the partial line typed before "?". Returns the text to print. */
  help(partial: string): string;
  /** Tab completion; returns the completed line (or the same line). */
  complete(partial: string): string;
  /** Ctrl+C / Ctrl+Shift+6: aborts a running command. Ctrl+Z ends configuration mode. */
  interrupt(kind: 'break' | 'ctrl-z'): void;
  close(): void;
  readonly busy: boolean;
}

/** Collects output for tests and for scripted command execution. */
export class BufferTerminal implements Terminal {
  out = '';
  prompt = '';
  echo = true;
  write(text: string) {
    this.out += text;
  }
  ready(prompt: string, opts: { echo: boolean }) {
    this.prompt = prompt;
    this.echo = opts.echo;
  }
  take(): string {
    const o = this.out;
    this.out = '';
    return o;
  }
}
