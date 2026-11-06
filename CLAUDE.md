# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run start:dev        # Dev server with auto-reload (port 3001)
npm run start:prod       # Production (node dist/main)
npm run build            # Compile TypeScript → dist/
npm run lint             # ESLint --fix
npm run format           # Prettier
npm run test             # Unit tests (Jest)
npm run test:watch       # Watch mode
npm run test:cov         # Coverage
npm run test:e2e         # E2E tests

# Database migrations (DataSource do CLI: src/data-source.ts)
npm run migration:generate -- src/migrations/MigrationName
npm run migration:run        # dev, via ts-node
npm run migration:revert
npm run migration:show       # quais já rodaram

# Prod (VM): rodam contra dist/, sem ts-node. O deploy.sh da raiz do monorepo
# chama migration:run:prod entre o build e o pm2 restart.
npm run migration:run:prod
npm run migration:show:prod
```

## Environment

Required variables (see `.env`):
```
DB_HOST / DB_PORT / DB_USER / DB_PASS / DB_NAME
JWT_SECRET / JWT_REFRESH_SECRET
JWT_EXPIRES_IN / JWT_REFRESH_EXPIRES_IN
MAIL_HOST / MAIL_PORT / MAIL_USER / MAIL_PASS / MAIL_FROM
CDN_URL          # Base URL for uploaded file references
FRONTEND_URL     # Used in reset-password / verify-email links
BASE_URL         # Backend base URL used in email verification links

# AI integrations (ai module)
OPENAI_API_KEY                # OpenAI (text/vision/image/embeddings)
OPENAI_TEXT_MODEL             # default gpt-4o
OPENAI_FAST_TEXT_MODEL        # default gpt-4o-mini
OPENAI_IMAGE_MODEL            # default gpt-image-2.5-sunburst (+ OPENAI_IMAGE_PREVIEW_MODEL, default gpt-image-2.5-flare)
OPENAI_IMAGE_*                # quality, format, concurrency, retry, cost knobs
OPENAI_ENABLE_DALLE_FALLBACK  # opt-in DALL-E 3 fallback
PIXABAY_API_KEY               # product image search
REPLICATE_API_TOKEN           # SAM image segmentation
ADMIN_API_TOKEN               # gates /ai/gallery/* admin routes (x-admin-token header)
AI_GALLERY_EMBEDDING_ENABLED  # toggles pgvector setup/backfill on boot
AI_CLIENT_IMAGE_PREF_BOOST    # Feature 12: cosine-distance bonus for a client's
                              # preferred images in product-image matching (default 0.15)

# DotCompany — catálogo de produtos por EAN (src/modules/ai/ean/dotcompany/README.md)
DOTCOMPANY_API_TOKEN          # dc_live_/dc_test_ (sem token: nada é consultado)
DOTCOMPANY_BASE_URL           # default https://erp.dotcompany.com.br/api/v1
DOTCOMPANY_RPM                # janela/min do plano (Free 30, Starter 120, Pro 600)
DOTCOMPANY_MAX_REQUESTS_HOUR / _DAY, DOTCOMPANY_MAX_CREDITS_HOUR / _DAY
                              # limites NOSSOS (a DotCompany não limita por hora/dia)
DOTCOMPANY_RESERVE_CREDITS    # abaixo disso os jobs em lote param; o encarte continua
DOTCOMPANY_ALERT_CREDITS / DOTCOMPANY_ALERT_EMAIL / DOTCOMPANY_BALANCE_REFRESH_MIN
EAN_IMPORT_RUNNER_ENABLED / EAN_IMPORT_DEFAULT_CAP_CREDITS
EAN_FLYER_RESOLVE_ENABLED / EAN_FLYER_RESOLVE_TIMEOUT_MS
EAN_ANCHOR_LINKER_MODE        # fase 2 (off | measure | write), default off
EAN_JOB_RUNNER_ENABLED        # pipeline antigo de vínculo EAN por juízes — default false

# Comerciais com mascote (módulo commercials) — bloco completo em .env.example
MC_ENABLED                    # liga rotas e consumers; sem isso as rotas respondem 404 MC_DISABLED
MC_PIPELINE_V2                # off | all | cohort — executor v2 (ADR-001) congelado por projeto na criação
MC_SCRIPT_PROVIDER / MC_KIT_PROVIDER / MC_PIPELINE_PROVIDER / MC_TRANSLATION_PROVIDER
                              # mock (default) | openai / gemini / real
MC_FORMATS                    # formatos novos admitidos (talking_art, offer_carousel, offer_piece); vazio = nenhum;
                              # 'scenes' sempre passa; token desconhecido derruba o boot (parseMcFormats)
MC_TALK_ENGINE_ECONOMICO / _PREMIUM / _LOGO
                              # "modelo fal | US$/s | máx. s por chamada" — motor de fala por tier e origem
GEMINI_IMAGE_MODEL_REFS       # modelo das referências do kit (default GEMINI_IMAGE_MODEL)
MC_KIT_PRICES                 # tarifas do custo registrado do kit: "modelo|US$/imagem|US$/1M entrada|US$/1M saída",
                              # vírgula entre modelos; vazio = tabela padrão (domain/mc-kit-costs.ts); substitui/acrescenta
                              # por modelo; mal escrita derruba o boot
MC_RENDER_BROWSER             # navegador do render Remotion (offer_carousel e o quadro do offer_piece); vazio = formatos indisponíveis
MC_RENDER_FONT_FILE           # dica só para o preflight (DejaVuSans.ttf fora dos caminhos usuais); o drawtext usa o fontconfig
MC_CAROUSEL_RENDERER          # mock (default com pipeline mock) | remotion — renderizador do F2
MC_RENDER_ASSET_BASE_URL      # base absoluta das mídias passadas ao Remotion (default http://127.0.0.1:3001)
MC_COMPOSITION_VERSION        # versão das composições @chroma/video-templates no hash do render (default 0.3.0; vale a do pacote quando carregado)
MC_TALK_CONTINUOUS            # `true` liga a FALA CONTÍNUA (personagem em tomada contínua) para projetos NOVOS de offer_piece e talking_art (só a API lê; padrão desligada; congelada no roteiro); GET config informa
MC_TALK_CHUNK_MAX_S           # teto (s) de áudio por trecho (padrão 10, ≤ maxChunkS do motor; vazio = maxChunkS; inválido derruba o boot)
MC_TALK_POLL_PER_AUDIO_S      # s de espera por s de áudio no provider_wait do talk de trecho (padrão 150; piso 15 min, teto 40 min)
MC_MOCK_POSE / MC_CLIP_INSPECTION_MOCK
                              # só worker + provider mock: `on` liga a pose do clipe mock também no modo de hoje (medir o salto); `text`|`text_once` inventa o veredito de texto no clipe do trecho (QA sem chamada paga)
MC_CHARACTER_CUTOUT           # `true` liga o personagem SEM FUNDO e o enquadramento de corpo (só a API lê; padrão desligado); GET config informa
MC_CUTOUT_MOCK                # `unstable` (só no worker, só com MC_PIPELINE_PROVIDER=mock): o talk mock devolve fundo-chave que muda de tom (fixture da reprovação)
MC_VIDEO_TEMPLATES_DIR        # checkout local do pacote de composição (dev, enquanto ele não é dependência)
MC_KIT_CANDIDATE_COUNT / MC_KIT_STYLE_REFS_DIR
                              # candidatos por rodada (4–6) e referências de estilo opcionais da mascotização
MC_MOUTH_GATE_MOCK / MC_LOGO_LOCATOR_MOCK / MC_PRICE_DETECT_MOCK / MC_MOCK_TTS_MAX_S
                              # comportamento dos mocks de visão e TTS (e2e sem chamadas pagas)
GC_DRY_RUN                    # GC de /uploads (inclui /uploads/commercials) só loga por padrão

# Cena de template (módulo template-scenes, Template Pro) — bloco completo em .env.example
TEMPLATE_SCENE_ENABLED        # liga rotas, fila, SSE e GC da cena; sem isso as rotas respondem 404 TEMPLATE_SCENE_DISABLED
TEMPLATE_SCENE_IMAGE_PROVIDER # mock (padrão, sem custo; valor desconhecido também cai no mock) | openai (pago, só na passada do dono)
TEMPLATE_SCENE_IMAGE_MODEL / TEMPLATE_SCENE_IMAGE_QUALITY
                              # gpt-image-2.6-sunburst / high; passados explicitamente (não dependem de OPENAI_IMAGE_MODEL). Modelo sem preço na tabela de capacidades não é chamado na cena
TEMPLATE_SCENE_CONCURRENCY    # jobs de IMAGEM em paralelo no worker (padrão 1)
TEMPLATE_SCENE_DIRECTOR_MODEL / TEMPLATE_SCENE_DIRECTOR_TIMEOUT_MS / TEMPLATE_SCENE_DIRECTOR_CONCURRENCY
                              # Diretor (D-23): gpt-6-luna (`/responses`, effort medium, store false) / 20000 ms / 4 leituras em paralelo, fila própria
TEMPLATE_SCENE_WINDOW_SECONDS # janela com "Parar" antes da chamada de imagem (padrão 5; o job entra pelo menos 5 s depois, pelo intervalo da fila)
TEMPLATE_SCENE_MOCK_LATENCY_MS / TEMPLATE_SCENE_MOCK_SLOW_MS
                              # latência do mock (20000; 0 nos testes) e do marcador #lento (3000)
TEMPLATE_SCENE_ASSET_TTL_DAYS / TEMPLATE_SCENE_DELETED_RETENTION_DAYS / TEMPLATE_SCENE_MASTERS_KEPT
                              # 7 dias (raw_output, mask, crop) / 30 dias (cena excluída) / 20 versões com master guardada (D-34); a atual e as aprovadas também ficam (D-20)
TEMPLATE_SCENE_GC_DRY_RUN     # só vale para /uploads/template-scenes; ausente = true (só apaga com false explícito); o GC_DRY_RUN global não muda
TEMPLATE_SCENE_MAX_PAID_CALLS_PER_MESSAGE
                              # disjuntor: chamadas pagas por mensagem (padrão 4)
TEMPLATE_SCENE_VISION_MODEL / TEMPLATE_SCENE_VISION_TIMEOUT_MS
                              # o juiz: gpt-6-luna (reasoning_effort low, imagens inteiras em JPEG, detail high) / 20000: passou do tempo, a resposta diz que não conseguiu conferir
TEMPLATE_SCENE_EDIT_QUALITY   # qualidade do redesenho da imagem inteira (padrão high)
OPENAI_TIMEOUT_MS             # timeout por requisição do modo sceneCall (padrão 180000); NÃO é global
TEMPLATE_SCENE_E2E_DB_URL     # só testes: banco descartável chroma_x_e2e (nunca o flyer_db); sem ela os specs de banco ficam skipped
FAL_API_KEY / ELEVENLABS_API_KEY / GEMINI_API_KEY
                              # pipeline real (vídeo, TTS, imagens)
FFMPEG_PATH / FFPROBE_PATH    # binários do ffmpeg (worker); o preflight do worker reporta no /v1/health
```

## Architecture

**NestJS + TypeORM + PostgreSQL** backend for the Offer Creator Studio frontend. Serves the API on port 3001 under global prefix `v1/`.

### Module structure

```
src/
├── common/
│   ├── decorators/       # @Public(), @CurrentUser(), @SkipValidation()
│   ├── filters/          # HttpExceptionFilter (global)
│   ├── guards/           # JwtAuthGuard (global — all routes protected by default)
│   ├── interceptors/     # ResponseInterceptor (wraps all responses), multipart handler
│   ├── pipes/            # SmartValidationPipe (handles multipart + JSON bodies)
│   └── utils/            # Pagination helpers, file utilities
├── config/
│   └── database.config.ts
├── migrations/           # e.g. AddKindToFlyers (adds flyers.kind + index)
└── modules/              # auth, clients, collaborators, dashboard, email,
                          # flyers, flyer-builder-v2, fonts, gallery, health,
                          # products, templates, uploads, ai
```

**Stack:** NestJS 10 · TypeORM 0.3 · PostgreSQL 15 (+ `pgvector`) · Passport JWT · bcrypt ·
multer + sharp (uploads/thumbnails) · nodemailer (SMTP) · OpenAI / Pixabay / Replicate SDKs ·
Swagger (`/api`).

### Response envelope

Every response is wrapped by `ResponseInterceptor`:
```json
{ "success": true, "data": {...}, "pagination": {...} }
{ "success": false, "error": { "code": "...", "message": "..." } }
```
The frontend `httpClient` unwraps `data` automatically.

### Authentication

- **JWT Bearer** — global `JwtAuthGuard` protects all routes by default.
- Use `@Public()` decorator to opt out of auth on a route.
- Access token (1h, `JWT_SECRET`) + refresh token (7d, `JWT_REFRESH_SECRET`), separate secrets.
- Passwords hashed with bcrypt (10 rounds) via TypeORM `@BeforeInsert`/`@BeforeUpdate` hooks on `User` entity. The hook checks for `$2b$` prefix to avoid double-hashing.
- Email verification and password reset use short-lived random tokens (32 bytes hex) stored on the `User` entity with expiration timestamps.
- **Security:** forgot-password does not reveal whether an email exists.

### Database

- TypeORM with PostgreSQL. Entity files match pattern `**/*.entity.ts`.
- `synchronize: true` in development, `false` in production (use migrations).
- Flexible data stored as JSONB: `flyer.configuration`, `flyer.customGridConfig`, `user.establishment`, `template.configuration`.

### File uploads

- Multer via custom `createFileInterceptor` wrapper. Use `@SkipValidation()` on multipart endpoints to bypass DTO validation.
- Files stored in `./uploads/<folder>/` by domain: `products/`, `logos/`, `avatars/`, `templates/`, `fonts/`, `thumbnails/`, `gallery/`, `general/`.
- Served statically from `/uploads`. Referenced in DB as paths prefixed with `CDN_URL`.
- `UploadsService` is the shared service used by all modules for file saving.
- **`UPLOAD_DEST` é fixado em caminho absoluto no boot** (`src/common/config/uploads-dir.ts`, change `video-worker-confiabilidade`): `main.ts` e `worker.ts` chamam `pinUploadsDirEnv()` na primeira linha do `bootstrap()` (log `Uploads em <caminho>`), e todo ponto que resolve o diretório usa `resolveUploadsDir(config.get('UPLOAD_DEST'))` (relativo é ancorado no diretório do processo no carregamento do módulo; absoluto passa intacto). Nunca `path.resolve`/`join` relativo sobre `UPLOAD_DEST` nem `process.cwd()` fora do helper: o `@remotion/bundler` faz `process.chdir` durante o `bundle()` e um caminho relativo resolvido a cada uso cai na pasta do Remotion (`missing_input_asset` no `talk`, ENOENT em `uploads/mascots`). `uploads-dir.guard.spec.ts` quebra o `npm test` se aparecer um ponto novo. Recomendado valor absoluto na VM (relativo é resolvido contra o `exec cwd` `/opt/encarte/backend`).

### Pagination

Standard query params: `page` (default 1), `limit` (default 20). Returns:
```json
{ "data": [], "total": 0, "page": 1, "limit": 20, "totalPages": 0 }
```

### Adding a new module

Follow the existing pattern: `module.ts` → `controller.ts` → `service.ts` → `entities/` → `dto/`. Register in `app.module.ts`.

---

## Modules

### auth

**Endpoints** (prefix: `/v1/auth`)

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| POST | `/login` | No | Returns `{ user, token, refreshToken, expiresIn }` |
| POST | `/signup` | No | Returns `{ user, message }` |
| POST | `/refresh` | No | Body: `{ refreshToken }` → `{ token, expiresIn }` |
| POST | `/forgot-password` | No | Body: `{ email }` |
| POST | `/reset-password` | No | Body: `{ token, password, confirmPassword }` |
| GET | `/verify-email?token=` | No | |
| GET | `/profile` | JWT | |
| PATCH | `/profile` | JWT | Body: UpdateProfileDto |
| POST | `/avatar` | JWT | multipart/form-data |

**Entity: `users`**

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| email | string | unique |
| password | string | bcrypt hashed |
| name | string | |
| emailVerified | boolean | default false |
| role | varchar(20) | default 'user' |
| phone | string | nullable |
| cpfCnpj | string | nullable |
| establishment | jsonb | nullable — `{ tradeName, companyName, address, city, state, zipCode }` |
| avatarUrl | string | nullable |
| emailVerificationToken | string | nullable |
| emailVerificationExpires | Date | nullable |
| passwordResetToken | string | nullable |
| passwordResetExpires | Date | nullable |

**UpdateProfileDto fields:** `name`, `phone`, `cpfCnpj`, `avatarUrl`, `establishment` (nested object with the JSONB fields above). Establishment is merged with existing data, not replaced.

---

### clients

**Endpoints** (prefix: `/v1/clients`)

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| POST | `/` | JWT | CreateClientDto |
| GET | `/` | JWT | Query: `page, limit, search` |
| GET | `/:id` | JWT | |
| PATCH | `/:id` | JWT | UpdateClientDto |
| DELETE | `/:id` | JWT | |
| POST | `/:id/logo` | JWT | multipart/form-data |

**Entity: `clients`**

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| name | string | |
| cnpj | string | unique |
| logoUrl | string | nullable |
| contacts | ClientContact[] | OneToMany, cascade, eager |

**Entity: `client_contacts`** — `id`, `name`, `role`, `email`, `phone`, `clientId` (FK → clients, cascade delete).

**Business rules:**
- CNPJ uniqueness enforced on create and update.
- On PATCH, contacts array is **fully replaced** (delete all + re-insert), not merged.
- Search queries name and cnpj with LIKE.

---

### collaborators

**Endpoints** (prefix: `/v1/collaborators`)

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| POST | `/` | JWT | CreateCollaboratorDto |
| GET | `/` | JWT | Query: `page, limit, search, role` |
| GET | `/:id` | JWT | |
| PATCH | `/:id` | JWT | UpdateCollaboratorDto (no password field) |
| DELETE | `/:id` | JWT | |
| POST | `/:id/avatar` | JWT | multipart/form-data |

**Entity: `collaborators`** — same structure as `users` table but with `status` field (`active`/`inactive`, default `active`). Password is omitted from all responses.

**DTOs:**
- `CreateCollaboratorDto`: `name`, `email`, `phone?`, `role` (enum: `collaborator`/`manager`/`admin`), `password` (min 6).
- `UpdateCollaboratorDto`: all optional, **no password field**.
- Query filter: `role` enum.

**Business rules:** Email uniqueness enforced. `emailVerified` defaults to false on creation. Search by name and email.

---

### products

**Endpoints** (prefix: `/v1/products`)

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| POST | `/` | JWT | CreateProductDto |
| GET | `/` | JWT | Query: `page, limit, search, category, minPrice, maxPrice` |
| GET | `/:id` | JWT | |
| PATCH | `/:id` | JWT | UpdateProductDto |
| DELETE | `/:id` | JWT | Sets `active = false` (soft delete) |
| POST | `/:id/image` | JWT | multipart/form-data |

**Entity: `products`**

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| name | string | |
| price | decimal(10,2) | min 0 |
| originalPrice | decimal(10,2) | nullable |
| unit | string | |
| imageUrl | string | nullable |
| category | string | nullable |
| sku | string | unique, nullable |
| observation | text | nullable |
| active | boolean | default true |

**Business rules:**
- DELETE is a **soft delete** — sets `active = false`. All GET queries filter `active = true`.
- SKU uniqueness checked only when a value is provided. On update, only fails if the new SKU belongs to a different record.
- Price range filter uses BETWEEN with minPrice/maxPrice.
- Search by name and SKU.

---

### templates

**Endpoints** (prefix: `/v1/templates`)

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| POST | `/` | JWT | CreateTemplateDto |
| GET | `/` | JWT | Query: `page, limit, search, type, isDefault` |
| GET | `/:id` | JWT | |
| PATCH | `/:id` | JWT | UpdateTemplateDto |
| DELETE | `/:id` | JWT | Blocked if `isDefault: true` |
| POST | `/:id/thumbnail` | JWT | multipart/form-data |

**Entity: `templates`**

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| name | string | |
| type | varchar(20) | `header` / `footer` / `full` |
| thumbnailUrl | string | nullable |
| isDefault | boolean | default false |
| configuration | jsonb | max 10MB |

**Business rules:**
- `configuration` JSONB max 10MB (measured via `JSON.stringify` length). Returns `CONFIGURATION_TOO_LARGE` or `PAYLOAD_TOO_LARGE` (base64 images) errors.
- Cannot delete a template with `isDefault: true`.
- Filter by `type` enum and `isDefault` boolean.

---

### flyers

**Endpoints** (prefix: `/v1/flyers`)

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| POST | `/` | JWT | CreateFlyerDto |
| GET | `/` | JWT | Query: `page, limit, search, clientId, startDate, endDate` |
| GET | `/:id` | JWT | Includes `clientName` |
| PATCH | `/:id` | JWT | UpdateFlyerDto |
| DELETE | `/:id` | JWT | |
| POST | `/:id/duplicate` | JWT | Body: `{ name }` → creates draft copy |
| POST | `/:id/thumbnail` | JWT | multipart/form-data |
| GET | `/:id/export` | JWT | Query: `format, quality` — **stub, not implemented** |

**Entity: `flyers`**

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| name | string | |
| clientId | string | nullable, FK → clients |
| client | Client | ManyToOne |
| thumbnailUrl | string | nullable |
| status | varchar(20) | default `draft` |
| configuration | jsonb | max 10MB — full flyer design |
| layout | varchar(20) | `auto` / `custom`, default `auto` |
| customGridConfig | jsonb | nullable |

**Business rules:**
- `configuration` max 10MB (same error codes as templates module).
- Duplicate copies `configuration`, `clientId`, `kind`, `layout`, `customGridConfig`, and sets `status: 'draft'` (Feature 11 — preserves document type and grid config so duplicating a social art stays `kind='social'`).
- Date range filter on `createdAt` using `startDate`/`endDate` (ISO date strings).
- List query joins client to include `clientName` in response.

---

### fonts

**Endpoints** (prefix: `/v1/fonts`)

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| POST | `/` | JWT | multipart/form-data only — fields: `file`, `family`, `weight`, `style` |
| GET | `/` | JWT | Returns all fonts, no pagination |
| DELETE | `/:id` | JWT | |

**Entity: `fonts`** — `id`, `family`, `weight`, `style`, `fileUrl`.

**Business rules:**
- Allowed extensions: `.ttf`, `.otf`, `.woff`, `.woff2`. Returns `INVALID_FONT_FILE` otherwise.
- All three metadata fields (`family`, `weight`, `style`) are required — returns `MISSING_FIELDS` if absent.
- Returns `FILE_REQUIRED` if no file is uploaded.
- No pagination — returns all fonts ordered by `createdAt DESC`.

---

### gallery

**Endpoints** (prefix: `/v1/gallery`)

**Images:**

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| GET | `/` | JWT | Query: `page, limit, search, folderId, clientId`. Each image includes `clients: [{id,name}]` (Feature 13) |
| PUT | `/images/:imageId/clients` | JWT | Body: `{ clientIds[] }` — replaces the image's client tags |
| POST | `/images/clients/bulk` | JWT | Body: `{ imageIds[], clientIds[], mode: 'add'\|'remove'\|'replace' }` |
| PUT | `/images/:imageId/ean` | JWT | Body: `{ ean, productName? }` — grava na imagem o EAN do produto para o qual ela foi escolhida (`GalleryImageEanService`) |
| PUT | `/images/:imageId/product-link` | JWT | Body: `{ productName, ean?, clientId? }` — grava na imagem o nome do produto (sempre, em `metadata.aliases`), o EAN (quando houver) e marca a imagem como preferida do `clientId` (`client_preferred_images`). É a rota que o fluxo guiado V2 usa ao escolher uma foto (`GalleryProductLinkService`) |
| POST | `/upload` | JWT | multipart/form-data — `files[]` (multiple), `folderId?` |
| DELETE | `/:id` | JWT | |
| POST | `/delete-many` | JWT | Body: `{ ids: string[] }` |
| POST | `/move` | JWT | Body: `{ imageIds: string[], folderId?: string \| null }` |

**Folders:**

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| GET | `/folders` | JWT | Returns all folders with `imageCount` |
| POST | `/folders` | JWT | Body: `{ name, color? }` |
| PATCH | `/folders/:id` | JWT | Body: `{ name?, color? }` |
| DELETE | `/folders/:id` | JWT | Moves images to root (folderId = NULL) |

**Client ↔ image link** — the N:N table backing both the matching boost (Feature 12) and the
gallery tagging UI (Feature 13). Managed by `ClientPreferredImagesService` (raw SQL via
DataSource, since the link table is SQL-managed — not a TypeORM entity) and exposed through the
`/gallery/images/...clients` routes above. There is **no** client-side entry point (a
`/clients/:id/preferred-images` controller existed briefly and was removed): the gallery's
client filter is the single place to view and edit these links.

**Entities:**
- `gallery_images`: `id`, `filename`, `url`, `thumbnailUrl` (nullable), `mimeType`, `size` (bigint), `folderId` (nullable FK, onDelete: SET NULL).
- `gallery_folders`: `id`, `name`, `color` (nullable).
- `client_preferred_images` (SQL-managed, in `sql/001_pgvector_setup.sql`): `(client_id, image_id)` PK, both FKs `ON DELETE CASCADE`. Not a TypeORM entity.

**Business rules:**
- **EAN escolhido no encarte:** quando o usuário escolhe a foto de um produto que tem EAN (revisão
  de imagens, "trocar imagem" ou galeria/upload no fluxo guiado V2), o front chama
  `PUT /gallery/images/:imageId/ean` e a imagem recebe o bloco EAN com `eanSource: 'manual'`,
  `eanVerifiedBy: 'human'`. Mesmo EAN já gravado (qualquer fonte) → nada muda; EAN diferente → a
  escolha humana vence (precedência de `canOverwriteEan`), o anterior vai para `eanCandidates` e
  `warnings` (`ean-anterior:<ean>:<fonte>`). Na próxima lista com esse EAN,
  `FlyerEanResolutionService` encontra a foto pelo `metadata->>'ean'` antes da busca por nome.
  EAN com dígito verificador inválido → 422 `EAN_INVALID`.
- **Nome escolhido antes (`metadata.aliases`):** a mesma escolha grava o nome do produto como veio
  na lista (`{ name, key, chosenAt }`, chave = `productAliasKey`: maiúsculas, sem acento/pontuação,
  quantidade mantida; teto de 50 por imagem, o mais antigo sai). Um nome pode apontar para VÁRIAS
  fotos. Na próxima lista, `FlyerEanResolutionService` consulta os aliases (índice GIN
  `idx_gallery_images_aliases`, criado no boot) antes da busca por nome com IA: as fotos entram fixas
  no pool do match-v2 (`pinnedImageIds` → `includeIds` da busca vetorial) para ter score real; uma foto
  só → match direto com o motivo `nome escolhido antes` e as parecidas em `alternatives`; várias →
  `reviewCandidates` com as 3 melhores pelo score. EAN resolvido tem precedência. `aliasStatus[]` na
  resposta lista o que foi resolvido assim.
- **Cliente que escolheu a foto:** a mesma escolha, com o `clientId` do encarte, marca a imagem como
  preferida do cliente em `client_preferred_images` (não em `metadata`: é a tabela que o matching,
  a resolução por EAN/nome e a tela da Galeria já leem). Efeito nas próximas buscas desse cliente:
  bônus na porcentagem (`PREFERENCE_SCORE_BUMP` + `AI_CLIENT_IMAGE_PREF_BOOST`), motivo
  `preferida do cliente`, e desempate (preferida plausível é aplicada direto; nas fotos por EAN e por
  nome ela vem primeiro).
- **Feature 13 — cliente como tag:** `clientId` in the list query filters by client tag
  (`'none'` = images with no client). Uses `EXISTS` (not JOIN) so an image tagged for several
  clients isn't duplicated and the fuzzy-search ranking is untouched. Folder (storage) and
  client (curation) are **orthogonal axes** — an image lives in one folder but can serve N clients.
- `folderId = 'none'` in query filters images with no folder (root images).
- `folderId = null` in move operation moves images to root.
- Deleting a folder sets all its images' `folderId = NULL` (does not delete images).
- Supports bulk delete (`/delete-many`) and bulk move (`/move`).
- `imageCount` on folders is computed via SQL COUNT, not stored.
- Search by filename LIKE.

---

### dashboard

**Endpoints** (prefix: `/v1/dashboard`)

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| GET | `/stats` | JWT | Returns counts + monthly/weekly flyer stats |
| GET | `/recent` | JWT | Query: `limit` (default 5) |

**`/stats` response:** `{ totalFlyers, totalClients, totalProducts, totalTemplates, recentFlyers (last 7 days), flyersThisMonth }`.

**`/recent` response:** `{ recentFlyers[], recentTemplates[] }` — last N items ordered by `updatedAt DESC`. Flyers include client name.

Queries run in parallel via `Promise.all`.

---

### health

**Endpoints** (prefix: `/v1/health`)

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| GET | `/` | **No** (`@Public`) | DB connectivity check |

**Response:** `{ status: 'ok'|'error', timestamp, uptime, database, environment }`. Runs `SELECT 1` to verify DB.

---

### email

Internal service — not exposed via HTTP. Used by `auth` module only.

- `sendEmailVerification(email, name, token)` — link: `{BASE_URL}/v1/auth/verify-email?token=`, expires 24h.
- `sendPasswordReset(email, name, token)` — link: `{FRONTEND_URL}/auth?token=`, expires 1h.

SMTP configured via `MAIL_HOST`, `MAIL_PORT`, `MAIL_USER`, `MAIL_PASS`, `MAIL_FROM`. Default transport: mailtrap on port 587.

---

### uploads

**Endpoints** (prefix: `/v1/uploads`)

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| POST | `/` | JWT | multipart/form-data — `file`, `folder?` (enum) |

`UploadFolder` enum: `products`, `logos`, `templates`, `general`, `fonts`, `avatars`, `thumbnails`. Default: `general`.

This is the **generic upload endpoint** and also the **shared internal service** used by all other modules. `UploadsService.saveFile()` handles directory creation, unique filename generation, and returns the CDN URL.

---

### flyer-builder-v2

Persistence for the **V2 canvas builder** documents (the newer editor used by `/editor-v2`
and the social media flow on the frontend).

**Endpoints** (prefix: `/v1/flyer-builder-v2`)

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| POST | `/` | JWT | Create document |
| GET | `/` | JWT | List documents |
| GET | `/:id` | JWT | |
| PATCH | `/:id` | JWT | |
| DELETE | `/:id` | JWT | |

**Entity: `flyer-builder-v2-document`** — stores the full builder state as JSONB. Complements
the `flyers` table: a `flyers` row carries `kind` (`'flyer'` | `'social'`) to discriminate
print flyers from social art (the `kind` column was added by the `AddKindToFlyers` migration,
default `'flyer'` for backward compatibility).

---

### template-scenes (cena de template, Template Pro)

Estágio 3 do Template Pro (`docs/designs/template-pro.md`, change `add-template-scene-persistence`): o cliente cria uma
**cena** num formato de impressão, a primeira mensagem **gera o fundo** na proporção nativa do formato e cena, versões,
camadas e conversa sobrevivem entre sessões. Sempre registrado no app; a flag `TEMPLATE_SCENE_ENABLED` age nas rotas
(404 `TEMPLATE_SCENE_DISABLED`), na fila, no SSE e no GC. Workspace compartilhado (D-6): todo usuário logado vê todas as
cenas; `createdByUserId` só registra o autor. Contrato completo (payloads, erros): `openspec/changes/add-template-scene-persistence/design.md`.

**Endpoints** (prefix `/v1/template-scenes`, `JwtAuthGuard` + `TemplateSceneEnabledGuard`)

| Method | Path | Notes |
|--------|------|-------|
| POST | `/` | `{name, formatId}`; formato fora da lista de impressão (revista/folheto) → 422 `SCENE_FORMAT_UNSUPPORTED` |
| GET | `/` | lista leve paginada (`page`, `limit` ≤ 50), com autor e `previewUrl` da versão atual |
| GET | `/:id` | cena com `revision`, `zones`, versão atual, `activeVersion`, 50 últimas mensagens e versões com imagem paginadas (`versionsPage`), cada uma com `displayNumber`, `windowEndsAt` e `judge` |
| GET | `/:id/messages` | `before` (id da mensagem mais antiga que a tela tem) e `limit` (1 a 50): `{items, hasMore}`; cursor de outra cena 400, cena inexistente 404 |
| DELETE | `/:id` | exclusão lógica (204); cancela a versão em curso; repetir dá 404 |
| POST | `/:id/messages` | 202 `{messageId, versionId, jobId, revision}`, `jobId` nunca nulo: a mensagem e a versão `queued` (step `reading`) ficam gravadas e o Diretor lê depois; `confirmGlobal` e `replyToMessageId` são 400 |
| POST | `/:id/versions/:versionId/cancel` | 202; `cancelRequestedAt` na hora; estado final → 409 `VERSION_NOT_CANCELLABLE` |
| POST | `/:id/versions/:versionId/restore` | cria versão `restore`; master apagada → 410 `VERSION_NOT_RESTORABLE` |
| PATCH | `/:id/elements` | camadas à mão (versão `manual` aberta), sem chamar o modelo |
| POST | `/:id/assets/logo` | multipart `file` (PNG/JPEG/WebP ≤ 10 MB; `LOGO_INVALID`) |
| GET | `/:id/events` | SSE da cena (heartbeat 25 s, `retry: 5000`, sem replay) |
| POST | `/admin/gc` | `x-admin-token` (`ADMIN_API_TOKEN`), sem JWT; dispara a limpeza das cenas na hora |

**Regras que não se quebram**
- Toda mutação roda em transação com `SELECT ... FOR UPDATE` na cena (`SceneLockService`), confere `expectedRevision`
  (409 `REVISION_CONFLICT`) e cena ocupada (409 `SCENE_BUSY`); o índice parcial `UQ_tsv_scene_busy` garante uma só
  versão `queued`/`running` por cena. `revision` sobe em toda mutação (API) e quando o worker termina uma versão.
- Os arquivos ficam em `uploads/template-scenes/<sceneId>/<versionId>/`, gravados pelo próprio módulo (`SceneFilesService`),
  com URL **relativa**; a API nunca devolve entidade do ORM nem aceita URL de imagem (campo desconhecido é 400).
- Versões `manual`, `restore` e `set_layer` apontam para a master da origem sem copiar o arquivo.

**Geração (filas `template_scene.director` e `template_scene.turn`)**: `POST /messages` grava a mensagem, a versão `queued` no
step `reading` e o job do **Diretor** **na mesma transação** (`AnimationQueueService`, `retryLimit: 0`). O consumer só sobe com
`WORKER_ONLY=true` e a flag (`TemplateScenesModule.onModuleInit`: o Diretor com `TEMPLATE_SCENE_DIRECTOR_CONCURRENCY`, a imagem com
`TEMPLATE_SCENE_CONCURRENCY`). A imagem (`SceneTurnProcessor`, `SceneRedrawHandler`): `preparing` → `generating` ou `editing` →
`checking` (o juiz) → `saving` → `done`; grava a tentativa pendente em `metrics.calls` antes da chamada paga e o custo do
`usage` depois; nunca lança depois de chamada paga; confere o cancelamento antes de cada etapa e depois da chamada; job repetido
sai sem chamar o provedor. `SceneReconcilerService` (boot do worker e a cada minuto) marca `JOB_EXPIRED` a versão em leitura
presa há mais de 2 min e as demais, há mais de 16 min. Provedor atrás da porta
`SceneImageProvider` (`mock` padrão, `openai` só por `TEMPLATE_SCENE_IMAGE_PROVIDER=openai`). Falhas: `PROVIDER_QUOTA`
(terminal, log de erro com `sceneId` e `correlationId`), `PROVIDER_CONTENT_POLICY`, `PROVIDER_TIMEOUT`, `PROVIDER_ERROR`,
`JOB_EXPIRED`, `PAID_CALL_LIMIT`.

**Eventos**: o worker faz `pg_notify('template_scene_events', ...)` na transação da mudança, com `{sceneId, versionId,
kind, step, status, cancelRequested, costUsd, revision, at}`. O `AnimationEventsService` (que também sobe com a flag da
cena) roteia por cena em `subscribeScene(sceneId)`; a assinatura por usuário não muda. O front refaz `GET /:id` a cada evento.

**Retenção (D-12, PV-5, D-34)**: master e prévia ficam protegidas enquanto uma das `TEMPLATE_SCENE_MASTERS_KEPT` (20) versões
`ready` mais recentes (toda imagem conta, inclusive a que o juiz reprovou, D-20), uma versão aprovada ou a versão atual as referenciar (R22). `pruneSceneAssets` marca `expiresAt` no restore, no `PATCH` e
no processor; o GC (`UploadsGcService.runTemplateScenes` → `shared/gc/template-scenes-gc.runner.ts`, regras puras em
`template-scenes-gc.rules.ts`) trava a cena, grava `purgedAt` e só então apaga o arquivo, sempre sob
`/uploads/template-scenes/`. "Restaurável" = `purgedAt` nulo na master (derivado, sem marca por versão). O GC das cenas
roda no worker com a flag da cena, independente de animações e comerciais.

**Conversa (change `add-template-scene-conversation`)**: toda mensagem é lida pelo **Diretor** (`gpt-6-luna`, `/responses`, effort
`medium`, `store: false`, sem `previous_response_id`; `OpenAiDirectorService` no módulo `ai`, `SceneDirectorService` e a porta
`SCENE_DIRECTOR_CLIENT` na cena, com `MockSceneDirectorClient` por roteiro). O contexto vem do nosso banco
(`SceneDirectorContextService`: últimas 30 mensagens, lista do que o cliente pediu em `template_scenes.brief`, versões com o
`displayNumber`, a imagem atual em JPEG até 1.536 px com `detail: high`, a marcação, as camadas). A saída é um plano em schema fechado
(`domain/scene-director-schema.ts`); o **código valida e executa** (`SceneDirectorProcessor` e `SceneDirectorState`): schema, texto exato
de camada e pedidos (1 a 3), recusa de texto, preço e logo pintados (4), composição só do cliente, sem cortar frase (5), frases
proibidas (6), refazendo o Diretor no máximo uma vez. O efeito vem de uma tabela do código sobre `turn_kind`
(`domain/scene-director-decision.ts`): resposta e recusa terminam `rejected`; **camadas** (`domain/scene-director-layers.ts` e
`applyLayerActions`) e **desfazer** (`restoreInto`, `services/scene-undo.ts`) viram `ready` sob o lock, sem fila e sem imagem; **imagem**
grava o anúncio e o plano e publica `template_scene.turn` com `startAfterSeconds` (a **janela de 5 s**, só em pedido sem marcação,
reclamação e imagem nova; "Parar" é o `cancel` de uma versão `queued`). O custo do Diretor fica em `metrics.director`, fora de
`metrics.calls`. A versão de leitura nunca vira `running`.
- Imagem: `SceneRedrawHandler` redesenha **a imagem inteira** a partir da versão atual no tamanho nativo (`gpt-image-2.6-sunburst`,
  `/images/edits`), com `markup` (`domain/scene-markup.ts`: PNG transparente com o contorno `#e0241a`, multipart) quando o cliente marcou
  e sem ele quando não marcou; imagem nova é `/images/generations`. Sem recorte, máscara nem recomposição (D-22). Prompts montados pelo
  código (`processors/scene-prompt.ts`), com a regra de texto em todos os casos e a linha de itens em aberto fora da primeira imagem (D-38).
- Juiz (`SceneVisionService`): imagens inteiras antes e depois, mensagem, plano e itens em aberto; o resultado é **sempre aplicado**
  (D-26), o texto ao cliente sai do que ele conferiu (`afterImageReply`), e só o juiz fecha ou reabre um item da lista (G9).
- Aviso do redesenho (D-35) uma vez por cena, na primeira edição (`metrics.notice`). `GET /:id/messages` pagina o histórico.
- Camadas, marcação por pincel e laço, `markup`: a tabela de capacidades (`openai-image-capabilities`, com `markup` e preço do 2.6) e os
  códigos do modo `sceneCall` estão em `src/shared/` (DT-12). Morfologia e SSIM têm implementação única em `src/shared/image/` (DT-10),
  usada também por `commercials`. Contrato e provisórios (PV-56 em diante): `openspec/changes/add-template-scene-conversation/design.md`.

**Chamada de imagem (`OpenAiImageService`, opção `sceneCall`)**: quota terminal (uma requisição só), `maxRetries: 0` do SDK,
`withOpenAiRetry` para 5xx/429 de taxa/rede, timeout por requisição (`OPENAI_TIMEOUT_MS`), `.withResponse()` com `usage`,
`requestId` e `costUsd` (tabela `shared/image/openai-image-capabilities.ts`, preços do spike de 2026-11-02), tamanho e
qualidade (e fundo transparente e `markup`) validados pela tabela, **modelo pago sem preço conferido recusado antes da rede**
(`metrics.costUnknown` na resposta sem `usage`) e `correlationId` no log. `editImage` com `markup` envia a camada em multipart ao lado de `image`
(mesmo tamanho, até 16.777.216 px; `openai-image-markup.ts`). **Sem `sceneCall` nada muda** para os outros chamadores (teste de
snapshot do corpo em `openai-image.service.request-snapshot.spec.ts`); o 429 do caminho legado continua (DT-8).

**Testes**: unitários ao lado do código; specs com banco usam `describeIfSceneDb` (`testing/scene-test-db.ts`) e só rodam com
`TEMPLATE_SCENE_E2E_DB_URL` (banco `chroma_x_e2e`, porta 5434; nunca o `flyer_db`). E2E:
`TEMPLATE_SCENE_E2E_DB_URL=... npm run test -- template-scenes.controller.e2e` (estágio 3) e `template-scenes.conversation.e2e` (a conversa) (rodando todos os specs de banco juntos, use
`--runInBand`: o GC manual olha todas as cenas do banco). Ordem em desenvolvimento: `migration:run` ANTES do
`docker restart` (o `synchronize` cria o schema sozinho e a migration depois falharia).

---

### commercials (vídeos com personagem)

Módulo de vídeos curtos com um personagem falando ofertas (openspec `video-formatos-personagem`, ADR-001).
Liga com `MC_ENABLED=true`; consumers só no worker (`WORKER_ONLY=true`, processo PM2 `flyer-media-worker`).
Executor v2 (`pipelineVersion = 2`) para projetos novos com `MC_PIPELINE_V2=all`; v1 legado é congelado por projeto.

**Formatos** (`mc_projects.format`; os novos são admitidos por `MC_FORMATS`, 422 `FORMAT_NOT_ENABLED`):
- `scenes` (F3): comercial de cenas geradas (keyframe Gemini → Kling Avatar/ação → montagem 720p).
- `talking_art` (F1, "arte que fala"): arte estática do Chroma intocada + personagem falando numa janela ou no
  rosto do logo. Steps: `tts → talk` por fala, depois `compose_ffmpeg → finalize` (1080p).
- `offer_carousel` (F2, "ofertas em sequência"): 3–6 ofertas em cards animados sincronizados com a fala.
  Steps: `tts → talk` por fala, depois `render_remotion → finalize`. A composição vive no pacote
  `@chroma/video-templates` (repo `raphaelmonteiro/video-templates`, privado e sem registro: dependência git
  fixada por tag/commit em `package.json`, `dist/` versionado; o README do pacote tem as regras de versão).
  O backend importa `@chroma/video-templates/core` (puro: `layoutProducts`, schemas, `COMPOSITION_VERSION`);
  o worker faz o bundle de `src/index.ts` do pacote instalado ou do checkout em `MC_VIDEO_TEMPLATES_DIR`.
- `offer_piece` ("peça de ofertas", change `video-peca-configuravel`): o cliente monta a PEÇA no editor
  (fundo, produtos da galeria com preço de/por, logo, textos, rodapé, personagem em painel liso) — entidade
  `mc_pieces` (`kind` peça|modelo, `document` jsonb em frações do quadro, `revision` com 409), domínio puro em
  `domain/mc-piece.ts` (validação → `issues[]`, `pieceCanonicalHash`, `pieceSpokenOffers`, `pieceChangeScope`).
  `POST projects/from-piece` congela o descritor em `mc_projects.pieceSnapshot`; o roteiro é o do F2 (uma fala por
  item `spoken`, ≥ 1, validade do rodapé no fechamento). Steps: `tts → talk` por fala; projeto
  `render_still` (quadro parado PNG do formato — Remotion `OfferPieceStill` com o bundle/navegador do F2, mock em
  sharp; asset `piece_still`; não depende das cenas) `→ compose_ffmpeg` (quadro como arte, janela = rect do
  personagem, hash leva `pieceHash`) `→ finalize`. `PATCH projects/:id/piece` edita a peça depois do vídeo:
  mudança falada (ou cor do painel/modo) reescreve só as frases afetadas e volta ao roteiro; só visual → revisão
  `assembly_only` (ou grava no lugar antes da entrega). `POST projects/:id/duplicate` com `aspectRatio` clona a
  peça re-layoutada (`domain/mc-piece-relayout.ts`: grade volta a `auto` pelo `layoutProducts` do pacote, demais
  blocos mantêm as frações) numa `mc_pieces` nova e o projeto nasce em `storyboard_review` com os TTS reaproveitados.
  `PieceCanvas`/`layoutProducts`/`OfferPieceStill` vivem no pacote `@chroma/video-templates` (0.2.0).

**Kit do personagem**: origem `mascot` ou `logo` (logo vira `mascots.kind = 'logo'`), estilo `cartoon_2d |
3d_render | realistic`, rodadas de candidatos de mascotização (`mc_kit_candidates`), "usar o logo como está"
(`identityMode = logo_as_is`), gate de boca (visão; `MOUTH_NOT_LEGIBLE`, `MOUTH_GATE_UNDECIDED` +
`acceptMouthRisk`) e tile com alfa (recorte do rosto ≥ 60%, 1:1–3:4, ≥ 720 px; rosto mais largo que 5:3 fica
abaixo de 60% com `tile.faceBelowMinimum` e aviso, sem bloquear) usado pelos motores de fala.
**Custo do kit** (tarefa 2.6): cada chamada paga (descrição canônica gpt-4o pelos tokens do `usage`, referências e
candidatos pelo modelo efetivo, gate de boca, variante, traduções) vira evento `provider_cost` em `mc_events` e
soma em `mc_character_kits.providerCostUsd` (numeric(12,6)); o asset gerado leva `providerCostUsd`/`usage` no
metadata. `GET kits/:id` devolve `providerCostUsd` (número) e `providerCosts[]` (uma linha por chamada); a lista
devolve só a soma. Tarifas em `MC_KIT_PRICES` (padrão: Nano Banana Pro US$ 0,134 e 2.1 US$ 0,034 por imagem,
design.md). `GET admin/costs` segue só com os clipes dos projetos (kits fora). OpenAI sem crédito
(`insufficient_quota`, `billing_hard_limit_reached`) é `TerminalProviderError('quota')` sem re-tentativa
(`shared/providers/openai-errors.ts`, SDK com `maxRetries: 0`); 429 de taxa e 5xx seguem transitórios, respeitando o
`retry-after` (teto de 60 s, `PROVIDER_RETRY_AFTER_MAX_S`). Chamada Gemini cobrada sem resultado (200 sem imagem/texto)
vira linha de custo sem asset (`failure: 'no_output'`); o timeout de uma imagem do kit é terminal (`retryOnTimeout:
false`, sem nova requisição paga) e vira linha estimada (`failure: 'timed_out'`, `estimated: true`). Veredito de boca
pago e ilegível (`paid: true`) é reaproveitado no aceite de risco. Geração das referências idempotente por slot
(`requestHash` no metadata, descrição reaproveitada pelo id do job; re-entrega no mesmo worker espera a execução em
curso) e job com expiração de 1380 s (`mcKitReferencesExpireS`, pior caso com re-tentativas); rodada de candidatos
1560 s.

**Motor de fala** por tier (`economico | premium`) e origem: `MC_TALK_ENGINE_*` (Kling Avatar v2 std/pro,
OmniHuman 1.5, MiniMax H3 Max Lip Sync para `logo_as_is`), sempre audio-driven com o TTS ElevenLabs; o clipe é
conformado ao áudio (trim / tpad ≤ 300 ms / `clip_too_short` como qualidade) e o áudio do fornecedor é descartado.
O H3 Max (motor de logo) não tem campo de prompt e exige ≥ 5 s de áudio por chamada: fala medida abaixo de 5,15 s
vai com silêncio no fim até 5,15 s (decisão de 13/10/2026; os 150 ms de folga cobrem o `format.duration` do MP3, que
passa 30–70 ms do áudio decodificado — `MC_TALK_AUDIO_PAD_MARGIN_MS` e `planTalkAudioPadding` em
`domain/mc-talk-engines.ts`, também no provider mock). Sem a duração medida da fala, o submit num motor com mínimo
vira erro transiente antes de qualquer chamada (nunca TTS cru nem fallback de motor). O ingest apara o clipe à fala
com o TTS original e o custo conta os segundos enviados (uma fala de 2 s custa 5,15 s × US$ 0,08). Registro em
`inputSnapshot.audioPadding` e em `metadata.audioPadding` / `metadata.billedDurationMs` do clipe.

**Rotas** (prefixo `/v1/commercials`, JWT + `McEnabledGuard`):

| Grupo | Rotas |
|-------|-------|
| Config | `GET config` (formatos habilitados, render por formato, `characterCutout`, `talkContinuous`) |
| Kits | `POST/GET kits`, `GET kits/suggest?clientId=`, `GET kits/:id`, `POST kits/:id/body-tile`, `POST kits/:id/approve`, `POST kits/:id/regenerate-reference`, `PATCH kits/:id/sheet`, `POST kits/:id/sheet/translate`, `GET/POST kits/:id/candidates`, `POST kits/:id/candidates/:cid/choose`, `POST kits/:id/use-as-is`, `POST kits/:id/mouth-variant` |
| Vozes | `GET voices` (curadas + do próprio usuário), `POST voices/preview` |
| Arte | `POST art` (PNG/JPEG → asset `video_art` com aspecto inferido), `GET art/:id`, `GET art-sources/:kind/:id/offers` |
| Projetos | `POST projects`, `POST projects/from-art`, `GET projects[?sourceKind&sourceId]`, `GET projects/:id`, `POST projects/:id/duplicate`, `PATCH projects/:id/script`, `GET projects/:id/quote`, `POST projects/:id/prepare`, `POST projects/:id/scenes/:scene/reroll`, `POST projects/:id/approve-production`, `PATCH projects/:id/composition`, `POST projects/:id/approve-assembly`, `POST projects/:id/cancel` |
| F1 | `POST projects/:id/logo-box/detect`, `PUT projects/:id/logo-box`, `GET projects/:id/window-warnings` |
| F2 | `PATCH projects/:id/offers/:offerId`, `POST projects/:id/offers/:offerId/refresh` |
| Peças | `POST/GET pieces`, `GET/PATCH/DELETE pieces/:id` (PATCH com `expectedRevision` → 409 `REVISION_CONFLICT`), `POST pieces/:id/save-as-template`, `POST projects/from-piece`, `PATCH projects/:id/piece` |
| Admin (JWT + `x-admin-token`) | `POST admin/pause`, `GET admin/costs?month=YYYY-MM` |
| SSE | `GET events` |

**Personagem sem fundo e enquadramento de corpo** (change `video-mascote-transparente`; atrás de `MC_CHARACTER_CUTOUT`,
desligada por padrão: `GET config` → `characterCutout.enabled`; contrato completo no `design.md` da change). No bloco do
personagem da peça (`panel.shape: 'none'` + `framing: 'busto' | 'corpo'`, padrão `corpo` no sem fundo) e na arte que
fala em modo janela (`cutout`/`framing` em `from-art` e `PATCH projects/:id/script`; `logoFace`, `offer_carousel` e
`scenes` não têm o modo). Técnica A (P-16, US$ 0 a mais): o `talk` manda ao motor SÓ o tile (de corpo ou de busto)
achatado sobre a cor-chave do kit (`#00B140` ou `#0047BB`, escolhida por distância Lab às cores da identidade,
`domain/mc-cutout-key.ts`) e o `compose_ffmpeg` remove a chave de cada clipe (`domain/mc-cutout-graph.ts`: 4:4:4,
chromakey, despill, matte erodido e suavizado), encaixa o clipe inteiro na janela, colado embaixo, sem crossfade. O
**tile de corpo** (`kit.bodyTileAssetId`, migration `AddKitBodyTile`, `services/mc-kit-body-tile.service.ts`,
`domain/mc-body-tile.ts`) sai da identidade já aprovada só com sharp (alfa, margem, proporção 1:2–1:1, rosto ≥ 25% da
altura com encurtamento por baixo, avisos `IDENTITY_BUST_ONLY`/`BODY_TRIMMED_FOR_FACE`...), sob demanda por `POST
kits/:id/body-tile` (idempotente) ou no primeiro uso; o GC conhece a coluna. Modo e chave ficam congelados no roteiro
(`cutout`, `framing`, `cutoutKeyColor`) e entram nos hashes do `talk` e do `compose_ffmpeg` só quando em uso (todo hash
existente segue igual). Recusas (guard único `services/mc-cutout-guard.service.ts`, antes de gravar ou gastar): 400
`PIECE_CHARACTER_FIELD_INVALID`; 422 `CHARACTER_CUTOUT_DISABLED`, `CHARACTER_CUTOUT_LOGO_FACE`,
`CHARACTER_CUTOUT_FORMAT_NOT_SUPPORTED`, `CHARACTER_CUTOUT_KEY_UNSAFE` (sem fallback para outra cor) e os do tile de corpo
(`BODY_TILE_BORDER_NOT_UNIFORM`, `BODY_TILE_FIGURE_NOT_FOUND`, `TILE_FACE_NOT_FOUND`); peça de outro usuário nas rotas de
peça é 404. **Verificação do recorte** (local, sem API) no `compose_ffmpeg` ANTES dos passes
(`domain/mc-cutout-quality.ts`, `services/mc-cutout-quality.service.ts`): 8 quadros por clipe, cobertura do matte, cor e
estabilidade do fundo, resto da chave e halo na borda; reprovado ⇒ evento `cutout_rejected`, `TerminalProviderError
character_cutout_failed` (sem re-execução paga) e projeto em `needs_attention` com `availableActions`
(`gerar_fala_de_novo`, `usar_painel_liso`) e `cutoutIssue` em `GET projects/:id`; nada é gravado pela metade. A cotação
(`GET projects/:id/quote?phase=production`) devolve `talk` com as falas a regravar e o custo estimado (sem chamada paga);
`PATCH projects/:id/piece` devolve `pieceChange.recordingReasons`. A inspeção de visão sabe que o fundo-chave é intencional
e segue reprovando texto no corpo/roupa. O pacote `@chroma/video-templates` 0.3.0 não desenha painel no modo sem fundo
(`COMPOSITION_VERSION` 0.3.0; o pin do `package.json` sobe quando o desenvolvedor publicar o pacote). e2e mock:
`docs/evidence/mascot-quality/e2e/e2e-piece-cutout.mjs` (modos `stable` e `unstable`).

**Fala contínua** (change `video-fala-continua`; atrás de `MC_TALK_CONTINUOUS`, desligada por padrão; `GET config` →
`talkContinuous: { enabled, chunkMaxS: { economico, premium, logo } }`; contrato no `design.md` da change, D20). Em `offer_piece`
(todos os modos de painel) e `talking_art` o personagem fala várias frases numa **única tomada**: as falas consecutivas que cabem no
teto do trecho (`MC_TALK_CHUNK_MAX_S`, 10 s, sempre ≤ `maxChunkS` do motor; `domain/mc-talk-chunks.ts`, agrupamento guloso em ordem,
nenhuma fala dividida; fala sozinha acima do teto e ≤ `maxChunkS` vira trecho próprio) vão ao motor numa chamada só. O modo é
decidido na CRIAÇÃO do projeto (`options.talkMode` → `script.talkMode`, congelado; desligar a flag depois não muda o projeto,
`duplicate` relê a flag; projeto sem `talkMode` segue "uma fala, um clipe", mesmos hashes). Peças:
- **Step `talk` por trecho**, ancorado na cena LÍDER (sem migration): `inputSnapshot.chunk` (falas, instantes, cauda de junção de
  200 ms, `join`); as cenas seguidoras não têm step e viram `ready` na transação do ingest. O scheduler só libera o trecho com os TTS
  de todas as falas e o trecho anterior concluído (`domain/mc-scheduler.ts`); geração serial só ENTRE trechos. Hash:
  `TalkHashInputV2.chunk` só quando há mais de uma fala, cauda ou junção; prompt contínuo (`buildTalkPrompt(..., { continuous })`)
  troca a pose neutra no início/fim por "mesma pose do primeiro ao último quadro". Falha do trecho derruba todas as falas dele com o
  mesmo `errorCode` (catálogo `video-provider-failure-reason`; `chunk_join_frame_missing`, `audio_too_large`, `clip_identity_drift`).
- **Áudio**: o submit emenda os TTS (`processors/mc-talk-chunk-audio.ts`, `domain/mc-talk-chunk-ffmpeg.ts`) com os silêncios da
  timeline e o enchimento ÚNICO do motor (H3, 5,15 s, uma vez por trecho); uma fala solta sem cauda vai como está. O áudio final do
  vídeo continua sendo o TTS de cada fala nos instantes da timeline.
- **Junção** (P-20 (b)): o último quadro do trecho (`talk_join_frame`, PNG da última fatia) é a imagem enviada ao trecho seguinte;
  só o personagem vai ao motor. Quadro ausente = `chunk_join_frame_missing` (terminal, sem chamada paga). Inspeção do trecho com
  junção compara a identidade com o tile (`identity_drift`, classe `quality`).
- **Ingest** (`processors/mc-talk-chunk-ingest.ts`): um passe de ffmpeg conforma e fatia por fala (fronteiras de vídeo na grade de
  30 fps, `MC_CHUNK_TAIL_FRAMES`); uma inspeção por trecho; um asset `scene_synced` por cena (a líder leva custo/motor/`chunkSlices`).
- **Compose**: fatias encostadas, sem seguras, entrada atrasada nem fade em nenhuma fronteira (inclui entre trechos); timeline por
  `metadata.speechMs` (instantes de áudio e legendas = os de hoje); hash do compose leva `continuous` só quando em uso.
- **Regravação e cotação por trecho**: reroll de qualquer fala regrava o trecho inteiro e os seguintes (resposta `reroll: {
  chunkIndex, sceneIds, cascadeSceneIds }`); só a fala pedida cobra crédito (regra de reroll existente), a cascata e as irmãs não
  (Q2); a cotação (`GET quote`) lista `talk.chunks` (`new|edited|cascade|cached`, `chargedSceneIds`, custo de API) e tira da conta de
  créditos o que não cobra; `GET projects/:id` ganha `talkChunks`. Reroll sem `expectedRevision` inteiro é 400.
- **Poll**: `talk` de trecho espera `clamp(áudio × MC_TALK_POLL_PER_AUDIO_S, 15 min, 40 min)`; todo `talk` que estoura o tempo pede o
  cancelamento do job ao fal (`FalQueueClient.cancel`, melhor esforço).
- **P-33**: projeto em `generating` em que só restam falas em falha e nada anda volta a `needs_attention` com o motivo que resta
  (`McPipelineService.parkIfOnlyFailuresRemain`, nos dois modos).
- **Roteiro curto da peça** (P-21): `offer_piece` aceita de N (ofertas faladas) a N + 2 falas, abertura e fechamento opcionais; o
  papel vem do `productRef` (`domain/mc-piece-script-lines.ts`); 422 `SCRIPT_INVALID` com `issues[].code` `CAROUSEL_LINES_COUNT`,
  `CAROUSEL_LINE_KIND`...; `offer_carousel` e `scenes` não mudam.
- **Medida de "sem salto"** (`domain/mc-jump-metric.ts`): 1 − SSIM entre quadros vizinhos na janela do personagem; fronteira
  passa se ≤ `max(2 × P95, 0,01)`. e2e mock: `docs/evidence/mascot-quality/e2e/e2e-piece-continuous.mjs` (2 e 6 falas; o `talk`
  mock tem pose que muda com o tempo e recomeça em cada chamada, o que torna o salto do modo de hoje mensurável).

**Falhas de fornecedor e motivo em pt-BR** (change `video-worker-confiabilidade`; contrato no `design.md` da change):
`shared/providers/provider-errors.ts#classifyHttpRejection(status, corpo)` é a regra única (fal/Runway/HeyGen pela
`HttpProviderBase` e ElevenLabs pelo `postGeneration`): 5xx e 429 sem marcador são transitórios (4 execuções, espera
15/30/60 s, código `provider_transient` ao esgotar); 402 e 401/403/429 com marcador de saldo no corpo (`User is locked`,
`Exhausted balance`, `quota_exceeded`...) viram `TerminalProviderError('quota')`; 401/403 SEM marcador (chave inválida,
revogada ou expirada) viram `provider_auth` (classe `config`); 422 `content_policy`; os demais 4xx `provider_rejected`.
Corpo desconhecido nunca vira `quota`; corpos de referência em `shared/providers/__fixtures__/provider-error-bodies.ts`
(só o 403 de saldo do fal é capturado de produção). `quota` e `config` são terminais numa execução, estornam o step e
gravam `admin_alert` em `mc_events` **uma vez por projeto** (`services/mc-admin-alert.ts`, trava `FOR UPDATE` no projeto)
mais uma linha de log de nível `error` `ADMIN_ALERT <quota|config> projeto=<id> step=<id> tipo=<t> provider=<p>: <motivo>`
(é como o administrador lê o aviso nos logs do PM2: `pm2 logs flyer-media-worker | grep ADMIN_ALERT`; canal real é a
P-28); o canal SSE do cliente (`mc_admin_alert`) leva só `{ projectId }`, e o módulo NÃO é pausado (`mc_paused`).
O fallback de TTS não tenta `eleven_v3` com `quota`/`provider_auth`. O que o cliente vê vem do catálogo
`domain/mc-failure-messages.ts` (texto por `errorCode`, sem fornecedor/saldo/HTTP; cota e chave inválida mostram o texto
da P-27): `failStep`, a falha do roteiro (`script_failed`) e a montagem gravam esse texto em `errorMessage` do projeto e da
cena (a mensagem crua fica só em `mc_steps.errorMessage` e no evento), e `GET projects/:id` e `GET projects` recomputam
`errorMessage`/`errorAction` (`refazer | tentar_mais_tarde | ajustar_cena | null`) do `errorCode`, também em cenas e
steps (linhas antigas com texto cru em inglês saem em pt-BR; `character_cutout_failed` mantém o texto gravado). Código
novo de falha precisa de entrada no catálogo (`mc-failure-messages.spec.ts`).

**Render do F2 e do quadro da peça sem derrubar o worker** (change `corrigir-render-remotion-epipe`; contrato no `design.md`):
a morte do compositor ou do Chromium do Remotion durante o bundle, `openBrowser`, `selectComposition` ou `renderMedia`
(F2) e `renderStill` (quadro da peça) vira falha do step com o código `render_interrupted` (`McRenderInterruptedError` em
`domain/mc-error-classes.ts`; conversão em `services/mc-render-failure.ts`: `isProcessDeath`/`toRenderFailure`; falha de
conteúdo, `delayRender`, bundle e `RENDER_UNAVAILABLE` NÃO são remapeados). Classe `internal`: 2 execuções (espera 15 s),
depois `needs_attention` com o texto do catálogo ("A montagem do vídeo foi interrompida...", ação `refazer`) e,
esgotado o teto, **um `admin_alert` por projeto** e a linha `ADMIN_ALERT internal projeto=...` no log (`mcAlertsAdmin(classe,
código)`; só o render interrompido alerta entre os `internal`). O renderizador descarta o navegador em toda queda, zera o
cache no evento `closed`/`closed-silent` (o próximo render abre um novo) e tem uma vigia (`services/mc-render-watchdog.ts`):
se o Chromium morre e os quadros não avançam por 60 s o render é cancelado e interrompido (medido: o Remotion às vezes não
retoma e o render pendurava até `totalTimeoutMs`, ~14 min, com a fila `mc.render` presa). `src/worker.ts` instala
`installProcessErrorHandlers` (`src/shared/process/`): erro de pipe de processo filho (`EPIPE`, `ECONNRESET`, `spawn` que
falhou) COM render em andamento (`trackChildWork`) só é registrado e o worker segue; `unhandledRejection` comum é
registrada e o worker segue; `uncaughtException` desconhecida faz encerramento controlado (`app.close()` até
`WORKER_FATAL_GRACE_MS` = 10 s, depois `exit(1)`; o PM2 reinicia). Todo erro sai em log `error` com mensagem e pilha.
**F2 sem música própria no render**: `buildOfferCarouselProps` passa `music: { src: MC_NO_MUSIC_SRC, volume: 0 }` (WAV mudo em
data URI) em toda montagem; sem a chave, o merge raso do Remotion herdava a trilha de exemplo do `defaultProps` do pacote
(`fixtures/music-loop.wav`) e `null` o schema recusa. A trilha escolhida (`musicEnabled`) entra só no `finalize`. O hash
exato do `render_remotion` muda (props novas); o hash das entradas, não. Ambiente local: o `chroma_worker` e a stack `qa-wc`
precisam de `gcompat` (ou do link do loader `/lib/ld-linux-aarch64.so.1`) e de `NODE_OPTIONS=--dns-result-order=ipv4first`
para o Remotion rodar no Alpine (sem isso: `EPIPE` por compositor que não executa e `ECONNREFUSED ::1` no bundle).

**Convenção de erros**: forma de DTO → 400 pelo pipe global; regra de negócio → 422 `{code, message, details?}`
(ex.: `SPEECH_SENTENCE_TOO_LONG`, `SPEECH_DURATION_OUT_OF_RANGE`, `SPEECH_OVER_LENGTH`,
`SPEECH_ALIGNMENT_MISSING`, `RENDER_UNAVAILABLE`, `LOGO_BOX_REQUIRED`, `KIT_TILE_MISSING`); `details.actions`
lista o que a UI pode oferecer.

**Worker e preflight**: o worker publica no heartbeat o preflight de render por formato (ffmpeg, ffprobe,
fontes DejaVu; navegador para `offer_carousel` e `offer_piece`); `/v1/health` expõe `worker.render.formats`, e a
criação de projetos F1/F2/peça recusa com `RENDER_UNAVAILABLE` quando falta requisito do formato.

**e2e mock**: `docs/evidence/mascot-quality/e2e/run-e2e.sh` (raiz do monorepo) roda `e2e-v2.mjs` (cenas),
`e2e-logo.mjs` (kit de logo), `e2e-f1.mjs` (arte que fala) e `e2e-f2.mjs` (ofertas em sequência) contra a
stack `docker-compose.e2e.yml`, sem chamadas pagas. `e2e-worker-race.mjs` (corrida do `render_still` com os `talk` logo
depois de reiniciar o worker, com `UPLOAD_DEST` relativo) também roda no `run-e2e.sh`.

---

### ai

**The product's AI layer.** Orchestrates OpenAI, Pixabay and Replicate. Controller is
JWT-protected; gallery/embedding admin routes additionally require the `x-admin-token` header
matched against `ADMIN_API_TOKEN`. Chat-style template generation is **stateless** — the
frontend resends the full conversation history on every call.

**Endpoints** (prefix: `/v1/ai`)

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/spell-check` | JWT | Batch spell-check of product `name`/`observation`/`badgeText` (gpt-4o-mini) |
| POST | `/product-categorization` | JWT | Batch categorize products (gpt-4o-mini) |
| POST | `/flyer-assembly-plan` | JWT | Auto-assembly plan for a flyer |
| GET | `/image-search` | JWT | Search product images on Pixabay (term translated to EN) |
| POST | `/image-download` | JWT | Download a chosen image and save via UploadsService |
| POST | `/product-image-match` | JWT | Match a product to the best gallery image (vector similarity) |
| POST | `/product-image-candidates` | JWT | Return top-N gallery candidates for a product |
| POST | `/social-section-layout` | JWT | Auto-layout for a social art section (gpt-4o) |
| POST | `/template-generate` | JWT | Multi-turn assisted template generation (gpt-4o vision) |
| POST | `/template-element` | JWT | Assist a single template element |
| POST | `/template-image-generate` | JWT | Generate a template from an image |
| POST | `/template-layers-generate` | JWT | Generate a layered template |
| GET | `/gallery/embedding-stats` | `x-admin-token` | Count images with/without embedding |
| POST | `/gallery/backfill-embeddings` | `x-admin-token` | Backfill missing gallery embeddings |
| POST | `/product-image-match-v2` | JWT | Busca de imagens do encarte; produto com `ean` é resolvido pelo EAN (galeria → DotCompany) antes do nome |
| GET/POST | `/dotcompany/usage`, `/dotcompany/usage/refresh` | `x-admin-token` | Saldo e consumo DotCompany (hora/dia/mês), limites e bloqueios |
| GET | `/dotcompany/lookup/:ean` | `x-admin-token` | Consulta avulsa de 1 EAN (cache primeiro) |
| POST/GET | `/dotcompany/import-jobs[/:id[/items]]`, `/:id/pause`, `/:id/resume` | `x-admin-token` | Importação do cadastro de um cliente (CSV/XLSX com EAN) para a galeria |

**Services** (`src/modules/ai/`)

| Service | Role |
|---------|------|
| `ai.service` | Facade delegating to the specialized services below |
| `spell-check.service` | Spell-check in batches |
| `product-categorization.service` | Product categorization in batches |
| `flyer-assembly-plan.service` | Builds the flyer assembly plan |
| `pixabay.service` | Pixabay search + EN translation + download/save |
| `openai-image.service` | Image generate/edit wrapper — uses `options.model` when the caller passes one, otherwise the model of the mode (`imageModel` for `final`, `imagePreviewModel` for `preview`); no chained model fallback inside the service. The DALL-E fallback (`legacy` asset, `OPENAI_DALLE_FALLBACK_MODEL`) lives in the callers `template-generate.service.ts:274` and `template-element-assistant.service.ts:320`, enabled by `OPENAI_ENABLE_DALLE_FALLBACK`. `input_fidelity` only sent for `gpt-image-1.5`/`gpt-image-1-mini`; concurrency limit, retry/backoff, cost metrics |
| `template-generate.service` | Chat template generation; resolves `GENERATE: <prompt>` placeholders into generated images saved to the bucket |
| `template-element-assistant.service` | Per-element template assistant |
| `template-image-generator.service` / `template-layers-generator.service` | Template-from-image / layered template generation |
| `social-section-layout.service` | Social art section layout |
| `gallery-embedding.service` | Generates/stores `text-embedding-3-small` vectors in the `gallery_images.embedding` (pgvector) column; prepares the extension/column/index on boot |
| `product-categorization` / `product-image-match` | Map products to gallery imagery via vector search |

**pgvector notes**

- `gallery_images` entity is declared `{ synchronize: false }`; the `embedding vector` column
  and its index are managed by SQL (`postgres/initdb/init.sql` + the embedding service's boot
  setup), **not** by TypeORM.
- Similarity search uses `pgvector` (`toSql` from `pgvector/utils`).
- Embedding setup/backfill is gated by `AI_GALLERY_EMBEDDING_ENABLED`.

**External integrations summary**

| Provider | Used for | Env |
|----------|----------|-----|
| OpenAI | spell-check, categorization, assembly plan, template/vision generation, image gen/edit, embeddings | `OPENAI_API_KEY`, `OPENAI_*` |
| Pixabay | product image search | `PIXABAY_API_KEY` |
| Replicate | SAM image segmentation | `REPLICATE_API_TOKEN` |
| SMTP (nodemailer) | email verification / password reset (via `email` module); alertas de consumo DotCompany | `MAIL_*` |
| DotCompany | produto por EAN (nome, marca, foto) → fotos na galeria com EAN exato; créditos pré-pagos (R$ 0,04 por EAN encontrado) | `DOTCOMPANY_*` |
