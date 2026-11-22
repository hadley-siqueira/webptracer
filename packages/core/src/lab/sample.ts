import { Lab, emptyDoc, type LabDoc } from './lab';
import { IosDevice } from '../devices/ios';
import { Host } from '../devices/host';

/**
 * Sample lab: small branch office with two VLANs (router-on-a-stick), DHCP on the router,
 * PAT to a simulated ISP and IPv6 with SLAAC on VLAN 10.
 */
export function sampleLab(): LabDoc {
  const lab = new Lab({
    ...emptyDoc('Filial: VLANs, roteamento, DHCP, NAT e IPv6'),
    description: 'Rede de uma filial com duas VLANs, roteador com router-on-a-stick, DHCP, PAT para a internet e IPv6.',
    instructions: `# Laboratório de exemplo

A filial tem duas VLANs no switch **SW1**:

| VLAN | Nome | Rede IPv4 | Rede IPv6 |
|---|---|---|---|
| 10 | ALUNOS | 192.168.10.0/24 | 2001:db8:acad:10::/64 |
| 20 | PROFESSORES | 192.168.20.0/24 | — |

O roteador **R1** faz o roteamento entre as VLANs (router-on-a-stick), é o servidor DHCP e
traduz os endereços privados (PAT) para acessar o servidor **SRV1** na "internet" do provedor **ISP**.

Experimente:
1. No PC1, rode \`ipconfig\` e \`ping 203.0.113.10\`.
2. No R1, veja \`show ip nat translations\` logo após o ping.
3. Mude para o modo **Simulação** e acompanhe um ping passo a passo.
4. No SW1, rode \`show vlan brief\`, \`show interfaces trunk\` e \`show mac address-table\`.`,
    seed: 42,
    racks: [{ name: 'Rack da filial', units: 12 }],
  });
  const r1 = lab.addDevice('ISR4331', 420, 140) as IosDevice;
  const isp = lab.addDevice('CISCO1941/K9', 720, 140) as IosDevice;
  const sw1 = lab.addDevice('WS-C2960-24TT-L', 420, 320) as IosDevice;
  const pc1 = lab.addDevice('PC-WIN11', 220, 480) as Host;
  const pc2 = lab.addDevice('PC-WIN11', 400, 500) as Host;
  const nb1 = lab.addDevice('LAPTOP-WIN11', 600, 480) as Host;
  const srv = lab.addDevice('SRV-UBUNTU', 960, 140) as Host;

  lab.connect(r1.id, 'Gi0/0/0', sw1.id, 'Gi0/1');
  lab.connect(r1.id, 'Gi0/0/1', isp.id, 'Gi0/0');
  lab.connect(isp.id, 'Gi0/1', srv.id, 'eth0');
  lab.connect(sw1.id, 'Fa0/1', pc1.id, 'Ethernet');
  lab.connect(sw1.id, 'Fa0/2', pc2.id, 'Ethernet');
  lab.connect(sw1.id, 'Fa0/11', nb1.id, 'Ethernet');

  r1.loadConfig(
    `hostname R1
no ip domain-lookup
enable secret class
ipv6 unicast-routing
ip dhcp excluded-address 192.168.10.1 192.168.10.9
ip dhcp excluded-address 192.168.20.1 192.168.20.9
ip dhcp pool ALUNOS
 network 192.168.10.0 255.255.255.0
 default-router 192.168.10.1
 dns-server 203.0.113.10
ip dhcp pool PROFESSORES
 network 192.168.20.0 255.255.255.0
 default-router 192.168.20.1
 dns-server 203.0.113.10
interface GigabitEthernet0/0/0
 description Trunk para SW1
 no shutdown
interface GigabitEthernet0/0/0.10
 description VLAN 10 - ALUNOS
 encapsulation dot1Q 10
 ip address 192.168.10.1 255.255.255.0
 ip nat inside
 ipv6 address 2001:db8:acad:10::1/64
 ipv6 nd ra interval 30
interface GigabitEthernet0/0/0.20
 description VLAN 20 - PROFESSORES
 encapsulation dot1Q 20
 ip address 192.168.20.1 255.255.255.0
 ip nat inside
interface GigabitEthernet0/0/1
 description Link para o provedor
 ip address 209.165.200.226 255.255.255.252
 ip nat outside
 no shutdown
access-list 1 permit 192.168.10.0 0.0.0.255
access-list 1 permit 192.168.20.0 0.0.0.255
ip nat inside source list 1 interface GigabitEthernet0/0/1 overload
ip route 0.0.0.0 0.0.0.0 209.165.200.225
banner motd #Acesso restrito - laboratorio de redes#
line con 0
 logging synchronous
`,
    true,
  );
  isp.loadConfig(
    `hostname ISP
no ip domain-lookup
interface GigabitEthernet0/0
 description Cliente filial
 ip address 209.165.200.225 255.255.255.252
 no shutdown
interface GigabitEthernet0/1
 description Rede de servidores
 ip address 203.0.113.1 255.255.255.0
 no shutdown
`,
    true,
  );
  sw1.loadConfig(
    `hostname SW1
no ip domain-lookup
vlan 10
 name ALUNOS
vlan 20
 name PROFESSORES
interface range FastEthernet0/1 - 10
 switchport mode access
 switchport access vlan 10
 spanning-tree portfast
interface range FastEthernet0/11 - 20
 switchport mode access
 switchport access vlan 20
 spanning-tree portfast
interface GigabitEthernet0/1
 switchport mode trunk
interface Vlan1
 no ip address
 shutdown
`,
    true,
  );
  srv.importState({ running: JSON.stringify({ hostname: 'SRV1', ipv4: { mode: 'static', addr: '203.0.113.10', mask: '255.255.255.0', gateway: '203.0.113.1' }, ipv6: { mode: 'auto' } }) });
  for (const d of [r1, isp, sw1]) d.startup = d.runningConfig();

  const doc = lab.toDoc();
  doc.objectives = [
    { id: 'o1', title: 'PC1 recebe endereço por DHCP', check: { kind: 'dhcp', device: pc1.id }, points: 1 },
    { id: 'o2', title: 'NB1 (VLAN 20) alcança PC1 (VLAN 10)', check: { kind: 'ping', from: nb1.id, to: '192.168.10.10', expect: 'success' }, points: 1 },
    { id: 'o3', title: 'PC1 alcança o servidor na internet (NAT)', check: { kind: 'ping', from: pc1.id, to: '203.0.113.10', expect: 'success' }, points: 2 },
    { id: 'o4', title: 'PC1 alcança o roteador por IPv6', check: { kind: 'ping', from: pc1.id, to: '2001:db8:acad:10::1', expect: 'success' }, points: 1 },
    { id: 'o5', title: 'O ISP não conhece as redes privadas', check: { kind: 'config', device: isp.id, pattern: '^ip route 192\\.168', expect: false }, points: 1 },
  ];
  return doc;
}
