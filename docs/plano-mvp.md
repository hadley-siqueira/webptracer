# Plano de implementação do MVP (checklist de progresso)

Escopo completo: ver `docs/artigo/notas-de-pesquisa.md`, seção 7.
Este arquivo é atualizado a cada marco e commitado, para permitir retomar o trabalho
se a sessão for interrompida.

## Core (`packages/core`)
- [x] net: ipv4, ipv6, mac, packets (tipos de PDU)
- [x] net/wire: serialização para bytes reais (Ethernet, 802.1Q, ARP, IPv4, ICMP, UDP, DHCP, IPv6, ICMPv6, STP, CDP) + pcap
- [x] sim/engine: relógio virtual, fila de eventos, enlaces, portas, rastreio de quadros (para animação), RNG com semente
- [x] devices/models: catálogo de hardware (portas, painel frontal para a visão física)
- [x] l2: switching (MAC table, VLAN access/trunk, DTP simplificado, STP 802.1D, portfast, bpduguard), hub, CDP
- [x] l3: pilha IP (ARP, rotas, ICMP, encaminhamento, ACL, NAT, DHCP servidor/relay/cliente, IPv6 ND/RA/SLAAC, ping/traceroute)
- [x] devices: roteador IOS, switch L2, switch L3, host Windows/Linux
- [x] cli: framework (abreviação, ?, Tab, no, do, erros IOS) + comandos IOS + shells Windows/Linux
- [x] running-config: geração e carga (replay)
- [x] lab: documento do laboratório, construção da simulação, verificação por comportamento, chaos
- [ ] testes (vitest)

## Servidor (`apps/server`)
- [ ] Express + Socket.IO, salas por laboratório, servidor autoritativo
- [ ] SQLite com Drizzle (labs, versões)
- [ ] modos tempo real / simulação, passo, avançar tempo
- [ ] colaboração: presença, cursores, chat
- [ ] versões (commit/restaurar), objetivos, chaos, pcap

## Web (`apps/web`)
- [ ] Vite + React; topologia lógica (arrastar, cabos, LEDs)
- [ ] terminal xterm.js por dispositivo
- [ ] animação de pacotes, lista de eventos, detalhe por camada + hex
- [ ] visão física (rack SVG)
- [ ] painéis: chat/presença, versões, objetivos, chaos

## Exemplo
- [x] laboratório de exemplo (VLANs + router-on-a-stick + NAT + DHCP + IPv6)
