# Notas de pesquisa — Simulador educacional de redes baseado na Web

> Documento vivo para apoiar a redação de um artigo científico (congresso ou periódico).
> Registra a motivação, o levantamento de trabalhos relacionados, as decisões de projeto e
> suas justificativas, na ordem em que foram tomadas.
>
> Início: 2026-11-21. Nome de trabalho do projeto: **webptracer** (provisório).

---

## 1. Motivação e pergunta de partida

Pergunta original que deu origem ao projeto:

> "Se eu fosse fazer um novo simulador educacional para competir com o Cisco Packet Tracer,
> que funcionalidades ele poderia ter para suprir deficiências do Packet Tracer?"

O Cisco Packet Tracer (CPT) é a ferramenta dominante no ensino de redes (cursos técnicos,
graduação e trilhas de certificação CCNA). É gratuito, leve e muito didático, mas tem
limitações estruturais: é proprietário, de código fechado, exige conta na Cisco Networking
Academy, roda apenas como aplicação desktop, simula apenas equipamentos de um único fabricante
e implementa um subconjunto do comportamento real dos protocolos.

## 2. Sugestões levantadas inicialmente (consulta ao Google AI Mode, 2026-11-21)

Transcrição resumida das sugestões obtidas, usadas como ponto de partida para os requisitos:

### 2.1 Arquitetura e experiência de uso (UX)
- **100% Web e zero instalação**: rodar no navegador (WebAssembly ou containers leves no
  servidor), eliminando problemas de instalação em laboratórios e notebooks de alunos.
- **Colaboração em tempo real (estilo Figma)**: vários alunos e o professor na mesma
  topologia, com chat integrado e cursores visíveis.
- **Controle de versão (estilo Git)**: commit, rollback e branches da topologia e das
  configurações, permitindo testar cenários destrutivos sem perder trabalho.

### 2.2 Realismo técnico e suporte a vários fabricantes
- **Multi-fabricante e open source**: além de Cisco, MikroTik (RouterOS), Juniper, Fortinet,
  Huawei, roteadores Linux (FRRouting, OpenWrt) e servidores (Ubuntu/Alpine).
- **Integração com redes reais (bridge)**: conectar a topologia à internet ou a VMs/containers.
- **Comandos completos, sem "bugs de simulação"**: o CPT falha em comandos avançados (BGP,
  MPLS, IPv6 avançado, debugs) por usar um motor simulado.

### 2.3 Redes modernas (cloud, automação e cibersegurança)
- **Automação/NetDevOps nativos**: terminal Python/Linux integrado; Ansible, Terraform,
  Netmiko, REST/NETCONF/RESTCONF.
- **Cibersegurança ofensiva e defensiva**: Kali Linux, NGFW, SIEM (Wazuh/ELK), geradores de
  tráfego malicioso (DDoS, ARP spoofing, SQL injection) para Red Team × Blue Team.
- **Cloud e contêineres**: VPC, Security Groups, Load Balancers, Kubernetes básico.

### 2.4 Recursos pedagógicos e de avaliação
- **Correção automática baseada em comportamento**: em vez de exigir o comando exato
  (limitação do Activity Wizard do CPT), avaliar o *estado da rede* ("o pacote da VLAN 10
  chega ao servidor web?"), aceitando várias soluções corretas.
- **Modo "Chaos Engineering"**: o professor injeta falhas (cabo rompido, loop de camada 2,
  máscara errada, regra de firewall) para treinar troubleshooting.
- **Visualização de pacotes estilo Wireshark**: captura `.pcap` real e inspecionável, com
  filtros e decodificação completa de cabeçalhos.

### 2.5 Quadro-resumo de posicionamento (proposto pela consulta)

| Recurso | Cisco Packet Tracer | Novo simulador ideal |
|---|---|---|
| Plataforma | Desktop (instalação local) | Web / nuvem (acesso via link) |
| Ecossistema | Exclusivo Cisco | Multi-fabricante (Linux, MikroTik, Cisco etc.) |
| Motor | Simulação abstrata (limitada) | Híbrido (simulação leve + containers reais) |
| Foco | CLI tradicional e IoT básico | Automação, cloud e SecOps |
| Trabalho em equipe | Multiusuário complexo via IP/porta | Colaboração nativa em tempo real |

## 3. Análise crítica das sugestões

1. **Simulador × emulador.** As sugestões misturam dois paradigmas:
   - *simulador*: o software imita o comportamento dos equipamentos (leve, roda em qualquer
     máquina, mas só faz o que foi implementado — ex.: CPT, Filius);
   - *emulador*: executa o sistema operacional real em VMs/containers (realista, mas pesado
     e com custo de infraestrutura — ex.: GNS3, EVE-NG, CML, Containerlab).

   "Zero instalação" + "comandos reais" exige emulação no servidor, com custo por aluno, o
   que conflita com a gratuidade e a escala necessárias no ensino. Nesse nicho os concorrentes
   são EVE-NG/Containerlab, não o CPT.
2. **Licenciamento.** Imagens reais de Cisco IOS, Junos e FortiOS não podem ser
   redistribuídas. Apenas sistemas livres (Linux, FRR, OpenWrt) e alguns gratuitos (ex.:
   MikroTik CHR) seriam viáveis num emulador distribuído.
3. **Pontos fortes do CPT que precisam ser igualados**: roda em hardware modesto e offline,
   inicia instantaneamente, é gratuito, tem modo de simulação com animação passo a passo dos
   pacotes, possui atividades avaliativas e integração ao currículo da NetAcad.

## 4. Levantamento de ferramentas existentes (estado em novembro de 2026)

### 4.1 Visão geral

| Ferramenta | Tipo | Público principal | Custo / licença | Plataforma | Peso |
|---|---|---|---|---|---|
| Cisco Packet Tracer (9.0) | Simulador | Ensino técnico/superior, CCNA | Grátis, fechado, exige conta NetAcad | Desktop | Leve |
| Filius | Simulador | Ensino médio, introdução | Grátis, GPL v3 | Desktop (Java) | Muito leve |
| Boson NetSim | Simulador | Preparação CCNA/CCNP | Pago | Desktop (Windows) | Leve |
| GNS3 | Emulador | Profissionais | Grátis, open source | Desktop + servidor/VM | Pesado |
| EVE-NG | Emulador | Profissionais, labs corporativos | Free limitado (7 nós, v7); Pro ≈ €150 | Servidor + navegador | Pesado |
| Cisco Modeling Labs (CML) | Emulador | Estudo Cisco com imagens oficiais | Free (5 nós); pagos 20/40 nós | Servidor/VM + navegador | Pesado |
| Containerlab | Emulador (containers) | NetDevOps / automação | Grátis, open source | Linux + Docker, CLI | Médio |
| Kathará | Emulador (containers) | Ensino universitário de protocolos | Grátis, open source | Docker, CLI | Médio |
| Mininet | Emulador (Linux) | Pesquisa/ensino de SDN | Grátis, open source | Linux, Python | Leve/médio |

### 4.2 Matriz de funcionalidades (✅ sim · ⚠️ parcial · ❌ não)

| Funcionalidade | CPT | Filius | GNS3 | EVE-NG | CML | Containerlab | Kathará | Mininet |
|---|---|---|---|---|---|---|---|---|
| Interface gráfica (arrastar e soltar) | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ⚠️ |
| Roda no navegador | ❌ | ❌ | ❌ | ✅ (servidor) | ✅ (servidor) | ❌ | ❌ | ❌ |
| Roda em PC fraco / offline | ✅ | ✅ | ❌ | ❌ | ❌ | ⚠️ | ⚠️ | ✅ |
| Animação de pacotes passo a passo | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Captura de pacotes (Wireshark) | ❌ | ⚠️ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| CLI estilo Cisco | ⚠️ simulada | ❌ | ✅ real* | ✅ real* | ✅ real | ✅ real* | ❌ | ❌ |
| Multi-fabricante | ❌ | ❌ | ✅ | ✅ | ❌ | ✅ | ⚠️ (Linux) | ❌ |
| Linux real nos nós | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Automação (Python, Ansible, APIs) | ⚠️ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Correção automática de exercícios | ✅ (Activity Wizard) | ❌ | ❌ | ❌ | ❌ | ❌ | ⚠️ | ❌ |
| Colaboração em tempo real | ⚠️ | ❌ | ❌ | ⚠️ | ⚠️ | ❌ | ❌ | ❌ |
| IoT / cenários didáticos prontos | ✅ | ⚠️ | ❌ | ❌ | ⚠️ | ❌ | ⚠️ | ❌ |
| Conexão com rede real | ⚠️ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Topologia como código (arquivo texto) | ❌ | ❌ | ⚠️ | ❌ | ✅ | ✅ | ✅ | ✅ |

\* Requer que o usuário forneça a imagem do fabricante (exceto CML, que inclui imagens Cisco).

### 4.3 Vantagens e desvantagens

| Ferramenta | Vantagens | Desvantagens |
|---|---|---|
| Packet Tracer | Leve, gratuito, padrão no ensino e no CCNA; animação de pacotes; correção de atividades; IoT | Só Cisco; comandos avançados ausentes/bugados; fechado; exige conta; correção exige comando exato; não é web |
| Filius | Simplíssimo, ótimo para iniciantes; mostra camadas e aplicações; open source | Sem switches/roteadores gerenciáveis nem CLI; interface datada; poucos protocolos |
| Boson NetSim | Muitos labs guiados para a prova | Pago, só Windows, só Cisco, simulação limitada |
| GNS3 | Grátis, sem limite de nós, multi-fabricante, muito realista | Instalação complexa, exige muita RAM, curva alta, nada pedagógico, imagens por conta do usuário |
| EVE-NG | Interface web, bom para labs compartilhados, multi-fabricante | Free reduzido a 7 nós (2026); servidor dedicado; imagens por conta do usuário |
| CML | Imagens Cisco oficiais e legais; API | Só Cisco; free com 5 nós; pesado |
| Containerlab | Topologia em YAML, sobe em segundos, ótimo para CI/automação | Sem GUI; exige Linux/Docker; nada didático |
| Kathará | Pensado para ensino universitário; leve; labs prontos | Só CLI; exige Docker; pouco visual |
| Mininet | Padrão para SDN; leve; programável em Python | Nicho (SDN); sem equipamentos de fabricante; só Linux |

Observação sobre simuladores web: houve simuladores web open source (CS4G Netsim,
Educational Network Simulator), mas segundo revisão atualizada em jan/2026 foram
descontinuados. Existem iniciativas acadêmicas/nicho (Networx, WNSWE — TU Chemnitz,
Klonet — NSDI'24), nenhuma cobrindo o escopo do CPT.

### 4.4 Lacuna identificada

- Simuladores (CPT, Filius) são bons em **pedagogia** (visual, animação, avaliação), mas
  são fechados e limitados.
- Emuladores são bons em **realismo**, mas quase não têm recursos pedagógicos e são difíceis
  de instalar.
- **Não existe uma ferramenta Web, aberta, colaborativa e pedagógica** que combine a
  didática do CPT com captura de pacotes real, múltiplos fabricantes e avaliação por
  comportamento.

> Ressalva metodológica: números de versão e limites de nós (CPT 9.0, EVE-NG 7 nós, CML 5
> nós) foram obtidos em parte de blogs, alguns de um fornecedor concorrente (NetPilot);
> devem ser confirmados nas fontes oficiais antes da publicação.

### 4.5 Fontes consultadas
- Cisco — Packet Tracer (NetAcad): https://www.cisco.com/web/learning/netacad/course_catalog/PacketTracer.html
- Cisco Community — Packet Tracer 9.0 new features: https://community.cisco.com/t5/online-tools-and-resources/cisco-packet-tracer-9-0-new-features/td-p/5285503
- NetPilot — GNS3 vs EVE-NG vs Containerlab 2026: https://netpilot.io/blog/gns3-vs-eve-ng-vs-containerlab-2026
- NetPilot — EVE-NG free tier 7 nodes 2026: https://www.netpilot.io/blog/eve-ng-free-tier-7-nodes-2026
- DEV — CML vs GNS3 vs INE 2026: https://dev.to/firstpasslab/cml-vs-gns3-vs-ine-how-network-engineers-should-build-labs-in-2026-2hdg
- CloudMyLab — EVE-NG vs GNS3: https://blog.cloudmylab.com/eve-ng-vs-gns3
- Codilime — Virtual labs tools: https://codilime.com/blog/virtual-labs-tools-software
- B. Linkletter — Network simulators for high-school teachers: https://brianlinkletter.com/2023/03/network-simulators-for-high-school-teachers/
- Filius: https://signpath.org/projects/filius
- Kathará: https://github.com/KatharaFramework/Kathara
- WNSWE (TU Chemnitz): https://vsr.informatik.tu-chemnitz.de/projects/2024/WNSWE
- Networx: https://github.com/milesberry/networx
- Klonet (NSDI'24): https://www.usenix.org/system/files/nsdi24-ma.pdf

## 5. Requisitos definidos para o projeto (2026-11-21)

Requisitos estabelecidos pelo autor:

1. **Simulador, não emulador**: o comportamento dos equipamentos é implementado em
   software (motor de eventos discretos), sem executar sistemas operacionais reais.
2. **Hardware e fabricantes reais**: simular o máximo possível de modelos reais e os comandos
   mais utilizados de cada fabricante.
3. **Web, arquitetura cliente-servidor.**
4. **Interação/colaboração em tempo real**, considerando as demais sugestões da seção 2
   (versionamento, correção por comportamento, chaos engineering, captura de pacotes).
5. **Visual e com animações** (pacotes trafegando nos enlaces).
6. **Realismo**: switches, roteadores, NAT, IPv4, IPv6 e situações da vida real.
7. **CLI simulada o mais completa possível**, incluindo as configurações mais usadas dos
   sistemas operacionais dos switches/roteadores.
8. **Foco educacional.**
9. **Visão física dos equipamentos**: o aluno deve ver, por exemplo, um switch no rack, com
   portas e LEDs, em 2D ou 3D.
10. **Tecnologia**: preferência por Node.js (segunda opção Python); banco SQLite no início
    com migração futura para PostgreSQL; uso livre de ORM e frameworks de UX.

## 6. Decisões de projeto e justificativas

| # | Decisão | Justificativa |
|---|---|---|
| D1 | **TypeScript** em todo o projeto (Node.js 24 no servidor, React no cliente) | Preferência do autor por Node.js; uma única linguagem permite que o **mesmo motor de simulação** rode no servidor (colaboração) e, futuramente, no navegador (modo offline) |
| D2 | Monorepo com `packages/core` (motor), `apps/server` e `apps/web` | Separa o modelo de rede (testável isoladamente) da interface e da rede |
| D3 | **Simulação por eventos discretos** com relógio virtual | Determinismo, reprodutibilidade (essencial para avaliação automática e para experimentos do artigo), possibilidade de pausar, avançar passo a passo e acelerar o tempo |
| D4 | **Servidor autoritativo** + Socket.IO para colaboração | Todos os alunos veem o mesmo estado; evita conflitos de edição; simples de implementar e de raciocinar |
| D5 | Pacotes modelados como **estruturas tipadas** e serializados para bytes reais apenas sob demanda | Mantém a simulação leve e, ao mesmo tempo, permite exportar **`.pcap` válido** para o Wireshark |
| D6 | **Configuração como texto** (running-config/startup-config) é a fonte da verdade dos equipamentos | Igual aos equipamentos reais: salvar = gerar running-config; carregar = reexecutar os comandos. Garante coerência entre CLI e estado, facilita versionamento (diff de texto) e testes de ida e volta |
| D7 | Separação **modelo de configuração × dialeto de CLI** | Permite adicionar fabricantes (MikroTik, Huawei, Juniper) como novos *parsers*/renderizadores sobre o mesmo plano de dados |
| D8 | Gramática declarativa de comandos com abreviação, `?`, Tab, `do`, `no` e mensagens de erro no padrão do fabricante | Realismo da CLI é central para o aprendizado e para a transferência ao equipamento real |
| D9 | Primeiro dialeto: **Cisco IOS** (roteador, switch L2 e switch L3) + shells de host **Windows** e **Linux** | Maior base instalada no ensino; hosts com dois SOs reais aproximam o aluno do mercado |
| D10 | **Correção por comportamento**: a verificação reconstrói a rede a partir do documento do laboratório, avança o relógio virtual e executa testes (ping, estado de VLAN, etc.) | Aceita qualquer solução correta; atende à crítica ao Activity Wizard do CPT |
| D11 | **Chaos engineering** como funcionalidade do servidor (injeção de falhas aleatórias e registro oculto para o professor) | Treino de troubleshooting |
| D12 | **Versionamento** por *snapshots* (commits) do documento do laboratório, com restauração | Primeiro passo para o modelo "Git-like"; *branches* ficam para fase posterior |
| D13 | Banco **SQLite via Drizzle ORM** | Simplicidade no MVP; o Drizzle suporta PostgreSQL com mudança localizada no esquema |
| D14 | **Visão física em 2D (SVG)** gerada a partir de uma especificação de painel por modelo, com rack e LEDs ao vivo; 3D (Three.js) como evolução | SVG é leve, nítido e interativo; a mesma especificação servirá para o 3D |
| D15 | Modos **Tempo real** e **Simulação** (passo a passo com lista de eventos e filtros por protocolo), mais "avançar o tempo" | Reproduz o recurso mais didático do CPT e corrige a falta de captura real |
| D16 | Proteção contra **tempestade de broadcast** (limite de quadros por enlace) com aviso pedagógico | Laços de camada 2 sem STP precisam ser *demonstráveis* sem derrubar o servidor |

### 6.1 Desvios conscientes em relação aos equipamentos reais (MVP)
- STP implementado como **uma única instância** (802.1D clássico com nomenclatura PVST na
  saída de `show spanning-tree`); PVST+ por VLAN fica para depois.
- As VLANs são gravadas na running-config (como em VTP *transparent*), em vez de `vlan.dat`.
- DTP é resolvido pela configuração do vizinho (sem quadros DTP).
- Senhas *type 5* usam uma função de *hash* didática (não MD5-crypt real); *type 7* é a
  cifra reversível real.
- Nomes de modelos e de comandos de fabricantes são usados de forma nominativa e
  educacional; nenhum logotipo é reproduzido.

## 7. Escopo do MVP (versão 0.1)

**Equipamentos**: roteadores Cisco ISR 4331 e 1941; switches Catalyst 2960-24TT (L2) e
3650-24PS (L3); hub; PC (Windows), notebook (Windows) e servidor (Linux).

**Plano de dados**: Ethernet II e 802.1Q; *hub*; *switching* com aprendizado de MAC,
*aging* e inundação; VLANs de acesso e *trunk* (VLAN nativa, VLANs permitidas, DTP
simplificado); STP 802.1D com *portfast* e *BPDU guard*; ARP (com o comportamento ".!!!!"
do IOS no primeiro ping); IPv4 com roteamento conectado e estático (incluindo rota *default*
e rota flutuante), TTL, ICMP (*echo*, *unreachable*, *time exceeded*, *admin prohibited*);
*router-on-a-stick* (subinterfaces dot1Q); roteamento entre VLANs em switch L3 (SVI +
`ip routing`); NAT estático, dinâmico com *pool* e PAT (*overload*); ACLs padrão e
estendidas (numeradas e nomeadas); servidor DHCP no roteador, *relay*
(`ip helper-address`), cliente DHCP nos hosts (com APIPA no Windows); IPv6 com
*link-local* EUI-64, endereços estáticos, NDP (NS/NA), RS/RA e SLAAC, rotas estáticas,
ICMPv6; CDP; mensagens de *syslog* no console; detecção de IP duplicado.

**CLI IOS**: modos usuário/privilegiado/configuração/interface/subinterface/faixa de
interfaces/VLAN/linha/pool DHCP/ACL nomeada; abreviações, `?`, Tab, `do`, `no`, histórico;
mensagens de erro reais; `show` (running/startup-config, ip interface brief, interfaces,
ip route, arp, vlan brief, mac address-table, interfaces trunk/status, spanning-tree,
ip nat translations, access-lists, ip dhcp binding, ipv6 interface brief, ipv6 route,
ipv6 neighbors, cdp neighbors, version, history); `copy run start`, `write`, `reload`,
`erase startup-config`; senhas de *enable* e console; *banner motd*; `ping` e `traceroute`
(com opções); comportamento de *domain lookup* para comandos desconhecidos.

**Hosts**: Windows (`ipconfig`, `ping`, `tracert`, `arp`) e Linux (`ip`, `ifconfig`,
`ping`, `traceroute`, `arp`, `dhclient`), além de configuração por formulário.

**Interface Web**: topologia lógica (arrastar e soltar, cabos com escolha de porta, LEDs
nas pontas dos enlaces); visão física em rack com painéis frontais, portas, LEDs e cabos;
terminal (xterm.js) por equipamento; modos Tempo real/Simulação com animação de pacotes,
lista de eventos, filtros por protocolo e detalhamento por camada + *hex dump*; download de
`.pcap` por enlace; colaboração em tempo real (presença, cursores, chat); histórico de
versões; objetivos com verificação por comportamento; injeção de falhas.

## 8. Trabalhos futuros (roteiro)

- Roteamento dinâmico (OSPFv2/v3, RIPv2, EIGRP, BGP básico), HSRP/VRRP, EtherChannel
  (LACP/PAgP), PVST+/Rapid-PVST por VLAN, port-security, `no switchport`, DHCPv6.
- TCP/UDP de aplicação (HTTP, DNS, SSH/Telnet entre equipamentos), servidores de serviços.
- Novos dialetos: MikroTik RouterOS, Huawei VRP, Juniper Junos, Linux/FRR.
- Visão física 3D (Three.js), cabos de console, energia e módulos.
- Motor no navegador (modo offline/PWA) usando o mesmo pacote `core`.
- *Branches* e *diff* de configurações; papéis professor/aluno, turmas e autenticação.
- Automação: API REST/NETCONF simulada para scripts Python/Ansible.
- Cibersegurança: ARP spoofing, ataques de VLAN hopping, firewalls, IDS.
- Migração para PostgreSQL.

## 9. Possível metodologia de avaliação para o artigo

- **Avaliação funcional**: matriz de comandos/protocolos suportados × CPT; testes
  automatizados de conformidade (saídas de `show` comparadas com equipamentos reais).
- **Desempenho**: eventos/s do motor, nº de dispositivos por laboratório, latência de
  colaboração com N usuários simultâneos.
- **Avaliação com usuários**: estudo com turmas (pré/pós-teste de conhecimento),
  questionário SUS (usabilidade) e TAM (aceitação); comparação controlada com o CPT em
  atividades de troubleshooting (tempo até a solução, taxa de acerto).
- **Validade da correção por comportamento**: concordância entre a nota automática e a
  avaliação de professores em soluções alternativas.

## 10. Registro cronológico

- **2026-11-21** — Pergunta inicial; consulta ao Google AI Mode; levantamento comparativo de
  ferramentas; definição dos requisitos (seção 5) e das decisões (seção 6); início do MVP.
- **2026-11-22** — Retomada após interrupção (queda de energia) da sessão anterior; reconstrução
  do contexto a partir do histórico. Implementação do MVP: motor, equipamentos, CLIs, servidor
  e interface Web. Validação com testes automatizados (vitest) e teste da interface em navegador.

## 11. Achados de realismo durante a validação (2026-11-22)

Comportamentos que surgiram naturalmente da simulação fiel dos protocolos e que exigiram
ajustes para reproduzir o comportamento real dos sistemas — material útil para a discussão do
artigo (fidelidade do simulador):

1. **STP × DHCP**: a porta *trunk* do switch fica 30 s em *listening/learning* (802.1D). Um
   cliente DHCP com poucas tentativas cai em APIPA antes de o enlace encaminhar. Solução fiel:
   *backoff* exponencial do cliente (4, 8, 16, 32 s; cerca de 60 s no total), como no Windows.
2. **STP × SLAAC**: as mensagens *Router Solicitation* (até 3, nos primeiros segundos) se perdem
   pelo mesmo motivo; o host só obtém o prefixo no próximo RA periódico (200 s no IOS).
   Implementado o comando real `ipv6 nd ra interval`, usado no laboratório de exemplo.
3. **Concorrência no servidor DHCP**: dois clientes simultâneos recebiam a mesma oferta.
   O IOS reserva o endereço oferecido; o simulador passou a fazer o mesmo.
4. **Primeiro ping do IOS (`.!!!!`)**: reproduzido porque o roteador descarta o pacote que
   dispara a resolução ARP, enquanto hosts o enfileiram.
5. **Cabos**: sem auto-MDIX, roteador↔roteador e roteador↔PC exigem cabo cruzado (convenção
   didática do CPT); portas com auto-MDIX aceitam qualquer cabo.

### Estado da implementação (versão 0.1)
- Testes automatizados: 10 cenários (CLI, ARP, STP em triângulo, BPDU Guard, ACL, isolamento
  por VLAN, ida e volta da running-config, formato pcap e laboratório de exemplo completo).
- O desempenho do motor permite avançar 90 s de tempo virtual de uma topologia de 7 nós em
  ~50 ms (medida informal; formalizar na avaliação).
