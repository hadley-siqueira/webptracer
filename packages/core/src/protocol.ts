/** Messages exchanged between server and browser (Socket.IO). */
import type { PortView } from './devices/device';
import type { CableType, DeviceNote } from './sim/engine';
import type { HostConfig } from './devices/host';
import type { Objective } from './lab/lab';
import type { CheckResult } from './lab/checks';
import type { Layer } from './net/describe';

export type SimMode = 'realtime' | 'simulation';
export type Role = 'aluno' | 'professor';

export interface HostInfo {
  cfg: HostConfig;
  eff: {
    ipv4: string;
    mask: string;
    gateway: string;
    dns: string[];
    ipv6: string[];
    linkLocal: string;
    gateway6: string;
    dhcpState?: string;
    apipa: boolean;
  };
}

export interface DeviceView {
  id: string;
  name: string;
  model: string;
  kind: string;
  os: string;
  x: number;
  y: number;
  rack?: { rack: number; u: number };
  powered: boolean;
  ports: PortView[];
  summary: string;
  host?: HostInfo;
}

export interface LinkView {
  id: string;
  a: { device: string; port: string };
  b: { device: string; port: string };
  cable: CableType;
  up: boolean;
  failed: boolean;
}

export interface LabSnapshot {
  labId: string;
  name: string;
  description: string;
  instructions: string;
  mode: SimMode;
  speed: number;
  playing: boolean;
  now: number;
  devices: DeviceView[];
  links: LinkView[];
  racks: { name: string; units: number }[];
  objectives: Objective[];
}

export interface TraceView {
  id: number;
  time: number;
  linkId: string;
  from: string;
  fromPort: string;
  to: string;
  toPort: string;
  proto: string;
  summary: string;
  dropped?: string;
}

export interface TraceDetail {
  trace: TraceView;
  layers: Layer[];
  hex: string;
  notes: DeviceNote[];
}

export interface UserView {
  id: string;
  name: string;
  color: string;
  role: Role;
  cursor?: { x: number; y: number };
}

export interface ChatMessage {
  id: number;
  user: string;
  color: string;
  text: string;
  time: number;
  system?: boolean;
}

export interface VersionInfo {
  id: number;
  message: string;
  author: string;
  createdAt: number;
}

export interface FaultView {
  id: string;
  kind: string;
  description: string;
  hint: string;
  time: number;
}

export interface GradeResult {
  results: CheckResult[];
  score: number;
  total: number;
}

export type { Objective, HostConfig, CheckResult, DeviceNote };
