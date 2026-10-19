# Padrões de código do backend (Chroma `flyer-api`, branch `main`)

Documento do `backend-dev`. Vale para todo código de `src/` (e `test/`, quando existir). É a régua do `code-reviewer`: o que o ESLint e o `tsc` não pegam, a revisão confere à mão. Em caso de divergência com o `design.md` de uma change aprovada, vale o `design.md` e este arquivo deve ser corrigido.

## Como verificar

Os comandos rodam dentro do container (`docker compose exec -T backend <cmd>`, a partir da raiz do workspace) ou no host com o Node 22 x64 do nvm (`export PATH=$HOME/.nvm/versions/node/v22.11.0/bin:$PATH`; o Node 24 arm64 do shell não carrega `sharp`/`bcrypt` x64). Nada aqui usa `--fix`.

| Checagem | Comando | Linha de base (11/10/2026, host, Node 22.11.0) |
|---|---|---|
| ESLint | `npx eslint "{src,apps,libs,test}/**/*.ts"` (o script `npm run lint` tem `--fix` e não é gate) | 0 problemas |
| Tipos | `npx tsc --noEmit -p tsconfig.json` | 0 erros |
| Unitários | `npm test` (Jest, `*.spec.ts` sob `src/`) | 85 suítes verdes, 6 puladas (integração), 1204 testes |
| Build | `npm run build` (`nest build` → `dist/`) | OK |
| Integração com banco | `EAN_IT_DB_PORT=5433 EAN_IT_DB_NAME=ean_mig_test npx jest <padrão>` (só os specs que importam `ean-test-db.ts`; banco descartável já migrado) | rodar quando a change toca `ai/ean`, `ai/metadata` ou `gallery` |
| Migrations | `npm run migration:run` e `npm run migration:revert` no Postgres local; `migration:show` sem pendente | — |
| Subida | `docker compose up -d` e `curl -s http://localhost:3001/v1/health` → 200 com `database: connected` | — |

- **Gate rápido** (para o `[x]` de cada task e cada commit intermediário): ESLint, tipos, unitários e build, todos com código 0.
- **Gate completo** = gate rápido + integração com banco dos módulos tocados (quando existir) + `migration:run`/`revert` (quando a change tem migration) + subida no Docker com health 200. Roda uma vez no fim da seção do backend, antes de devolver ao tech-lead para a revisão, e de novo depois de cada rodada de correção (revisão ou QA). Commit intermediário pode ter integração quebrada; o último commit da seção nunca.
- `npm run test:e2e` aponta para `test/jest-e2e.json`, que não existe: não é gate. Suíte e2e nova entra por change.

## Versões conferidas (11/10/2026)

| Item | Versão | Observação |
|---|---|---|
| Node | 18 no container (`node:18-alpine` + ffmpeg); 22.11.0 x64 no host | não subir sem decisão registrada |
| NestJS | 10 (Express) | `@nestjs/passport` + `passport-jwt`; `@nestjs/swagger` em `/api` |
| TypeORM | 0.3 | `synchronize: true` só em `NODE_ENV=development`; migrations em `src/migrations/`, DataSource do CLI em `src/data-source.ts` |
| PostgreSQL | 15 + `pgvector` (`pgvector/pgvector:pg15`) | coluna `vector` em `gallery_images` fora da entidade |
| TypeScript | 5, `strictNullChecks: false`, `noImplicitAny: false` | código novo escreve como se fosse strict (tipos explícitos, sem `any` novo) |
| Jest | ts-jest, `rootDir: src`, `testRegex .*\.spec\.ts$` | `reflect-metadata` em `setupFiles` |
| ESLint | `.eslintrc.js`: `@typescript-eslint/recommended` + prettier; `no-unused-vars` erro (`_` ignorado); `no-explicit-any` desligado; fronteira `animations` ↔ `commercials` | não relaxar regra sem registro no `design.md` |

## Estrutura: módulo por domínio

Uma pasta por domínio em `src/modules/` (`auth`, `products`, `clients`, `collaborators`, `flyers`, `flyer-builder-v2`, `templates`, `fonts`, `gallery`, `uploads`, `dashboard`, `health`, `email`, `ai`, `animations`, `commercials`, `mascots`), com `*.module.ts`, `*.controller.ts`, `*.service.ts`, `dto/`, `entities/` e `*.spec.ts` ao lado do código. O módulo `ai/` é o maior e tem subpastas por assunto (`ean/`, `ean/dotcompany/`, `metadata/`); um serviço novo de IA nasce em subpasta, não solto em `ai/`.

| Sufixo | Camada |
|---|---|
| `*.controller.ts` | HTTP: lê request, chama service, devolve DTO/objeto simples; sem regra, sem `Repository`, sem SQL |
| `*.service.ts` | regra de aplicação e orquestração; usa `Repository<Entidade>`/`DataSource` injetados |
| `*.store.ts` / `*.repository.ts` | acesso a dados dedicado quando o módulo já separa (`ean-match.store.ts`, `ean-import.store.ts`) |
| `*.entity.ts` | entidade TypeORM (`**/*.entity.ts` é o padrão de carga) |
| `dto/*.dto.ts` | entrada validada com class-validator + `@ApiProperty` |
| `*.provider.ts` / `*.client.ts` | cliente de serviço externo (OpenAI, DotCompany, Gemini, Replicate), com fake injetável |
| `*.spec.ts` | unitário ao lado; integração com banco só via `ean-test-db.ts` |

Transversal: `src/common/` (decorators `@Public()`, `@CurrentUser()`, `@SkipValidation()`; `HttpExceptionFilter`; `JwtAuthGuard`; `ResponseInterceptor`; `SmartValidationPipe`; utils de paginação e arquivo) e `src/shared/` (`credits/`, `events/`, `ffmpeg/`, `gc/`, `media-assets/`, `providers/`, `queue/` pg-boss, `resource-guard/`, `settings/`, `state/`, `voice/`). Regra de negócio de um módulo não entra em `common/` nem em `shared/`; o que dois módulos usam entra em `shared/`.

Fronteiras (a primeira é reprovada pelo ESLint; as demais, pela revisão):
1. `modules/animations` e `modules/commercials` nunca se importam; infraestrutura comum vive em `src/shared/`.
2. Controller não importa `Repository`, `DataSource` nem entidade para consultar; só DTOs e o service.
3. `common/` e `shared/` não importam `modules/`.
4. Um módulo importa de outro só o `*.module.ts` e os services exportados; nunca o controller nem o store de outro módulo.

## Contrato HTTP

- Prefixo global `/v1` (não repetir no `@Controller`). Swagger em `/api`, Bearer JWT.
- `JwtAuthGuard` é global: toda rota exige `Authorization: Bearer <access>`; `@Public()` abre a rota (hoje: login, signup, refresh, forgot/reset password, verify-email, health). Rota administrativa usa header `x-admin-token` validado contra `ADMIN_API_TOKEN` (padrão do módulo `ai`).
- `ResponseInterceptor` envelopa tudo: sucesso `{ success: true, data, pagination? }`; `HttpExceptionFilter` devolve `{ success: false, error: { code, message } }`. Lance `HttpException` do Nest com `{ code, message }` (`UnauthorizedException({ code: 'INVALID_CREDENTIALS', ... })`); não monte o envelope à mão nem devolva `res.json`.
- Entrada por DTO de classe com class-validator; `SmartValidationPipe` global com `whitelist` + `transform`: campo desconhecido é descartado, tipo errado é 400. Multipart usa `createFileInterceptor` + `@SkipValidation()` e valida os campos de texto no service.
- Paginação: query `page` (1) e `limit` (20); resposta `{ data, total, page, limit, totalPages }` em `data`.
- Status: 400 validação, 401 sem/inválido token ou credencial, 403 admin token, 404 recurso inexistente ou de outro usuário (não revele existência), 409 conflito de estado (duplicado, job já em andamento), 402/503 só para repassar integração externa sem crédito/indisponível com mensagem clara. O mesmo caso responde sempre o mesmo `code`.
- JSON em `camelCase`; datas em ISO 8601 UTC; ids UUID. Campos sensíveis (`password`, tokens de verificação e reset, segredos) nunca saem (`const { password, ...rest } = user`).
- Uploads: via `UploadsService` em `uploads/<pasta>/` (`products/`, `logos/`, `avatars/`, `templates/`, `fonts/`, `thumbnails/`, `gallery/`, `general/`), URL com `CDN_URL`; servidos em `/uploads/*` com CORS explícito (o frontend rasteriza via canvas). Cópia de arquivo no bind mount do Docker Desktop por stream (`createReadStream().pipe(createWriteStream())`), nunca `fs.copyFile` (pendura).

## Banco de dados e migrations

- Colunas novas seguem o padrão de nome da tabela existente (a maioria é `camelCase` entre aspas, como `"mimeType"`; não misture).
- **Toda mudança de schema vai em migration** em `src/migrations/<timestamp>-<Nome>.ts`, com `up` e `down` completos, testada com `migration:run` e `migration:revert` no Postgres local. Em dev o `synchronize: true` aplica a entidade sozinho e esconde a falta de migration; em produção `synchronize` está off e o `deploy.sh` roda `migration:run:prod`. Change sem migration para coluna nova é bloqueante.
- `gallery_images` e `gallery_folders` têm `{ synchronize: false }`: colunas e índices (inclusive `embedding vector`) entram por SQL na migration.
- Jobs retomáveis seguem o padrão existente: tabela de job + tabela de itens, `SELECT ... FOR UPDATE SKIP LOCKED`, status condicional, teto de custo, pausa/retomada por rota admin, runner com `setTimeout` e flag de ambiente para desligar (`EAN_IMPORT_RUNNER_ENABLED`). Escrita que precisa ler-e-gravar o mesmo registro usa transação com `FOR UPDATE` (ex.: `saveImageMetadata`).
- Repetição de comando, upload duplicado e duas abas são cenários normais: defina e teste o resultado (idempotência por hash de arquivo, por EAN, por `Idempotency-Key`).

## Integrações externas e custo

- OpenAI, DotCompany, Replicate, Gemini, Pixabay e SMTP ficam atrás de um serviço próprio com interface injetável e fake para teste; `fetch`/SDK direto só nesse serviço.
- Toda integração tem flag de ambiente para desligar e sobe sem token (log `warn` e erro claro na rota, nunca crash no boot).
- Controle de consumo passa pelos serviços existentes (`shared/credits/`, `DotcompanyBudgetService`): janela por minuto, limites por hora/dia, reserva, alerta por e-mail. Serviço novo pago reaproveita esse controle em vez de criar outro.
- **Teste automatizado nunca chama API paga.** Chamada real só manual, autorizada pelo desenvolvedor, com teto, e o custo vai no retorno do agente.
- Nunca logar token, chave, `.env` nem corpo com segredo; logs de erro de integração registram status e `X-Error-Code`, não o header `Authorization`.

## Limites (régua do code-reviewer para arquivo e função novos)

Não há automação desses limites hoje (pendência P-02 em `docs/resumos/decisoes.md` da raiz); valem para **arquivo criado** e **função nova** na change, conferidos na revisão:

| Regra | Valor |
|---|---|
| linhas efetivas por arquivo (sem brancos e comentários) | 250 (testes 300) |
| linhas por função | 50 (callbacks de `describe`/`it` não contam) |
| complexidade ciclomática | 10 |
| profundidade de aninhamento | 3 |
| parâmetros | 4 (passe um objeto quando precisar de mais) |
| `any` novo | não; tipe ou use `unknown` com narrowing |
| duplicação | nenhum bloco copiado de outro arquivo; extraia para `shared/` ou para o módulo |

Arquivo pré-existente que estoura o limite não é achado; a mudança nele é a mínima da task. Quando o limite estoura em código novo, extraia uma função com nome do que ela faz (`parseEanColumn`, `buildDotcompanyMetadata`), não uma abstração genérica.

## Nomes

- Arquivos em `kebab-case` com sufixo de camada; um tipo principal por arquivo.
- Classes `PascalCase`, funções e variáveis `camelCase`, constantes `UPPER_SNAKE_CASE`, variáveis de ambiente `UPPER_SNAKE_CASE` com prefixo do domínio (`DOTCOMPANY_*`, `EAN_IMPORT_*`, `OPENAI_IMAGE_*`), documentadas em `.env.example` e no `CLAUDE.md` do backend.
- Código e comentários em português são aceitos e já são maioria nos módulos novos; mensagens de erro ao usuário em pt-BR; `code` sempre em `UPPER_SNAKE_CASE` sem acento.
- Função com nome de verbo que diz o efeito; sem `utils.ts`/`helpers.ts` genéricos novos.
- Commits em pt-BR no padrão do histórico: `feat(ean): ...`, `fix(gallery): ...`, `chore(infra): ...`.

## Testes

- Unitários ao lado do código (`nome.spec.ts`), sem rede e sem banco: regra pura, mapeamento, serviços com provider fake, controllers com service mockado.
- Integração com Postgres real só nos módulos que já usam `ean-test-db.ts` (`EAN_IT_ENABLED`): o spec pula quando `EAN_IT_DB_NAME` não está definido e roda contra banco descartável migrado. Dados com sufixo único; limpeza no `afterAll`.
- Relógio falso (`jest.useFakeTimers`) para janelas de rate limit e retomada de job; `fetch` mockado para clientes HTTP.
- Contagem de testes não cai ao refatorar: se dividir ou mover um arquivo, compare a contagem antes e depois.

## Armadilhas conhecidas

- O container `chroma_backend` roda `npm start` sem watch: `docker restart chroma_backend` para ver a mudança; `docker compose build backend` depois de instalar dependência.
- Alpine: `drawtext` do ffmpeg precisa de `ttf-dejavu`; `fs.copyFile` pendura no bind mount de `uploads/` do Docker Desktop (copie por stream).
- Produção é HTTP puro, PM2 com uma instância, `NODE_ENV=production`: nada de `synchronize`, nada que dependa de contexto seguro.
- `.env` do backend tem segredos reais: nunca copiar, imprimir ou commitar; variáveis novas entram em `.env.example` com valor de exemplo.
