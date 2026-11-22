/**
 * Hardware catalog. Each model describes real equipment: its ports (names as printed by
 * the OS), physical properties and the front panel layout used by the rack view.
 *
 * Panel coordinates are in "panel units": a 19" rack unit is 480 x 44 units.
 */

export type DeviceKind = 'router' | 'switch' | 'l3switch' | 'hub' | 'pc' | 'laptop' | 'server';
export type OsKind = 'ios' | 'iosxe' | 'windows' | 'linux' | 'none';

export interface PanelItem {
  x: number;
  y: number;
  w: number;
  h: number;
  /** rj45 / sfp sockets show a link LED; console / usb are decorative. */
  kind: 'rj45' | 'sfp' | 'console' | 'usb' | 'label' | 'led' | 'power';
  label?: string;
  /** Upside-down RJ45 (bottom row of a switch). */
  flipped?: boolean;
}

export interface PortSpec {
  name: string;
  short: string;
  media: 'copper' | 'fiber';
  /** Supported speeds in Mbps. */
  speeds: number[];
  mdix: boolean;
  /** Physical role without auto-MDIX: hosts/routers are MDI, switches/hubs are MDI-X. */
  mdi: 'mdi' | 'mdix';
  poe?: boolean;
  panel: PanelItem;
}

export interface HardwareModel {
  id: string;
  vendor: string;
  name: string;
  kind: DeviceKind;
  os: OsKind;
  description: string;
  /** Height in rack units (hosts are not rack mounted: 0). */
  ru: number;
  panelColor: string;
  ports: PortSpec[];
  decorations: PanelItem[];
  oui: string;
  /** Default hostname, as shipped. */
  defaultName: string;
  caps: { switching: boolean; routing: boolean; routedPorts: boolean };
  software?: { version: string; image: string; banner: string; memory: string; flash: string; serialPrefix: string };
}

function rj45(x: number, y: number, flipped = false): PanelItem {
  return { x, y, w: 14, h: 12, kind: 'rj45', flipped };
}
function sfp(x: number, y: number): PanelItem {
  return { x, y, w: 14, h: 10, kind: 'sfp' };
}

function copper(name: string, short: string, speeds: number[], mdix: boolean, mdi: 'mdi' | 'mdix', panel: PanelItem, poe = false): PortSpec {
  return { name, short, media: 'copper', speeds, mdix, mdi, panel, poe };
}

// --------------------------------------------------------------------------- switches

function catalyst2960(): HardwareModel {
  const ports: PortSpec[] = [];
  // 24 FastEthernet ports in two rows of 12 (odd on top, even below), groups of 6.
  for (let i = 1; i <= 24; i++) {
    const col = Math.floor((i - 1) / 2);
    const top = i % 2 === 1;
    const x = 110 + col * 16 + Math.floor(col / 6) * 6;
    const y = top ? 8 : 24;
    ports.push(copper(`FastEthernet0/${i}`, `Fa0/${i}`, [10, 100], true, 'mdix', rj45(x, y, !top)));
  }
  ports.push(copper('GigabitEthernet0/1', 'Gi0/1', [10, 100, 1000], true, 'mdix', rj45(330, 16)));
  ports.push(copper('GigabitEthernet0/2', 'Gi0/2', [10, 100, 1000], true, 'mdix', rj45(350, 16)));
  return {
    id: 'WS-C2960-24TT-L',
    vendor: 'Cisco',
    name: 'Catalyst 2960-24TT',
    kind: 'switch',
    os: 'ios',
    description: 'Switch de acesso camada 2, 24 portas Fast Ethernet + 2 Gigabit Ethernet',
    ru: 1,
    panelColor: '#3b6e8f',
    ports,
    decorations: [
      { x: 8, y: 6, w: 60, h: 10, kind: 'label', label: 'Catalyst 2960' },
      { x: 8, y: 22, w: 6, h: 4, kind: 'led', label: 'SYST' },
      { x: 20, y: 22, w: 6, h: 4, kind: 'led', label: 'STAT' },
      { x: 400, y: 14, w: 16, h: 14, kind: 'console', label: 'CONSOLE' },
      { x: 450, y: 14, w: 16, h: 14, kind: 'power' },
    ],
    oui: '00:1b:2a',
    defaultName: 'Switch',
    caps: { switching: true, routing: false, routedPorts: false },
    software: {
      version: '15.0(2)SE11',
      image: 'C2960-LANBASEK9-M',
      banner: 'Cisco IOS Software, C2960 Software (C2960-LANBASEK9-M), Version 15.0(2)SE11, RELEASE SOFTWARE (fc3)',
      memory: '65536K/8192K',
      flash: '64016K',
      serialPrefix: 'FOC',
    },
  };
}

function catalyst3650(): HardwareModel {
  const ports: PortSpec[] = [];
  for (let i = 1; i <= 24; i++) {
    const col = Math.floor((i - 1) / 2);
    const top = i % 2 === 1;
    const x = 110 + col * 16 + Math.floor(col / 6) * 6;
    ports.push(copper(`GigabitEthernet1/0/${i}`, `Gi1/0/${i}`, [10, 100, 1000], true, 'mdix', rj45(x, top ? 8 : 24, !top), true));
  }
  for (let i = 1; i <= 4; i++) {
    ports.push({ name: `GigabitEthernet1/1/${i}`, short: `Gi1/1/${i}`, media: 'fiber', speeds: [1000], mdix: false, mdi: 'mdix', panel: sfp(320 + (i - 1) * 18, 16) });
  }
  return {
    id: 'WS-C3650-24PS',
    vendor: 'Cisco',
    name: 'Catalyst 3650-24PS',
    kind: 'l3switch',
    os: 'iosxe',
    description: 'Switch multicamada (L3), 24 portas Gigabit PoE+ e 4 uplinks SFP',
    ru: 1,
    panelColor: '#2f5d7c',
    ports,
    decorations: [
      { x: 8, y: 6, w: 60, h: 10, kind: 'label', label: 'Catalyst 3650' },
      { x: 8, y: 22, w: 6, h: 4, kind: 'led', label: 'SYST' },
      { x: 20, y: 22, w: 6, h: 4, kind: 'led', label: 'ACTV' },
      { x: 410, y: 14, w: 16, h: 14, kind: 'console', label: 'CON' },
      { x: 450, y: 14, w: 16, h: 14, kind: 'power' },
    ],
    oui: '00:2a:10',
    defaultName: 'Switch',
    caps: { switching: true, routing: true, routedPorts: true },
    software: {
      version: '16.3.7',
      image: 'CAT3K_CAA-UNIVERSALK9-M',
      banner: 'Cisco IOS Software [Denali], Catalyst L3 Switch Software (CAT3K_CAA-UNIVERSALK9-M), Version 16.3.7, RELEASE SOFTWARE (fc4)',
      memory: '4194304K/6147K',
      flash: '1611414K',
      serialPrefix: 'FDO',
    },
  };
}

// --------------------------------------------------------------------------- routers

function isr4331(): HardwareModel {
  return {
    id: 'ISR4331',
    vendor: 'Cisco',
    name: 'ISR 4331',
    kind: 'router',
    os: 'iosxe',
    description: 'Roteador de serviços integrados, 3 portas Gigabit Ethernet (Gi0/0/2 combo RJ-45/SFP)',
    ru: 1,
    panelColor: '#4a5560',
    ports: [
      copper('GigabitEthernet0/0/0', 'Gi0/0/0', [10, 100, 1000], true, 'mdi', rj45(200, 16)),
      copper('GigabitEthernet0/0/1', 'Gi0/0/1', [10, 100, 1000], true, 'mdi', rj45(222, 16)),
      copper('GigabitEthernet0/0/2', 'Gi0/0/2', [10, 100, 1000], true, 'mdi', rj45(244, 16)),
    ],
    decorations: [
      { x: 10, y: 6, w: 60, h: 10, kind: 'label', label: 'ISR 4331' },
      { x: 120, y: 14, w: 16, h: 14, kind: 'console', label: 'CON' },
      { x: 146, y: 16, w: 12, h: 8, kind: 'usb', label: 'USB' },
      { x: 300, y: 10, w: 90, h: 24, kind: 'label', label: 'NIM 1   NIM 2' },
      { x: 450, y: 14, w: 16, h: 14, kind: 'power' },
    ],
    oui: '00:5f:86',
    defaultName: 'Router',
    caps: { switching: false, routing: true, routedPorts: true },
    software: {
      version: '16.9.4',
      image: 'X86_64_LINUX_IOSD-UNIVERSALK9-M',
      banner: 'Cisco IOS XE Software, Version 16.09.04\nCisco IOS Software [Fuji], ISR Software (X86_64_LINUX_IOSD-UNIVERSALK9-M), Version 16.9.4, RELEASE SOFTWARE (fc2)',
      memory: '1795979K/6147K',
      flash: '3207167K',
      serialPrefix: 'FDO',
    },
  };
}

function cisco1941(): HardwareModel {
  return {
    id: 'CISCO1941/K9',
    vendor: 'Cisco',
    name: 'Cisco 1941',
    kind: 'router',
    os: 'ios',
    description: 'Roteador de serviços integrados G2, 2 portas Gigabit Ethernet',
    ru: 2,
    panelColor: '#56606b',
    ports: [
      copper('GigabitEthernet0/0', 'Gi0/0', [10, 100, 1000], true, 'mdi', rj45(260, 50)),
      copper('GigabitEthernet0/1', 'Gi0/1', [10, 100, 1000], true, 'mdi', rj45(282, 50)),
    ],
    decorations: [
      { x: 10, y: 8, w: 60, h: 10, kind: 'label', label: 'CISCO 1941' },
      { x: 40, y: 30, w: 80, h: 40, kind: 'label', label: 'EHWIC 0' },
      { x: 130, y: 30, w: 80, h: 40, kind: 'label', label: 'EHWIC 1' },
      { x: 320, y: 50, w: 16, h: 14, kind: 'console', label: 'CON' },
      { x: 345, y: 52, w: 12, h: 8, kind: 'usb', label: 'USB' },
      { x: 450, y: 50, w: 16, h: 14, kind: 'power' },
    ],
    oui: '00:26:0b',
    defaultName: 'Router',
    caps: { switching: false, routing: true, routedPorts: true },
    software: {
      version: '15.1(4)M4',
      image: 'C1900-UNIVERSALK9-M',
      banner: 'Cisco IOS Software, C1900 Software (C1900-UNIVERSALK9-M), Version 15.1(4)M4, RELEASE SOFTWARE (fc1)',
      memory: '491520K/32768K',
      flash: '255744K',
      serialPrefix: 'FTX',
    },
  };
}

// --------------------------------------------------------------------------- others

function hub(): HardwareModel {
  const ports: PortSpec[] = [];
  for (let i = 0; i < 8; i++) ports.push(copper(`Port${i}`, `P${i}`, [10, 100], false, 'mdix', rj45(150 + i * 20, 16)));
  return {
    id: 'HUB-8',
    vendor: 'Genérico',
    name: 'Hub 8 portas',
    kind: 'hub',
    os: 'none',
    description: 'Hub (repetidor multiporta) 10/100 de 8 portas: um único domínio de colisão',
    ru: 1,
    panelColor: '#6b6b6b',
    ports,
    decorations: [
      { x: 10, y: 14, w: 60, h: 10, kind: 'label', label: 'HUB 10/100' },
      { x: 450, y: 14, w: 16, h: 14, kind: 'power' },
    ],
    oui: '00:e0:4c',
    defaultName: 'Hub',
    caps: { switching: false, routing: false, routedPorts: false },
  };
}

function hostModel(id: string, name: string, kind: 'pc' | 'laptop' | 'server', os: 'windows' | 'linux', description: string, oui: string, defaultName: string): HardwareModel {
  const nic = os === 'windows' ? 'Ethernet' : 'eth0';
  return {
    id,
    vendor: 'Genérico',
    name,
    kind,
    os,
    description,
    ru: kind === 'server' ? 1 : 0,
    panelColor: '#2b2b2b',
    ports: [{ name: nic, short: nic, media: 'copper', speeds: [10, 100, 1000], mdix: false, mdi: 'mdi', panel: rj45(400, 16) }],
    decorations: [{ x: 10, y: 14, w: 80, h: 10, kind: 'label', label: name }],
    oui,
    defaultName,
    caps: { switching: false, routing: false, routedPorts: false },
  };
}

export const MODELS: Record<string, HardwareModel> = Object.fromEntries(
  [
    isr4331(),
    cisco1941(),
    catalyst2960(),
    catalyst3650(),
    hub(),
    hostModel('PC-WIN11', 'PC Windows 11', 'pc', 'windows', 'Computador de mesa com Windows 11', '00:d8:61', 'PC'),
    hostModel('LAPTOP-WIN11', 'Notebook Windows 11', 'laptop', 'windows', 'Notebook com Windows 11', '28:c5:d2', 'Notebook'),
    hostModel('SRV-UBUNTU', 'Servidor Ubuntu 24.04', 'server', 'linux', 'Servidor com Ubuntu Server 24.04 LTS', '52:54:00', 'Servidor'),
    hostModel('PC-UBUNTU', 'PC Ubuntu 24.04', 'pc', 'linux', 'Computador de mesa com Ubuntu Desktop 24.04 LTS', '3c:52:82', 'PC-Linux'),
  ].map((m) => [m.id, m]),
);

export function getModel(id: string): HardwareModel {
  const m = MODELS[id];
  if (!m) throw new Error(`unknown model ${id}`);
  return m;
}
