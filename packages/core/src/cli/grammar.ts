/**
 * Declarative command grammar used by vendor CLIs.
 *
 * Commands are declared with a compact syntax, e.g.
 *   "ip address <ipv4:addr> <ipv4:mask>"
 *   "switchport access vlan <int:vlan:1-4094>"
 *   "description <line:text>"
 * and merged into a token tree per mode. The parser implements the behaviour students
 * expect from real equipment: unique-prefix abbreviations, context help with "?",
 * Tab completion and IOS-style error messages.
 */
import { parseIPv4 } from '../net/ipv4';
import { parseIPv6, parsePrefix6 } from '../net/ipv6';
import { normalizeMac } from '../net/mac';

export type ParamKind = 'word' | 'line' | 'ipv4' | 'ipv6' | 'ipv6prefix' | 'int' | 'iface' | 'mac' | 'vlanlist' | 'hex';

export interface ParamSpec {
  kind: ParamKind;
  name: string;
  min?: number;
  max?: number;
}

export interface Args {
  /** Parameter values by name. */
  p: Record<string, string>;
  /** Keywords present in the matched path (full names). */
  kw: Set<string>;
  /** The command was prefixed by "no". */
  no: boolean;
  /** Raw input line. */
  raw: string;
}

export type Handler<C> = (ctx: C, a: Args) => void;

export interface GNode<C> {
  kw?: string;
  param?: ParamSpec;
  help: string;
  children: GNode<C>[];
  run?: Handler<C>;
  hidden?: boolean;
}

export interface ParseEnv {
  /** Resolves an interface reference ("gi0/1", "vlan 10") to its canonical name, or null. */
  iface?(text: string): string | null;
  /** Interface types for "?" after an interface parameter. */
  ifaceTypes?(): [string, string][];
}

const PARAM_LABEL: Record<ParamKind, string> = {
  word: 'WORD',
  line: 'LINE',
  ipv4: 'A.B.C.D',
  ipv6: 'X:X:X:X::X',
  ipv6prefix: 'X:X:X:X::X/<0-128>',
  int: '<0-4294967295>',
  iface: '',
  mac: 'H.H.H',
  vlanlist: 'WORD',
  hex: 'Hex-data',
};

export function paramLabel(p: ParamSpec): string {
  if (p.kind === 'int' && p.min !== undefined && p.max !== undefined) return `<${p.min}-${p.max}>`;
  return PARAM_LABEL[p.kind];
}

export function validVlanList(s: string): boolean {
  if (!/^[\d,-]+$/.test(s)) return false;
  for (const part of s.split(',')) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) return false;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (a < 1 || b > 4094 || b < a) return false;
  }
  return true;
}

export function parseVlanList(s: string): number[] {
  const out: number[] = [];
  for (const part of s.split(',')) {
    const [a, b] = part.split('-').map(Number);
    for (let v = a; v <= (b ?? a); v++) out.push(v);
  }
  return out;
}

export class Grammar<C> {
  readonly roots = new Map<string, GNode<C>>();

  constructor(private readonly kwHelp: Record<string, string> = {}) {}

  root(mode: string): GNode<C> {
    let r = this.roots.get(mode);
    if (!r) this.roots.set(mode, (r = { help: '', children: [] }));
    return r;
  }

  /**
   * Adds a command. `helps` gives help text for keywords/params in this command
   * (by keyword or by param name); defaults come from the shared keyword dictionary.
   * Prefix a keyword with "~" to hide it from "?" (undocumented aliases).
   */
  add(modes: string | string[], syntax: string, run: Handler<C>, helps: Record<string, string> = {}) {
    for (const mode of Array.isArray(modes) ? modes : [modes]) {
      let node = this.root(mode);
      const toks = syntax.trim().split(/\s+/);
      for (const raw of toks) {
        let next: GNode<C> | undefined;
        const m = /^<(\w+):([\w-]+)(?::(\d+)-(\d+))?>$/.exec(raw);
        if (m) {
          const spec: ParamSpec = { kind: m[1] as ParamKind, name: m[2], min: m[3] ? Number(m[3]) : undefined, max: m[4] ? Number(m[4]) : undefined };
          next = node.children.find((c) => c.param && c.param.name === spec.name && c.param.kind === spec.kind && c.param.min === spec.min && c.param.max === spec.max);
          if (!next) {
            next = { param: spec, help: helps[spec.name] ?? this.kwHelp[`<${spec.name}>`] ?? '', children: [] };
            node.children.push(next);
          } else if (!next.help && helps[spec.name]) next.help = helps[spec.name];
        } else {
          const hidden = raw.startsWith('~');
          const kw = hidden ? raw.slice(1) : raw;
          next = node.children.find((c) => c.kw === kw);
          if (!next) {
            next = { kw, help: helps[kw] ?? this.kwHelp[kw] ?? '', children: [], hidden };
            node.children.push(next);
          } else if (helps[kw]) next.help = helps[kw];
        }
        node = next;
      }
      node.run = run;
    }
  }
}

export interface Token {
  text: string;
  start: number;
}

export function tokenize(line: string): Token[] {
  const out: Token[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) out.push({ text: m[0], start: m.index });
  return out;
}

export type ParseResult<C> =
  | { kind: 'ok'; run: Handler<C>; args: Args }
  | { kind: 'invalid'; pos: number }
  | { kind: 'incomplete' }
  | { kind: 'ambiguous' }
  | { kind: 'empty' };

function paramAccepts(p: ParamSpec, tok: string, env: ParseEnv): boolean {
  switch (p.kind) {
    case 'word':
    case 'line':
      return true;
    case 'ipv4':
      return parseIPv4(tok) !== null;
    case 'ipv6':
      return parseIPv6(tok) !== null;
    case 'ipv6prefix':
      return parsePrefix6(tok) !== null;
    case 'int': {
      if (!/^\d+$/.test(tok)) return false;
      const n = Number(tok);
      return (p.min === undefined || n >= p.min) && (p.max === undefined || n <= p.max);
    }
    case 'iface':
      return !!env.iface?.(tok);
    case 'mac':
      return normalizeMac(tok) !== null;
    case 'vlanlist':
      return validVlanList(tok);
    case 'hex':
      return /^[0-9a-fA-F]+$/.test(tok);
  }
}

interface Step<C> {
  node: GNode<C>;
  consumed: number;
}

/** Finds the child matching tokens[i] (may consume 2 tokens for split interface names). */
function matchChild<C>(node: GNode<C>, toks: Token[], i: number, env: ParseEnv): Step<C> | 'ambiguous' | null {
  const t = toks[i].text;
  const lower = t.toLowerCase();
  const kws = node.children.filter((c) => c.kw !== undefined && c.kw.toLowerCase().startsWith(lower));
  const exact = kws.find((c) => c.kw!.toLowerCase() === lower);
  if (exact) return { node: exact, consumed: 1 };
  const visible = kws.filter((c) => !c.hidden);
  if (visible.length === 1 || (visible.length === 0 && kws.length === 1)) return { node: visible[0] ?? kws[0], consumed: 1 };
  if (visible.length > 1) {
    // A parameter could still accept the token (e.g. a WORD), but IOS reports ambiguity first.
    return 'ambiguous';
  }
  for (const c of node.children) {
    if (!c.param) continue;
    if (c.param.kind === 'iface') {
      if (i + 1 < toks.length && /^[a-zA-Z-]+$/.test(t) && env.iface?.(`${t}${toks[i + 1].text}`)) return { node: c, consumed: 2 };
      if (env.iface?.(t)) return { node: c, consumed: 1 };
      continue;
    }
    if (c.param.kind === 'line') return { node: c, consumed: toks.length - i };
    if (paramAccepts(c.param, t, env)) return { node: c, consumed: 1 };
  }
  return null;
}

export function parse<C>(g: Grammar<C>, mode: string, line: string, env: ParseEnv): ParseResult<C> {
  const toks = tokenize(line);
  if (!toks.length) return { kind: 'empty' };
  let node = g.root(mode);
  const args: Args = { p: {}, kw: new Set(), no: false, raw: line };
  let i = 0;
  while (i < toks.length) {
    const r = matchChild(node, toks, i, env);
    if (r === 'ambiguous') return { kind: 'ambiguous' };
    if (!r) return { kind: 'invalid', pos: toks[i].start };
    const n = r.node;
    if (n.kw !== undefined) args.kw.add(n.kw);
    else if (n.param) {
      if (n.param.kind === 'line') {
        args.p[n.param.name] = line.slice(toks[i].start);
      } else if (n.param.kind === 'iface') {
        const text = toks
          .slice(i, i + r.consumed)
          .map((t) => t.text)
          .join('');
        args.p[n.param.name] = env.iface!(text)!;
      } else args.p[n.param.name] = toks[i].text;
    }
    if (i === 0 && n.kw === 'no') args.no = true;
    node = n;
    i += r.consumed;
  }
  if (!node.run) return { kind: 'incomplete' };
  return { kind: 'ok', run: node.run, args };
}

/** Walks the tree for the complete tokens of a partial line. */
function walk<C>(g: Grammar<C>, mode: string, toks: Token[], env: ParseEnv): GNode<C> | null {
  let node = g.root(mode);
  let i = 0;
  while (i < toks.length) {
    const r = matchChild(node, toks, i, env);
    if (!r || r === 'ambiguous') return null;
    if (r.node.param?.kind === 'line') return r.node;
    node = r.node;
    i += r.consumed;
  }
  return node;
}

function formatHelpList(items: [string, string][]): string {
  if (!items.length) return '';
  const w = Math.max(...items.map(([k]) => k.length));
  const col = Math.max(w + 2, 16);
  return items.map(([k, h]) => `  ${h ? k.padEnd(col) + h : k}`).join('\r\n') + '\r\n';
}

/**
 * Context help for the partial line (text before "?").
 * Returns the text to print, or null when the input is invalid (caller prints the error).
 */
export function help<C>(g: Grammar<C>, mode: string, partial: string, env: ParseEnv): { text: string } | { invalidAt: number } {
  const endsWithSpace = partial.length === 0 || /\s$/.test(partial);
  const toks = tokenize(partial);
  const complete = endsWithSpace ? toks : toks.slice(0, -1);
  const node = walk(g, mode, complete, env);
  if (!node) {
    // Locate the first failing token for the caret.
    let n = g.root(mode);
    for (let i = 0; i < complete.length; i++) {
      const r = matchChild(n, complete, i, env);
      if (!r || r === 'ambiguous') return { invalidAt: complete[i].start };
      n = r.node;
    }
    return { invalidAt: partial.length };
  }
  if (endsWithSpace) {
    if (node.param?.kind === 'line' && complete.length) return { text: '  LINE    <cr>\r\n' };
    const items: [string, string][] = [];
    const kws = node.children.filter((c) => c.kw !== undefined && !c.hidden).sort((a, b) => a.kw!.localeCompare(b.kw!));
    for (const c of kws) items.push([c.kw!, c.help]);
    for (const c of node.children) {
      if (!c.param) continue;
      if (c.param.kind === 'iface' && env.ifaceTypes) items.push(...env.ifaceTypes());
      else items.push([paramLabel(c.param), c.help]);
    }
    if (node.run) items.push(['<cr>', '']);
    return { text: formatHelpList(items) };
  }
  // Partial word: list keywords starting with it.
  const last = toks[toks.length - 1].text.toLowerCase();
  const names = node.children.filter((c) => c.kw !== undefined && !c.hidden && c.kw.toLowerCase().startsWith(last)).map((c) => c.kw!);
  const params = node.children.filter((c) => c.param && c.param.kind !== 'iface' && paramAccepts(c.param, last, env));
  if (!names.length && !params.length) {
    if (node.children.some((c) => c.param?.kind === 'iface') && env.ifaceTypes) {
      const types = env.ifaceTypes().filter(([t]) => t.toLowerCase().startsWith(last));
      if (types.length) return { text: types.map(([t]) => t).join('  ') + '  \r\n' };
    }
    return { invalidAt: toks[toks.length - 1].start };
  }
  return { text: [...names.sort(), ...params.map((p) => paramLabel(p.param!))].join('  ') + '  \r\n' };
}

/** Tab completion of the last keyword. */
export function complete<C>(g: Grammar<C>, mode: string, partial: string, env: ParseEnv): string {
  if (!partial || /\s$/.test(partial)) return partial;
  const toks = tokenize(partial);
  const node = walk(g, mode, toks.slice(0, -1), env);
  if (!node) return partial;
  const last = toks[toks.length - 1];
  const lower = last.text.toLowerCase();
  const names = node.children.filter((c) => c.kw !== undefined && !c.hidden && c.kw.toLowerCase().startsWith(lower));
  if (names.length === 1) return partial.slice(0, last.start) + names[0].kw + ' ';
  // Interface type completion ("gi" + Tab → "GigabitEthernet").
  if (!names.length && env.ifaceTypes && node.children.some((c) => c.param?.kind === 'iface')) {
    const m = /^([a-zA-Z-]+)(.*)$/.exec(last.text);
    if (m) {
      const types = env.ifaceTypes().filter(([t]) => t.toLowerCase().startsWith(m[1].toLowerCase()));
      if (types.length === 1) return partial.slice(0, last.start) + types[0][0] + m[2];
    }
  }
  return partial;
}
