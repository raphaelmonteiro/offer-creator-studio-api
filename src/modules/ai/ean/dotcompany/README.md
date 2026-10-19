# Catálogo DotCompany por EAN — guia operacional

A integração consulta produtos na API da DotCompany pelo EAN. O que volta, o sistema usa assim:

- grava o nome, a marca e a foto num cache local (`dotcompany_lookups`), e cada EAN é pago no máximo uma vez;
- baixa a foto para a galeria, na pasta **DotCompany**, já com o EAN exato no metadata;
- com isso, o casamento card→imagem do encarte passa a achar essas fotos.

Tudo passa por um **controlador de consumo** (`DotcompanyBudgetService`). Change OpenSpec:
`openspec/changes/catalogo-dotcompany-ean/`.

## Custos e limites

| O quê | Valor |
|---|---|
| Crédito | 1 crédito = R$ 0,01, pré-pago |
| EAN encontrado | 4 créditos (R$ 0,04) |
| EAN não encontrado | grátis (fica 30 dias sem nova consulta) |
| Reconsulta com ETag sem mudança (304) | grátis |
| Janela da DotCompany | **por minuto**, conforme o plano: Free 30, Starter 120, Pro 600 req/min |
| Limites por hora/dia | **nossos**, no `.env` (`DOTCOMPANY_MAX_*`). A DotCompany não tem limite por hora nem por dia para chaves `dc_` |
| Reserva | com saldo ≤ `DOTCOMPANY_RESERVE_CREDITS`, os jobs em lote param e o encarte continua consultando |

Comprar créditos: https://app.dotcompany.com.br/api-dev/creditos/comprar. Gerenciar chaves:
https://app.dotcompany.com.br/api-dev/keys.

## Configuração (`backend/.env`)

```
DOTCOMPANY_API_TOKEN=dc_live_...      # sem token nada é consultado
DOTCOMPANY_ALERT_EMAIL=voce@empresa   # alertas de saldo baixo/zerado e limite diário
```

Os demais valores (limites, reserva, prazo do encarte) estão comentados em `backend/.env.example`. Mudar um deles
pede só um restart (`pm2 restart flyer-api --update-env`), sem deploy.

Nos exemplos abaixo:

```bash
export B=http://35.247.231.120/v1/ai/dotcompany   # local: http://localhost:3001/v1/ai/dotcompany
export H="x-admin-token: $ADMIN_API_TOKEN"
```

## Saldo e consumo

```bash
curl -s -H "$H" $B/usage | jq .data                # saldo, hora/dia/mês, limites e estado
curl -s -H "$H" -X POST $B/usage/refresh | jq .data  # confere o saldo agora (GET /usage da DotCompany, grátis)
```

`state` pode ser:
- `ok`;
- `limited`: janela, limite por hora ou dia, ou reserva;
- `no_credit`;
- `no_token`.

`reason` e `retryAt` dizem por que está bloqueado e até quando.

## Consultar um EAN avulso

```bash
curl -s -H "$H" $B/lookup/7891000100103 | jq .data
```

A consulta usa o cache primeiro. Se ela for à DotCompany e encontrar o produto, cobra 4 créditos. Ela não importa a
foto; para isso, use um job ou o encarte.

## Importar o cadastro de um cliente

O arquivo pode ser:
- CSV com `;`, `,` ou tab, em UTF-8 ou Windows-1252;
- XLSX.

Ele precisa de uma coluna de EAN (`EAN`, `GTIN`, `Código de barras`…) e, de preferência, uma de descrição.

O padrão consolidado é `ean;descricao`, uma linha por EAN. Preserve os códigos como texto,
inclusive zeros iniciais. No XLSX, a primeira aba contém os produtos; abas auxiliares não são importadas.
PDFs devem ser convertidos e conferidos antes do envio. Produtos sem EAN válido ficam em pendências,
sem inventar códigos a partir do nome ou do PLU.

Antes de importar, simule contra a galeria inteira, sem criar job, gravar dados ou chamar APIs externas:

```bash
curl -s -H "$H" -F "file=@produtos-unicos.csv" "$B/import-jobs/preview" | jq .data
```

O retorno traz `counts` (`already_exists`, `needs_lookup`, `invalid`, `internal_use`, `duplicate`),
`items` e `maxCredits`/`maxCostBrl`: limite superior do custo DotCompany dos EANs ausentes da galeria,
antes do reaproveitamento do cache. Não inclui o parser de nomes e embeddings da OpenAI usados ao
importar fotos. Esse limite é uma estimativa no instante da simulação, não uma reserva de orçamento.
Ambas as rotas de upload exigem `x-admin-token` antes de ler o arquivo, limitado a 20 MB.

```bash
curl -s -H "$H" -F "file=@arcos.csv" "$B/import-jobs?clientId=<uuid-do-cliente>&costCapCredits=12000" | jq .data
```

- `costCapCredits` é o teto do job (padrão `EAN_IMPORT_DEFAULT_CAP_CREDITS`; 0 = sem teto próprio).
- O `clientId` fica só no relatório do job: as fotos DotCompany **não** viram preferidas do cliente (a preferência é só o que o cliente escolhe).
- Enviar o **mesmo arquivo** de novo devolve o job existente (`created: false`).
- O runner procura primeiro o EAN na **galeria inteira**, incluindo fotos OFF, ERP e manuais,
  com equivalência UPC-A/EAN-13/GTIN-14 de zero inicial. Se encontrar, conclui como `already_exists`
  sem consultar a DotCompany ou importar outra foto. Depois usa o cache e só então o catálogo externo.
- Semelhança por descrição não grava EAN em uma imagem existente. O fluxo de vínculo com adjudicação
  continua separado em `/ai/gallery/match-ean-from-spreadsheet` e `/ai/ean/jobs`.

Acompanhar:

```bash
curl -s -H "$H" $B/import-jobs | jq '.data[] | {id, status, waitReason, costBrl, counts}'
curl -s -H "$H" $B/import-jobs/<id> | jq .data
curl -s -H "$H" "$B/import-jobs/<id>/items?result=not_found&limit=50" | jq .data
```

### Resultados por linha (`counts`, `?result=`)

| result | significado |
|---|---|
| `imported` | foto DotCompany baixada para a galeria |
| `already_exists` | já havia foto desse EAN na galeria, de qualquer fonte |
| `no_image` | a DotCompany conhece o EAN, mas não tem foto |
| `not_found` | a DotCompany não conhece o EAN (grátis; consulta de novo depois de 30 dias) |
| `invalid` | dígito verificador ou comprimento inválido (sem consulta) |
| `internal_use` | balança (prefixo 2), cupom (98/99) ou sequencial 7890000: não tem cadastro nacional |
| `duplicate` | EAN repetido no arquivo (só a 1ª linha conta) |
| `error` | falhou 3 vezes (rede, download da foto…) |
| `pending` | ainda na fila |

### Status do job

| status | o que fazer |
|---|---|
| `pending` / `running` | nada, roda sozinho (~1 lote de 100 a cada poucos segundos) |
| `waiting_budget` | nada, **volta sozinho**. `waitReason` diz o motivo (ver abaixo) e `waitUntil`, quando reavalia |
| `paused` | pausa manual, só volta com `resume` |
| `paused_cap` | atingiu o teto do job; `resume?costCapCredits=<novo teto>` |
| `failed` | credencial recusada (401/403); confira o token e dê `resume` |
| `done` | terminou |

`waitReason`:

| waitReason | quando volta |
|---|---|
| `rate_window` | no próximo minuto |
| `hour_limit` | na próxima hora |
| `day_limit` | à meia-noite (America/Sao_Paulo) |
| `reserve` / `no_credit` | quando o saldo conferido subir (recarga). Para acelerar: `POST $B/usage/refresh` |
| `no_token` | quando `DOTCOMPANY_API_TOKEN` for configurado e o backend reiniciado |

Pausar e retomar:

```bash
curl -s -H "$H" -X POST $B/import-jobs/<id>/pause | jq .data
curl -s -H "$H" -X POST "$B/import-jobs/<id>/resume?costCapCredits=20000" | jq .data
```

## No encarte

Quando a planilha do encarte (builder V2) traz uma coluna de EAN, a busca de imagens (`POST /v1/ai/product-image-match-v2`)
segue esta ordem:

1. **Procura o EAN na galeria.** Se houver foto, ela é usada, sem custo.
2. **Se não houver, consulta a DotCompany** como consulta interativa, com prioridade sobre os jobs, e importa a foto.
3. **Procura também, pelo nome, fotos parecidas na nossa base** e as oferece como opção. Essas fotos não recebem o
   EAN.

A foto do card segue esta prioridade: preferida do cliente > foto de outra fonte > foto DotCompany. As demais vão em
`alternatives`.

O que não terminar em `EAN_FLYER_RESOLVE_TIMEOUT_MS` (padrão 20 s) volta em `pending`. Isso continua num job
`kind = 'flyer'`, e uma nova busca encontra a foto na galeria.

Sem crédito ou com limite atingido, o encarte não quebra: o produto segue o casamento por nome com
`eanStatus = budget_blocked`.

## Onde olhar quando algo der errado

- Logs: `sudo -iu raphael pm2 logs flyer-api --lines 200 --nostream | grep -i dotcompany`. Erros da DotCompany vêm
  com `request_id` (útil para o suporte deles). O token nunca aparece em log.
- Tabelas:
  - `dotcompany_lookups`: cache por EAN, com `status`, `raw`, `galleryImageId` e `lastError`;
  - `ean_import_jobs` / `ean_import_items`;
  - `dotcompany_usage_hourly`;
  - `dotcompany_balance`;
  - `dotcompany_pending_batches`: lotes pagos sem resposta conclusiva, com a `Idempotency-Key`, `"lastOutcome"`
    (`timeout`/`network`/`http_5xx`/`http_4xx`), `"lastError"` e `"retryNotBefore"` (409 em voo: reenvio só depois).
    A linha some quando o lote fecha; mais de 24 h ou 5 chamadas sem resposta, é descartada. Linha parada = a
    DotCompany ainda segura a chave (espera até 3 min para virar `ORPHANED`).
- Fotos importadas: pasta **DotCompany** da galeria, com `metadata.eanSource = 'dotcompany'` e
  `eanVerifiedBy = 'exact'`.
