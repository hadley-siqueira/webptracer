import type { CliSession, Terminal } from '../session';
import type { Host } from '../../devices/host';

/** Splits a command line honoring double quotes. */
export function splitArgs(line: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) out.push(m[1] ?? m[2]);
  return out;
}

/** Common behaviour of host shells (cmd.exe, bash): line input, async commands, Ctrl+C. */
export abstract class HostShell implements CliSession {
  protected running = false;
  protected abortFn?: () => void;
  protected closed = false;

  constructor(
    readonly host: Host,
    protected readonly term: Terminal,
  ) {}

  get busy() {
    return this.running;
  }

  abstract prompt(): string;
  protected abstract banner(): string;
  protected abstract run(args: string[], line: string): void;
  protected abstract commands(): string[];

  start() {
    this.out(this.banner());
    this.showPrompt();
  }

  reset() {
    this.abortFn?.();
    this.abortFn = undefined;
    this.running = false;
    if (!this.host.powered) return;
    this.out('\n');
    this.start();
  }

  out(text: string) {
    if (this.closed) return;
    this.term.write(text.replace(/\r?\n/g, '\r\n'));
  }

  println(text = '') {
    this.out(text + '\n');
  }

  protected showPrompt() {
    if (this.closed || !this.host.powered) return;
    this.term.ready(this.prompt(), { echo: true });
  }

  line(text: string) {
    if (this.running || !this.host.powered) return;
    const args = text.trim() ? this.tokenize(text) : [];
    if (args.length) this.run(args, text.trim());
    if (!this.running) this.showPrompt();
  }

  protected tokenize(text: string) {
    return splitArgs(text);
  }

  /** Marks a command as running until done(); `abort` handles Ctrl+C. */
  protected async(abort: () => void) {
    this.running = true;
    this.abortFn = abort;
    this.term.ready('', { echo: false });
  }

  protected done() {
    if (!this.running) return;
    this.running = false;
    this.abortFn = undefined;
    this.showPrompt();
  }

  help(): string {
    return '';
  }

  complete(partial: string): string {
    if (/\s/.test(partial.trim()) || !partial) return partial;
    const m = this.commands().filter((c) => c.startsWith(partial.trim().toLowerCase()));
    return m.length === 1 ? m[0] + ' ' : partial;
  }

  interrupt(kind: 'break' | 'ctrl-z') {
    if (kind !== 'break') return;
    if (this.running) {
      this.abortFn?.();
      return;
    }
    this.out('^C\n');
    this.showPrompt();
  }

  close() {
    this.closed = true;
    this.abortFn?.();
    this.host.sessions.delete(this);
  }
}
