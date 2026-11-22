import type { Mac } from '../net/mac';
import type { Link } from '../sim/engine';
import type { Device } from './device';
import type { PortSpec } from './models';

export type Duplex = 'auto' | 'full' | 'half';

/** A physical port (RJ-45, SFP, NIC). Logical interfaces (SVI, subinterfaces) live in the OS layer. */
export class Port {
  link: Link | null = null;
  /** Administrative state, controlled by `shutdown` / `no shutdown`. */
  adminUp = true;
  /** Set when the OS puts the port in err-disabled (e.g. BPDU guard). */
  errDisabled: string | null = null;
  forcedSpeed: number | null = null;
  duplex: Duplex = 'auto';
  /** Last physical state seen, used to detect transitions. */
  carrier = false;
  readonly stats = { rxFrames: 0, txFrames: 0 };

  constructor(
    readonly device: Device,
    readonly spec: PortSpec,
    readonly mac: Mac,
  ) {}

  get name() {
    return this.spec.name;
  }
  get short() {
    return this.spec.short;
  }

  /** Carrier present and not err-disabled. */
  isUp(): boolean {
    return this.carrier && !this.errDisabled;
  }

  peer(): Port | null {
    if (!this.link) return null;
    return this.link.a === this ? this.link.b : this.link.a;
  }

  /** Negotiated speed in Mbps (0 when down). */
  speed(): number {
    const p = this.peer();
    if (!p || !this.carrier) return 0;
    if (this.forcedSpeed) return this.forcedSpeed;
    if (p.forcedSpeed) return p.forcedSpeed;
    const common = this.spec.speeds.filter((s) => p.spec.speeds.includes(s));
    return Math.max(...common);
  }

  duplexOper(): 'full' | 'half' {
    if (this.duplex !== 'auto') return this.duplex;
    const p = this.peer();
    if (p && p.duplex === 'half') return 'half';
    if (p && p.device.model.kind === 'hub') return 'half';
    if (this.device.model.kind === 'hub') return 'half';
    return 'full';
  }
}
