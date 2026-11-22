import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { LabClient } from '../client';

/**
 * Console of one device. Line editing happens here (like a terminal emulator attached to a
 * console port); complete lines, "?" and Tab are sent to the server.
 */
export function DeviceTerminal({ client, deviceId, active }: { client: LabClient; deviceId: string; active: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const termRef = useRef<XTerm | null>(null);

  useEffect(() => {
    const term = new XTerm({
      fontFamily: '"Cascadia Mono", "DejaVu Sans Mono", Consolas, monospace',
      fontSize: 14,
      cursorBlink: true,
      convertEol: false,
      scrollback: 5000,
      theme: { background: '#0b1020', foreground: '#e5e7eb', cursor: '#93c5fd' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(ref.current!);
    fitRef.current = fit;
    termRef.current = term;
    setTimeout(() => fit.fit(), 0);

    let prompt = '';
    let ready = false;
    let echo = true;
    let buf = '';
    let cur = 0;
    let helpKey = false;
    const history: string[] = [];
    let hIdx = -1;

    const visibleLen = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '').length;
    const redraw = () => {
      term.write('\r\x1b[K' + prompt + (echo ? buf : ''));
      const back = echo ? buf.length - cur : 0;
      if (back > 0) term.write(`\x1b[${back}D`);
    };
    void visibleLen;

    client.registerTerminal(deviceId, {
      out: (text) => term.write(text),
      ready: (p, e) => {
        prompt = p;
        echo = e;
        ready = true;
        buf = '';
        cur = 0;
        hIdx = -1;
        term.write(prompt);
      },
      console: (text) => {
        // Asynchronous message (syslog): print it above the line being edited.
        term.write('\r\x1b[K' + text.replace(/\n/g, '\r\n') + '\r\n');
        if (ready) redraw();
      },
      closed: () => {
        ready = false;
        term.write('\r\n\x1b[33m[sessão encerrada]\x1b[0m\r\n');
      },
    });
    client.openTerminal(deviceId).then((r) => {
      helpKey = r.helpKey;
    });

    const submit = () => {
      term.write('\r\n');
      ready = false;
      const line = buf;
      if (echo && line.trim() && history[history.length - 1] !== line) history.push(line);
      buf = '';
      cur = 0;
      client.send('term:line', { deviceId, text: line });
    };

    const insert = (s: string) => {
      buf = buf.slice(0, cur) + s + buf.slice(cur);
      cur += s.length;
      if (!echo) return;
      if (cur === buf.length) term.write(s);
      else redraw();
    };

    term.onData((data) => {
      // Ctrl+C, Ctrl+Shift+6 (0x1e): break.
      if (data === '\x03' || data === '\x1e') {
        if (!ready) client.send('term:interrupt', { deviceId, kind: 'break' });
        else if (!helpKey) {
          buf = '';
          cur = 0;
          client.send('term:interrupt', { deviceId, kind: 'break' });
          ready = false;
          term.write('\r\n');
        } else {
          term.write('^C');
          buf = '';
          cur = 0;
          term.write('\r\n' + prompt);
        }
        return;
      }
      if (!ready) return;
      if (data === '\x1a') {
        client.send('term:interrupt', { deviceId, kind: 'ctrl-z' });
        term.write('^Z');
        ready = false;
        return;
      }
      if (data === '\r') return submit();
      if (data === '\x7f' || data === '\b') {
        if (cur > 0) {
          buf = buf.slice(0, cur - 1) + buf.slice(cur);
          cur--;
          if (echo) {
            if (cur === buf.length) term.write('\b \b');
            else redraw();
          }
        }
        return;
      }
      if (data === '\t') {
        if (!echo) return;
        client.emit<{ text: string }>('term:complete', { deviceId, text: buf }).then((r) => {
          if (r.text !== buf) {
            buf = r.text;
            cur = buf.length;
            redraw();
          }
        });
        return;
      }
      if (data === '?' && helpKey && echo) {
        term.write('?\r\n');
        const partial = buf;
        client.emit<{ text: string }>('term:help', { deviceId, text: partial }).then((r) => {
          term.write(r.text);
          redraw();
        });
        return;
      }
      // Arrow keys and line editing shortcuts.
      if (data === '\x1b[A' || data === '\x10') {
        if (!history.length) return;
        hIdx = hIdx < 0 ? history.length - 1 : Math.max(0, hIdx - 1);
        buf = history[hIdx];
        cur = buf.length;
        return redraw();
      }
      if (data === '\x1b[B' || data === '\x0e') {
        if (hIdx < 0) return;
        hIdx++;
        if (hIdx >= history.length) {
          hIdx = -1;
          buf = '';
        } else buf = history[hIdx];
        cur = buf.length;
        return redraw();
      }
      if (data === '\x1b[D' || data === '\x02') {
        if (cur > 0) {
          cur--;
          term.write('\x1b[D');
        }
        return;
      }
      if (data === '\x1b[C' || data === '\x06') {
        if (cur < buf.length) {
          cur++;
          term.write('\x1b[C');
        }
        return;
      }
      if (data === '\x01' || data === '\x1b[H') {
        cur = 0;
        return redraw();
      }
      if (data === '\x05' || data === '\x1b[F') {
        cur = buf.length;
        return redraw();
      }
      if (data === '\x15') {
        buf = '';
        cur = 0;
        return redraw();
      }
      if (data.startsWith('\x1b')) return;
      // Pasted text may contain several lines: run them one by one.
      const parts = data.replace(/\r\n/g, '\r').split('\r');
      parts.forEach((part, i) => {
        const clean = part.replace(/[\x00-\x1f]/g, '');
        if (clean) insert(clean);
        if (i < parts.length - 1) {
          if (ready) submit();
        }
      });
    });

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* hidden */
      }
    });
    ro.observe(ref.current!);
    return () => {
      ro.disconnect();
      client.unregisterTerminal(deviceId);
      term.dispose();
    };
  }, [client, deviceId]);

  useEffect(() => {
    if (active) {
      setTimeout(() => {
        try {
          fitRef.current?.fit();
        } catch {
          /* ignore */
        }
        termRef.current?.focus();
      }, 0);
    }
  }, [active]);

  return <div className="xterm-host" ref={ref} style={{ display: active ? 'block' : 'none' }} />;
}
