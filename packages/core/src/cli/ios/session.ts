import type { CliSession, Terminal } from '../session';
import { complete, help, parse, type ParseEnv } from '../grammar';
import type { IosDevice, IosIf, LineCfg } from '../../devices/ios';
import type { DhcpPool } from '../../l3/stack';
import type { Acl } from '../../l3/acl';
import { iosGrammar } from './commands';
import { type5Verify } from './passwords';
import { IF_TYPES } from '../../devices/ios';

export type IosMode = 'user' | 'priv' | 'config' | 'if' | 'subif' | 'ifrange' | 'vlan' | 'line' | 'dhcp' | 'stdacl' | 'extacl';

const MODE_PROMPT: Record<IosMode, string> = {
  user: '>',
  priv: '#',
  config: '(config)#',
  if: '(config-if)#',
  subif: '(config-subif)#',
  ifrange: '(config-if-range)#',
  vlan: '(config-vlan)#',
  line: '(config-line)#',
  dhcp: '(dhcp-config)#',
  stdacl: '(config-std-nacl)#',
  extacl: '(config-ext-nacl)#',
};

type State = 'press-return' | 'login' | 'enable-pass' | 'ready' | 'busy' | 'question' | 'banner' | 'off';

export class IosSession implements CliSession {
  mode: IosMode = 'user';
  ifCtx: IosIf[] = [];
  vlanCtx: number[] = [];
  lineCtx: LineCfg[] = [];
  poolCtx?: DhcpPool;
  aclCtx?: Acl;
  private state: State = 'press-return';
  private tries = 0;
  private questionCb?: (answer: string) => void;
  private questionEcho = true;
  private questionPrompt = '';
  private bannerCb?: (text: string) => void;
  private bannerDelim = '';
  private bannerBuf: string[] = [];
  private abortFn?: () => void;
  /** Script mode (config load): no terminal, errors ignored. */
  readonly scripted: boolean;
  readonly history: string[] = [];
  private closed = false;

  constructor(
    readonly dev: IosDevice,
    private readonly term: Terminal | null,
  ) {
    this.scripted = term === null;
  }

  get busy() {
    return this.state === 'busy';
  }

  get env(): ParseEnv {
    return {
      iface: (t) => this.dev.resolveIfName(t),
      ifaceTypes: () => this.dev.ifTypes().map((t) => [t, IF_TYPES[t]?.help ?? `${t} interface`] as [string, string]),
    };
  }

  // ===================================================================== output

  out(text: string) {
    if (!this.term) return;
    this.term.write(text.replace(/\r?\n/g, '\r\n'));
  }

  println(text = '') {
    this.out(text + '\n');
  }

  prompt(): string {
    return this.dev.hostname + MODE_PROMPT[this.mode];
  }

  private showPrompt() {
    if (!this.term || this.closed) return;
    switch (this.state) {
      case 'ready':
        this.term.ready(this.prompt(), { echo: true });
        break;
      case 'login':
      case 'enable-pass':
        this.term.ready('Password: ', { echo: false });
        break;
      case 'question':
        this.term.ready(this.questionPrompt, { echo: this.questionEcho });
        break;
      case 'banner':
        this.term.ready('', { echo: true });
        break;
      case 'press-return':
        this.term.ready('', { echo: false });
        break;
      default:
        break;
    }
  }

  // ===================================================================== lifecycle

  start() {
    if (!this.dev.powered) {
      this.state = 'off';
      return;
    }
    this.state = 'press-return';
    this.println(`\n${this.dev.hostname} con0 is now available\n\n\n\n\nPress RETURN to get started.\n`);
    this.showPrompt();
  }

  /** Device rebooted: print the boot banner and wait for RETURN. */
  reboot() {
    this.mode = 'user';
    this.ifCtx = [];
    const sw = this.dev.model.software;
    this.println('');
    this.println('System Bootstrap, Version 15.0(1r)M15, RELEASE SOFTWARE (fc1)');
    this.println('Copyright (c) 1986-2026 by cisco Systems, Inc.');
    this.println('');
    this.println(`Booting ${sw?.image.toLowerCase() ?? 'ios'}.bin ...`);
    this.println('Self decompressing the image : ########################################## [OK]');
    this.println('');
    this.println(sw?.banner ?? 'Cisco IOS Software');
    this.println('Technical Support: http://www.cisco.com/techsupport');
    this.println('');
    this.println(`cisco ${this.dev.model.id} processor with ${sw?.memory ?? '512K'} bytes of memory.`);
    this.println(`${this.dev.ports.length} Ethernet interfaces`);
    this.println('');
    if (!this.dev.startup) {
      this.println('         --- System Configuration Dialog ---');
      this.println('');
      this.println('Continue with configuration dialog? [yes/no]: no');
    }
    this.println('');
    this.println('Press RETURN to get started!');
    this.println('');
    this.state = 'press-return';
    this.showPrompt();
  }

  powerLost() {
    this.state = 'off';
    this.abortFn?.();
    this.abortFn = undefined;
  }

  close() {
    this.closed = true;
    this.abortFn?.();
    this.dev.sessions.delete(this);
  }

  private greet() {
    if (this.dev.motd) this.println(this.dev.motd);
    const con = this.dev.lineCon;
    if (con.login && (con.password || con.login === 'local')) {
      this.println('\nUser Access Verification\n');
      this.state = 'login';
      this.tries = 0;
    } else {
      this.state = 'ready';
      this.mode = 'user';
    }
    this.showPrompt();
  }

  // ===================================================================== input

  line(text: string) {
    switch (this.state) {
      case 'off':
      case 'busy':
        return;
      case 'press-return':
        this.greet();
        return;
      case 'login': {
        const pw = this.dev.lineCon.password;
        if (pw !== undefined && text === pw) {
          this.state = 'ready';
          this.mode = 'user';
        } else if (++this.tries >= 3) {
          this.println('% Bad passwords\n');
          this.state = 'press-return';
        }
        this.showPrompt();
        return;
      }
      case 'enable-pass': {
        if (this.checkEnable(text)) {
          this.state = 'ready';
          this.mode = 'priv';
        } else if (++this.tries >= 3) {
          this.println('% Bad secrets\n');
          this.state = 'ready';
        }
        this.showPrompt();
        return;
      }
      case 'question': {
        const cb = this.questionCb!;
        this.questionCb = undefined;
        this.state = 'ready';
        cb(text);
        if (this.state === 'ready') this.showPrompt();
        return;
      }
      case 'banner':
        this.bannerLine(text);
        if ((this.state as State) === 'ready') this.showPrompt();
        return;
      case 'ready':
        if (text.trim()) {
          this.history.push(text);
          if (this.history.length > 20) this.history.shift();
        }
        this.execute(text);
        if (this.state === 'ready') this.showPrompt();
    }
  }

  private checkEnable(pw: string): boolean {
    const d = this.dev;
    if (d.enableSecret) return type5Verify(pw, d.enableSecret);
    if (d.enablePassword !== undefined) return pw === d.enablePassword;
    return true;
  }

  /** "enable": asks for the password when one is configured. */
  enable() {
    const d = this.dev;
    if (!d.enableSecret && d.enablePassword === undefined) {
      this.mode = 'priv';
      return;
    }
    this.state = 'enable-pass';
    this.tries = 0;
  }

  interrupt(kind: 'break' | 'ctrl-z') {
    if (this.state === 'busy') {
      if (kind === 'break') {
        this.abortFn?.();
      }
      return;
    }
    if (kind === 'ctrl-z' && this.state === 'ready' && this.isConfigMode()) {
      this.println('');
      this.endConfig();
      this.showPrompt();
    }
  }

  isConfigMode() {
    return this.mode !== 'user' && this.mode !== 'priv';
  }

  endConfig() {
    this.mode = 'priv';
    this.ifCtx = [];
    if (!this.scripted) this.dev.timer(200, () => this.dev.log('%SYS-5-CONFIG_I: Configured from console by console'));
  }

  /** Leaves a sub-mode ("exit"). */
  exitMode() {
    if (this.mode === 'config') this.endConfig();
    else if (this.isConfigMode()) {
      this.mode = 'config';
      this.ifCtx = [];
    }
  }

  // ===================================================================== async helpers

  /** Marks the session busy until `done()` is called. `abort` handles Ctrl+C / Ctrl+Shift+6. */
  async(abort?: () => void) {
    this.state = 'busy';
    this.abortFn = abort;
    this.term?.ready('', { echo: false });
  }

  done() {
    if (this.state !== 'busy') return;
    this.abortFn = undefined;
    this.state = 'ready';
    this.showPrompt();
  }

  /** Asks a question ("[confirm]", "Destination filename [startup-config]?"). */
  ask(prompt: string, cb: (answer: string) => void, echo = true) {
    this.state = 'question';
    this.questionPrompt = prompt;
    this.questionEcho = echo;
    this.questionCb = cb;
  }

  /** Banner input: "banner motd #text#" possibly spanning several lines. */
  startBanner(rest: string, cb: (text: string) => void) {
    const r = rest.trim();
    let delim: string;
    let body: string;
    if (r.startsWith('^C')) {
      delim = '^C';
      body = r.slice(2);
    } else {
      delim = r[0];
      body = r.slice(1);
    }
    const end = body.indexOf(delim);
    if (end >= 0) {
      cb(body.slice(0, end));
      return;
    }
    this.bannerDelim = delim;
    this.bannerBuf = body ? [body] : [];
    this.bannerCb = cb;
    this.state = 'banner';
    if (!this.scripted) this.println(`Enter TEXT message.  End with the character '${delim}'.`);
  }

  private bannerLine(text: string) {
    const end = text.indexOf(this.bannerDelim);
    if (end >= 0) {
      this.bannerBuf.push(text.slice(0, end));
      const t = this.bannerBuf.join('\n');
      this.state = 'ready';
      this.bannerCb?.(t);
      this.bannerCb = undefined;
      return;
    }
    this.bannerBuf.push(text);
  }

  // ===================================================================== execution

  private grammarMode(): string {
    return this.mode;
  }

  error(kind: 'invalid' | 'incomplete' | 'ambiguous', text: string, pos = 0) {
    if (kind === 'invalid') {
      this.println(' '.repeat(this.prompt().length + pos) + '^');
      this.println("% Invalid input detected at '^' marker.\n");
    } else if (kind === 'incomplete') this.println('% Incomplete command.\n');
    else this.println(`% Ambiguous command:  "${text.trim()}"`);
  }

  execute(text: string) {
    if (!text.trim()) return;
    const g = iosGrammar();
    // "do" runs an EXEC command from configuration mode.
    const doMatch = /^\s*do\s+(.*)$/i.exec(text);
    if (doMatch && this.isConfigMode()) {
      const r = parse(g, 'priv', doMatch[1], this.env);
      if (r.kind === 'ok') r.run(this, r.args);
      else if (r.kind === 'invalid') this.error('invalid', text, r.pos + (text.length - doMatch[1].length));
      else if (r.kind !== 'empty') this.error(r.kind, doMatch[1]);
      return;
    }
    const r = parse(g, this.grammarMode(), text, this.env);
    if (this.isConfigMode() && !this.scripted) this.dev.dirty = true;
    if (r.kind === 'ok') {
      r.run(this, r.args);
      return;
    }
    // Sub-modes fall back to global configuration commands.
    if (this.isConfigMode() && this.mode !== 'config' && r.kind === 'invalid') {
      const r2 = parse(g, 'config', text, this.env);
      if (r2.kind === 'ok') {
        this.mode = 'config';
        this.ifCtx = [];
        r2.run(this, r2.args);
        return;
      }
    }
    if (r.kind === 'empty') return;
    if (r.kind === 'invalid' && (this.mode === 'user' || this.mode === 'priv') && !/\s/.test(text.trim())) {
      this.unknownHost(text.trim());
      return;
    }
    if (r.kind === 'invalid') this.error('invalid', text, r.pos);
    else this.error(r.kind, text);
  }

  /** IOS treats an unknown single word as a host name to telnet to. */
  private unknownHost(word: string) {
    if (!this.dev.domainLookup) {
      this.println(`Translating "${word}"`);
      this.println('% Unknown command or computer name, or unable to find computer address');
      return;
    }
    this.out(`Translating "${word}"...domain server (255.255.255.255)`);
    let aborted = false;
    this.async(() => {
      aborted = true;
      this.println('');
      this.println('% Unknown command or computer name, or unable to find computer address');
      this.done();
    });
    const step = (n: number) => {
      if (aborted) return;
      if (n < 3) {
        this.out(' .');
        this.dev.timer(1500, () => step(n + 1));
        return;
      }
      this.println('');
      this.println('% Unknown command or computer name, or unable to find computer address');
      this.done();
    };
    this.dev.timer(1500, () => step(0));
  }

  help(partial: string): string {
    if (this.state !== 'ready') return '';
    const g = iosGrammar();
    const doMatch = /^\s*do\s+(.*)$/i.exec(partial);
    let r;
    if (doMatch && this.isConfigMode()) r = help(g, 'priv', doMatch[1], this.env);
    else r = help(g, this.grammarMode(), partial, this.env);
    if ('text' in r) return r.text.replace(/\r?\n/g, '\r\n');
    const offset = doMatch && this.isConfigMode() ? partial.length - doMatch[1].length : 0;
    return (' '.repeat(this.prompt().length + r.invalidAt + offset) + '^\r\n' + "% Invalid input detected at '^' marker.\r\n\r\n");
  }

  complete(partial: string): string {
    if (this.state !== 'ready') return partial;
    const g = iosGrammar();
    const doMatch = /^(\s*do\s+)(.*)$/i.exec(partial);
    if (doMatch && this.isConfigMode()) return doMatch[1] + complete(g, 'priv', doMatch[2], this.env);
    return complete(g, this.grammarMode(), partial, this.env);
  }

  /** Applies a configuration text (startup-config / lab import). */
  runConfigScript(text: string) {
    this.mode = 'config';
    this.state = 'ready';
    for (const raw of text.split(/\r?\n/)) {
      if ((this.state as State) === 'banner') {
        this.line(raw);
        continue;
      }
      const line = raw.replace(/\s+$/, '');
      const t = line.trim();
      if (!t || t.startsWith('!')) continue;
      if (t === 'end') break;
      // Indented lines belong to the current sub-mode; others to global config.
      if (!/^\s/.test(line) && this.mode !== 'config') {
        this.mode = 'config';
        this.ifCtx = [];
      }
      this.execute(t);
      if ((this.mode as IosMode) === 'priv' || (this.mode as IosMode) === 'user') this.mode = 'config';
    }
    this.mode = 'priv';
  }
}
