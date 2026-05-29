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

# Database migrations
npm run migration:generate -- src/migrations/MigrationName
npm run migration:run
npm run migration:revert
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
├── migrations/
└── modules/              # auth, clients, collaborators, dashboard, email,
                          # flyers, fonts, gallery, health, products, templates, uploads
```

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
- Duplicate copies `configuration`, `clientId`, sets `status: 'draft'`.
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
| GET | `/` | JWT | Query: `page, limit, search, folderId` |
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

**Entities:**
- `gallery_images`: `id`, `filename`, `url`, `thumbnailUrl` (nullable), `mimeType`, `size` (bigint), `folderId` (nullable FK, onDelete: SET NULL).
- `gallery_folders`: `id`, `name`, `color` (nullable).

**Business rules:**
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
