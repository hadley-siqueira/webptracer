import { Device, type DeviceState, type PortView } from './device';
import type { Port } from './port';
import type { EthernetFrame } from '../net/packets';
import type { Terminal, CliSession } from '../cli/session';

/** Layer 1 repeater: every frame is repeated on all other ports (one collision domain). */
export class Hub extends Device {
  protected receive(p: Port, f: EthernetFrame, traceId: number) {
    const outs = this.ports.filter((o) => o !== p && o.isUp());
    this.note(`Hub: repetindo o sinal recebido em ${p.short} para ${outs.length} porta(s) — o hub não lê endereços MAC`, 'info', traceId);
    for (const o of outs) this.send(o, f);
  }
  protected boot() {}
  protected shutdownOs() {}
  protected onCarrier() {}
  portViews(): PortView[] {
    return this.ports.map((p) => ({ name: p.name, short: p.short, connected: !!p.link, up: p.isUp(), led: p.isUp() ? 'green' : 'off', info: '' }));
  }
  exportState(): DeviceState {
    return { running: '' };
  }
  importState() {}
  openSession(term: Terminal): CliSession {
    term.write('Este equipamento não possui interface de linha de comando.\r\n');
    return { line() {}, help: () => '', complete: (p) => p, interrupt() {}, close() {}, busy: false };
  }
  summary() {
    return '';
  }
}
