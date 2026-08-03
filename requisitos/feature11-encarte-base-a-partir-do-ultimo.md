# Feature 11 — Começar um encarte a partir do último do cliente

**Tipo:** documento técnico (tech spec)
**Público:** desenvolvimento
**Status:** implementado
**One-pager relacionado:** [onepager-encarte-base-e-imagens-por-cliente.md](onepager-encarte-base-e-imagens-por-cliente.md)

> **Implementação:**
> - Fix do `FlyersService.duplicate()` ([flyers.service.ts](../src/modules/flyers/flyers.service.ts)):
>   passa a copiar `kind`, `layout` e `customGridConfig` (o caminho REST `/flyers/:id/duplicate`).
> - Seletor **"partir do último"**: novo `StartFromRecentDialog`
>   ([StartFromRecentDialog.tsx](../../frontend/src/components/flyers/StartFromRecentDialog.tsx))
>   acionado por "Novo Encarte" (Flyers) e "Nova arte social" (SocialList). Oferece "começar
>   do zero" ou partir de um documento recente, filtrável por cliente; ao escolher, duplica
>   via `flyerBuilderV2Service.duplicate` (que copia o `document` V2 inteiro) e abre o editor.
> - Nota: o editor-v2 persiste em `flyer-builder-v2-document`; o `duplicate` desse fluxo já
>   copiava o documento completo (sem perda). O fix acima cobre o caminho legado `flyers`.

---

## 1. Contexto e objetivo

Hoje quem monta um encarte reaproveita a arte anterior "por cima" (fluxo manual fora do
sistema), o que gera erro humano (esquecer de trocar preço/nome/unidade/imagem).

**Objetivo:** dentro do próprio Studio, permitir iniciar um encarte novo **a partir de um
encarte já montado daquele cliente**, aproveitando layout/boxes/estrutura. O motor de cópia
já existe (`POST /flyers/:id/duplicate`); a feature é principalmente **UX + pequenos ajustes
no backend**.

## 2. O que já existe

- **Backend:** `FlyersService.duplicate()` em
  [flyers.service.ts:250](../src/modules/flyers/flyers.service.ts) copia `name` (novo),
  `clientId` e `configuration`, e cria com `status: 'draft'`.
- **Backend:** `GET /flyers` já aceita filtro `clientId` (e `search`, `startDate`, `endDate`).
- **Frontend:** `flyersService.duplicate(id, { name })` e `flyersService.list({ clientId })`
  já existem em [flyersService.ts](../../frontend/src/services/api/flyersService.ts).

## 3. Gap identificado (corrigir)

O `duplicate()` atual **não copia** três campos que o encarte de origem pode ter:

- `kind` (`'flyer'` | `'social'`) → uma cópia de uma arte social vira `'flyer'` (default),
  quebrando o tipo.
- `layout` (`'auto'` | `'custom'`)
- `customGridConfig` (jsonb)

**Ação:** incluir os três na cópia. Sem isso, "partir do último" corrompe encartes sociais e
perde a configuração de grid customizado.

## 4. Mudanças

### 4.1 Backend

**`FlyersService.duplicate()`** — copiar os campos faltantes:

```ts
const newFlyer = this.flyerRepository.create({
  name: duplicateDto.name,
  clientId: originalFlyer.clientId,
  configuration: originalFlyer.configuration,
  kind: originalFlyer.kind,                 // novo
  layout: originalFlyer.layout,             // novo
  customGridConfig: originalFlyer.customGridConfig, // novo
  status: 'draft',
});
```

Nenhuma migration necessária (colunas já existem).

**Endpoint auxiliar (opcional, recomendado):** um atalho para "últimos do cliente" sem o
front ter que paginar. Pode ser resolvido só com o `GET /flyers` existente:
`GET /flyers?clientId=<id>&limit=6&sort=updatedAt` (ordenar por `updatedAt DESC`). Se o
ordenador ainda não existir, adicionar suporte a `sort=updatedAt` no service de listagem.

### 4.2 Frontend

Fluxo de "novo encarte" (e "nova arte social"):

1. Ao iniciar uma montagem, se um cliente estiver selecionado, chamar
   `flyersService.list({ clientId, limit: 6 })` filtrando por `kind` correspondente
   (flyer vs social).
2. Renderizar os últimos encartes (thumbnail + nome + data) num seletor: **"Começar do zero"**
   ou **"Partir de um destes"**.
3. Ao escolher um, chamar `flyersService.duplicate(id, { name })` e abrir o editor no
   rascunho recém-criado.

Componentes prováveis: entrada em `pages/Flyers.tsx` / `pages/Social.tsx` e no início do
`flyer-builder-v2`. Reusar os cards de thumbnail já existentes na listagem.

### 4.3 Filtragem por `kind`

O seletor de "partir do último" deve mostrar **apenas encartes do mesmo tipo** da montagem
atual (`flyer` na tela de encartes, `social` na tela de social). O `GET /flyers` precisa
aceitar/filtrar por `kind` — verificar se já expõe esse filtro; se não, adicionar.

## 5. Contrato de API

Sem endpoints novos obrigatórios. Uso do existente:

```
GET /v1/flyers?clientId=<uuid>&kind=flyer&limit=6   → últimos do cliente (ordenar por updatedAt DESC)
POST /v1/flyers/:id/duplicate  { "name": "Encarte 28/07" }  → cria rascunho
```

## 6. Casos de borda

- **Cliente sem encartes anteriores:** seletor só mostra "Começar do zero".
- **Encarte de origem gigante (`configuration` até 10MB):** cópia é jsonb→jsonb, sem
  reprocessar; ok.
- **Origem sem cliente (`clientId` null):** ainda pode partir dela via listagem geral (sem
  filtro de cliente); a cópia mantém `clientId` null.
- **Nome duplicado:** default sugerido `"<nome origem> (cópia)"`, editável.

## 7. Testes

- Unit: `duplicate()` copia `kind`, `layout`, `customGridConfig`, `clientId`, `configuration`
  e força `status: 'draft'`.
- Unit: duplicar um `kind:'social'` resulta em `kind:'social'`.
- E2E: listar por `clientId`+`kind` retorna só os do cliente/tipo, ordem `updatedAt DESC`.

## 8. Faseamento

1. **Fix do `duplicate()`** (copiar os 3 campos) — pequeno, entrega valor sozinho.
2. **Seletor "partir do último"** no fluxo de nova montagem (front).
3. **Filtro/ordenação** (`kind`, `sort=updatedAt`) no `GET /flyers` se ainda faltar.

## 9. Fora de escopo

- Versionamento/histórico de encartes.
- "Template de encarte" reutilizável (isso é outra feature, ver templates de header/footer).
