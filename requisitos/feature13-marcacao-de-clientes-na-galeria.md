# Feature 13 — Marcação de clientes na galeria (curadoria em lote)

**Tipo:** documento técnico (tech spec)
**Público:** desenvolvimento
**Status:** implementado
**Relacionado:** [feature12-imagens-preferidas-por-cliente.md](feature12-imagens-preferidas-por-cliente.md) ·
[onepager-encarte-base-e-imagens-por-cliente.md](onepager-encarte-base-e-imagens-por-cliente.md)

---

## 1. Problema

A Feature 12 entregou o vínculo cliente↔imagem e a priorização no matching, mas o único jeito
de cadastrar é **uma imagem por vez**, pela estrela na página de Clientes. Com centenas de
fotos por cliente, isso não escala.

Além disso, faltava responder: *e quando dois clientes usam a mesma foto?*

## 2. Solução: cliente como marcação (padrão DAM)

Trata-se o cliente como **tag de curadoria**, não como local de armazenamento:

- **Pasta** = onde o arquivo mora (organização) — uma imagem, uma pasta.
- **Cliente** = quem usa aquela foto (curadoria) — uma imagem, **N clientes**.

Os dois eixos são **ortogonais**: não competem e não exigem mover arquivo. É o modelo
tag-based de DAMs (Cloudinary, Bynder). O filtro "só as fotos do cliente X" vira uma
*smart collection* — pasta virtual montada pela marcação.

### Por que isso resolve

| Necessidade | Como resolve |
|---|---|
| Marcar centenas de fotos | Seleção múltipla (já existe na galeria) + ação em lote |
| Mesma foto para 2+ clientes | Natural — a tabela de vínculo já é N:N |
| Achar as fotos de um cliente | Filtro por cliente na galeria e no seletor do editor |
| Foto nova que o cliente mandou | Sobe na galeria e marca o cliente — 1 clique |

## 3. Modelo de dados — sem mudança

A tabela criada na Feature 12 **já é** exatamente o modelo necessário:

```sql
client_preferred_images (
  client_id  uuid → clients(id)        ON DELETE CASCADE,
  image_id   uuid → gallery_images(id) ON DELETE CASCADE,
  created_at timestamptz,
  PRIMARY KEY (client_id, image_id)
)
```

"Uma imagem tem N clientes" e "um cliente tem N imagens" já são verdade. **Nenhuma migration.**
Esta feature só adiciona **novas formas de ler e escrever** essa tabela.

## 4. Escopo

### 4.1 Backend

**a) Filtro por cliente na listagem** — `QueryGalleryDto` ganha `clientId?`.
`GalleryService.listImages` aplica `INNER JOIN client_preferred_images` quando presente.
Convive com `folderId` e `search` (eixos independentes; o ranking de busca fuzzy não muda).

**b) Clientes de cada imagem no retorno** — `listImages` inclui `clients: [{ id, name }]` por
imagem. Agregação feita **apenas sobre a página atual** (uma query extra com `IN (...)`),
nunca sobre a tabela inteira.

**c) Endpoints de marcação:**

| Método | Rota | Corpo | Uso |
|---|---|---|---|
| `PUT` | `/gallery/images/:imageId/clients` | `{ clientIds: string[] }` | Define os clientes de uma imagem (substitui) |
| `POST` | `/gallery/images/clients/bulk` | `{ imageIds[], clientIds[], mode }` | Lote: `add` \| `remove` \| `replace` |

`mode: 'add'` é idempotente (`ON CONFLICT DO NOTHING`). O `replace` em lote é destrutivo por
natureza — a UI só o expõe com confirmação.

**d) Reaproveitamento** — a lógica vive no `ClientPreferredImagesService` (Feature 12),
que ganha os métodos `setClientsForImage`, `bulkAssign` e `listClientsForImages`.

### 4.2 Frontend

| Item | Onde | Comportamento |
|---|---|---|
| Filtro por cliente | Topo da galeria, ao lado da busca | *Todos* · *Sem cliente* · lista de clientes |
| Ação em lote | Barra de seleção (junto de "Excluir (N)") | "Vincular a cliente(s)" → popover multi-select |
| Marcação individual | Card da imagem | Ação "Clientes" → popover com busca + checkboxes |
| Indicador visual | Card da imagem | Badge com contagem quando marcada |
| Filtro no editor | `GalleryPickerDialog` e `ProductImagePicker` | Toggle "Só deste cliente", ligado por padrão quando o encarte tem cliente |

> **Ponto de entrada único:** a galeria é o único lugar para ver e editar esses vínculos.
> O diálogo "Imagens preferidas" que existia na página de Clientes foi removido — ele só
> permitia marcar uma imagem por vez e não expressava bem o caso "mesma foto, vários
> clientes". Ver nota na [feature12](feature12-imagens-preferidas-por-cliente.md).

## 5. Fora de escopo (extensão futura)

**Favorita por produto** (`product_key`) + **captura na correção**: quando o operador trocar a
imagem de um produto num encarte, oferecer *"Salvar como preferida do [Cliente] para
[produto]?"*. Daria acerto determinístico por par (cliente, produto), construído a partir do
uso diário em vez de curadoria antecipada. Não bloqueia nada desta feature.

## 6. Riscos e mitigação

| Risco | Mitigação |
|---|---|
| Marcar 200 imagens no cliente errado | Lote usa `add` por padrão; confirmação exibindo a contagem |
| Filtro + busca fuzzy no mesmo query builder | Join entra como `andWhere`; ranking de busca intocado |
| Lista longa de clientes no popover | Campo de busca no popover |
| N+1 ao exibir clientes por imagem | Uma query agregada por página (`WHERE image_id IN (...)`) |

## 7. Testes

- Filtro por cliente retorna só imagens vinculadas; combinado com pasta e busca.
- `bulk` com `add` é idempotente; `remove` não afeta outros clientes; `replace` substitui só os
  clientes das imagens enviadas.
- Deletar imagem/cliente limpa o vínculo (CASCADE).
- Sem `clientId`, a listagem é idêntica à atual (regressão).

## 8. Faseamento — entregue

| # | Item | Onde |
|---|---|---|
| 1 | Filtro `clientId` + agregação de clientes na listagem | [gallery.service.ts](../src/modules/gallery/gallery.service.ts) |
| 1 | `setClientsForImage`, `bulkAssign`, `listClientsForImages` | [client-preferred-images.service.ts](../src/modules/gallery/client-preferred-images.service.ts) |
| 1 | Endpoints `PUT .../clients` e `POST .../clients/bulk` | [gallery.controller.ts](../src/modules/gallery/gallery.controller.ts) |
| 2 | Filtro por cliente + ação em lote na galeria | [Gallery.tsx](../../frontend/src/pages/Gallery.tsx) |
| 2 | Popover de seleção de clientes (individual e lote) | [ClientTagPopover.tsx](../../frontend/src/components/gallery/ClientTagPopover.tsx) |
| 3 | Marcação individual + badge no card | [Gallery.tsx](../../frontend/src/pages/Gallery.tsx) |
| 4 | Toggle "Só deste cliente" no seletor | [GalleryPickerDialog.tsx](../../frontend/src/components/shared/GalleryPickerDialog.tsx) |

**Notas de implementação:**
- O filtro usa `EXISTS` em vez de `JOIN`: uma imagem marcada para vários clientes não duplica
  linha, e o ranking da busca fuzzy fica intocado.
- A agregação de clientes roda em **uma query por página** (`WHERE image_id = ANY(...)`).
- O lote usa `mode: 'add'` na UI — nunca remove marcações existentes sem intenção explícita.
- `GalleryPickerDialog` e `ProductImagePicker` aceitam `clientId`; os 4 pontos do editor que
  abrem o picker de imagem de produto passam o cliente do encarte.
- O `ProductImagePicker` lê o `galleryStore` global, então passa `clientId` **sempre
  explicitamente** (`'all'` = sem filtro) para não herdar o filtro da tela de Galeria.
