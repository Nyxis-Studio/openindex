# OpenCode Embedding Cache Plugin

Plugin standalone para OpenCode que adiciona o comando `/embedding`.
Esses comandos sao scriptados: disparam indexacao local automaticamente.

Tambem adiciona:

- `/embedding-status` para ver status do indice.
- `/embedding-test <consulta>` para validar busca semantica.

Tool nativa para o agente:

- `index_search` (busca vetorial por chunks no cache local).

## Setup rapido (simples)

1. Instale o plugin globalmente:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

Ou instale e configure a chave no mesmo comando:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -GoogleApiKey "SUA_CHAVE_AQUI"
```

2. Configure sua chave Google:

```powershell
setx GOOGLE_API_KEY "SUA_CHAVE_AQUI"
```

3. Reinicie o OpenCode e rode:

```text
/embedding
```

Para monitorar/testar:

```text
/embedding-status
/embedding-test "campeao com dano alto"
```

Se quiser forcar o uso da tool pelo agente:

```text
Use a tool index_search para buscar contexto sobre "sua consulta".
```

Pronto. Sem configuracao por projeto.

O instalador copia o plugin para `~/.config/opencode/plugins/embedding-cache-plugin`.
Tambem instala o comando global `~/.config/opencode/commands/embedding.md`.
Esses comandos executam um script local do plugin (`bun .../src/cli.ts`).

## O que ele faz

- Escaneia arquivos do projeto respeitando `.gitignore`.
- Filtra binarios, arquivos sensiveis e arquivos grandes.
- Gera embeddings com Google (`gemini-embedding-001`).
- Mantem vetores em memoria durante a sessao.
- Persiste cache JSON no proprio projeto.

No TUI, tambem existem comandos no menu de comandos:

- `Embedding status`
- `Embedding test`

Arquivos criados automaticamente no projeto alvo:

- `.opencode/index-state.json`
- `.opencode/vector-cache.json`

## Configuracao opcional por projeto

Se quiser customizar, crie `.opencode/indexing.config.json` no projeto.
Se nao criar, o plugin usa defaults internos.
