# webptracer

Simulador educacional de redes de computadores na Web (TypeScript). Topologia visual,
CLI realista (Cisco IOS, Windows, Linux), visão física em rack, animação de pacotes passo a
passo, captura `.pcap`, colaboração em tempo real, versões, correção por comportamento e
injeção de falhas.

## Executar

Requisitos: Node.js 22+ (testado com 24).

```bash
npm install
npm run dev        # servidor em :3001 + interface em http://localhost:5173
```

Produção (um único processo servindo a interface compilada):

```bash
npm run build
npm start          # http://localhost:3001
```

Na primeira execução o servidor cria o laboratório de exemplo
("Filial: VLANs, roteamento, DHCP, NAT e IPv6"). O banco SQLite fica em
`apps/server/data/` (ou no caminho de `DB_FILE`).

## Estrutura

| Pasta | Conteúdo |
|---|---|
| `packages/core` | Motor de simulação (eventos discretos), equipamentos, pilha IP, switching/STP, CLIs, laboratório, correção, caos |
| `apps/server` | Express + Socket.IO (servidor autoritativo), Drizzle ORM + SQLite |
| `apps/web` | React + Vite: topologia, rack, terminais xterm.js, modo simulação |
| `docs/artigo` | Notas de pesquisa para o artigo científico |
| `docs/plano-mvp.md` | Checklist de implementação |

## Testes

```bash
npm test           # vitest (packages/core)
npm run typecheck
```
