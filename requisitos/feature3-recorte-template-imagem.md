# Feature 3 — Upload e Recorte de Template por Imagem

## Visão Geral

Permite que o usuário envie uma imagem de um template ou encarte existente (foto, scan, print) e recorte manualmente as três áreas — header, body e footer — gerando um novo template reutilizável na plataforma. As áreas recortadas viram as imagens de fundo de cada seção do template, mantendo total compatibilidade com o motor de templates existente e permitindo edição posterior no Template Builder.

Todo o processamento de recorte acontece no **frontend via Canvas API** — não há necessidade de novos endpoints no backend. A feature reutiliza integralmente os endpoints já existentes.

---

## Regras de Negócio

- O gatilho fica na página de Templates (`/templates`), como um botão "Criar a partir de imagem".
- O fluxo ocorre em um **modal de 3 passos**.
- Formatos de imagem aceitos: **JPG e PNG** apenas.
- O usuário seleciona o **formato do template** antes do recorte — isso define a proporção exibida na interface.
- O usuário define o **nome do template** no primeiro passo.
- O recorte é feito com **dois divisores horizontais arrastáveis** que delimitam as três áreas (header, body, footer).
- Os divisores são posicionados automaticamente nos valores padrão do sistema ao carregar a imagem, e o usuário ajusta se necessário.
- As três áreas recortadas viram as **imagens de fundo** (`background.type = 'image'`) de cada seção do template — não elementos editáveis.
- O template gerado é do tipo `"full"` e fica completamente editável no Template Builder após a criação.
- O template é salvo com `isDefault: false`.
- A imagem original **não é armazenada** — apenas as três imagens recortadas são enviadas ao backend.
- O thumbnail do template é gerado a partir da imagem original redimensionada (enviado após a criação do template).

---

## Dimensões por Formato

Cada formato define as dimensões de arte (`artWidth`, `artHeight`) e as alturas padrão de header e footer. Esses valores determinam:
- A **proporção da interface de recorte**
- A **posição inicial dos divisores**
- As **dimensões em cm** registradas no template (`widthCm`, `heightCm` de cada seção)

Os divisores iniciais são calculados como porcentagem da altura total da imagem:

```
divisorSuperior (%) = headerHeightCm / artHeightCm × 100
divisorInferior (%) = (artHeightCm - footerHeightCm) / artHeightCm × 100
```

**Exemplo para `folheto-20x27`** (artHeight ≈ 27.5cm, header = 6cm, footer = 4cm):
- Divisor superior: 6 / 27.5 ≈ **21.8%** do topo
- Divisor inferior: (27.5 - 4) / 27.5 ≈ **85.5%** do topo

O frontend deve ter uma constante com os formatos disponíveis e suas dimensões correspondentes, reutilizando os valores já definidos no sistema.

---

## Fluxo de Interação (Modal 3 Passos)

### Passo 1 — Configuração

- Campo: **Nome do template** (texto livre, obrigatório)
- Campo: **Formato** (dropdown com os tipos disponíveis: `folheto-20x27`, `revista-20x26.5`, `spread-55x55`, `instagram-feed`, etc.)
- Botão "Próximo" — habilitado apenas quando nome e formato estão preenchidos

### Passo 2 — Upload e Recorte

1. Área de upload (drag-and-drop ou clique para selecionar arquivo JPG/PNG).
2. Após seleção, a imagem é exibida dentro de um container com a **proporção exata do formato escolhido** (`artWidth / artHeight`).
3. Dois divisores horizontais arrastáveis são renderizados sobre a imagem:
   - **Divisor superior** — delimita o fim do header
   - **Divisor inferior** — delimita o início do footer
4. As três áreas são identificadas visualmente com rótulos semitransparentes: "Header", "Body", "Footer".
5. O usuário arrasta os divisores para ajustar as áreas conforme necessário.
6. O divisor superior não pode ultrapassar o divisor inferior (mínimo de 5% de distância entre eles).
7. Cada área deve ter no mínimo **5% da altura total** da imagem.
8. Botão "Próximo" disponível assim que a imagem for carregada.

### Passo 3 — Preview e Confirmação

1. Exibe as três áreas recortadas em preview (header, body, footer) lado a lado ou empilhadas.
2. Nome do template e formato selecionado são exibidos como resumo.
3. Botão "Voltar" permite retornar ao passo 2 para ajustar o recorte.
4. Botão "Criar Template" executa o salvamento.

---

## Processamento no Frontend (Canvas API)

### Etapa de Recorte

Ao confirmar no passo 3, o frontend executa:

1. Criar um elemento `<canvas>` oculto com as dimensões da imagem original (`naturalWidth`, `naturalHeight`).
2. Calcular as posições em pixels dos dois divisores:
   ```
   y1 = naturalHeight × (divisorSuperior / 100)
   y2 = naturalHeight × (divisorInferior / 100)
   ```
3. Gerar 3 recortes via `canvas.getContext('2d').drawImage()`:
   - **Header:** de `y=0` até `y=y1`
   - **Body:** de `y=y1` até `y=y2`
   - **Footer:** de `y=y2` até `y=naturalHeight`
4. Exportar cada canvas como `Blob` JPEG (qualidade 0.9) via `canvas.toBlob()`.
5. Gerar também o **thumbnail**: imagem original redimensionada para 800px de largura mantendo proporção, exportada como JPEG (qualidade 0.8).

### Etapa de Upload e Criação

Com os 4 Blobs gerados (header, body, footer, thumbnail), o frontend executa em sequência:

**1. Upload das 3 imagens recortadas** (paralelo):
```
POST /v1/uploads
Content-Type: multipart/form-data
file: <blob-header>
folder: templates
→ retorna { data: { url: "https://cdn.../uploads/templates/..." } }
```
Repetir para body e footer.

**2. Criar o template** com as URLs retornadas:
```
POST /v1/templates
Content-Type: application/json
{
  "name": "Nome definido pelo usuário",
  "type": "full",
  "configuration": {
    "header": {
      "id": "header",
      "name": "Header",
      "widthCm": <artWidth do formato>,
      "heightCm": <headerHeightCm do formato>,
      "background": {
        "type": "image",
        "imageUrl": "<url-header>",
        "imageSize": "cover",
        "imagePosition": "center",
        "imageOpacity": 1
      },
      "elements": []
    },
    "footer": {
      "id": "footer",
      "name": "Footer",
      "widthCm": <artWidth do formato>,
      "heightCm": <footerHeightCm do formato>,
      "background": {
        "type": "image",
        "imageUrl": "<url-footer>",
        "imageSize": "cover",
        "imagePosition": "center",
        "imageOpacity": 1
      },
      "elements": []
    },
    "bodyBackground": {
      "type": "image",
      "imageUrl": "<url-body>",
      "imageSize": "cover",
      "imagePosition": "center",
      "imageOpacity": 1
    }
  }
}
→ retorna { data: { id: "<template-id>", ... } }
```

**3. Upload do thumbnail** com o ID retornado:
```
POST /v1/templates/<template-id>/thumbnail
Content-Type: multipart/form-data
file: <blob-thumbnail>
```

**4. Fechar modal e atualizar lista de templates** via `templateStore.fetchTemplates()`.

---

## Endpoints Utilizados (todos já existentes)

| Endpoint | Uso |
|----------|-----|
| `POST /v1/uploads` | Upload das 3 imagens recortadas e do thumbnail |
| `POST /v1/templates` | Criação do template com a configuration montada |
| `POST /v1/templates/:id/thumbnail` | Upload do thumbnail após criação |

**Nenhum endpoint novo é necessário no backend.**

---

## Implementação Frontend

### Onde fica o botão

Na página `Templates.tsx`, ao lado do botão "Novo Template" existente. Texto: "Criar a partir de imagem". Ícone sugerido: `ImagePlus` (Lucide).

### Novo componente

```
src/components/template-builder/
└── ImageCropTemplateDialog.tsx   # Modal completo com os 3 passos
```

Internamente organizado em subcomponentes:
- `Step1Config` — nome + formato
- `Step2Crop` — upload + interface de recorte com divisores
- `Step3Preview` — preview das 3 áreas + confirmação
- `CropDivider` — componente do divisor arrastável (linha + handle)

### Interface de Recorte

A área de recorte é um container com `position: relative` e proporção fixa via `aspect-ratio` CSS (calculada a partir do formato selecionado). Dentro:

- `<img>` com a imagem carregada, `width: 100%`, `height: 100%`, `object-fit: fill`
- Dois elementos `<div>` absolutamente posicionados representando os divisores (linha horizontal + handle arrastável)
- Três overlays coloridos semitransparentes identificando as áreas

O drag dos divisores é implementado com eventos `onMouseDown` / `onMouseMove` / `onMouseUp` (e equivalentes touch) calculando o percentual em relação à altura do container.

### Estado do modal

```typescript
// Estado interno do ImageCropTemplateDialog
{
  step: 1 | 2 | 3,
  name: string,
  format: TemplateType | null,
  imageFile: File | null,
  imageDataUrl: string | null,         // para exibição
  dividerTop: number,                  // 0–100 (%)
  dividerBottom: number,               // 0–100 (%)
  isProcessing: boolean,               // durante upload/criação
}
```

---

## Dependências

### Backend
- Nenhuma — todos os endpoints já existem.

### Frontend
- Nenhuma dependência nova — Canvas API nativa + eventos de mouse/touch nativos do React.

---

## Casos de Borda

| Situação | Comportamento esperado |
|----------|----------------------|
| Arquivo não é JPG ou PNG | Exibir erro antes do upload: "Formato inválido. Use JPG ou PNG." |
| Imagem muito pequena (< 200px de altura) | Exibir aviso: "Imagem muito pequena. Recomendamos no mínimo 800px de altura." |
| Divisores colidindo (< 5% de distância) | O divisor arrastado para de se mover ao atingir o limite do outro |
| Falha no upload de uma das 3 imagens | Exibir erro e não prosseguir com a criação do template — nenhum dado parcial é salvo |
| Falha na criação do template | Exibir erro; as imagens já enviadas ficam no bucket como órfãs (aceitável, volume pequeno) |
| Imagem com proporção muito diferente do formato | A imagem é exibida com `object-fit: fill` (esticada) — o usuário vê o resultado real e decide se quer continuar |
| Nome do template duplicado | O backend não bloqueia nomes duplicados em templates — o template é criado normalmente |
| Usuário fecha o modal no meio do processo | Estado é descartado; nenhuma chamada ao backend foi feita ainda (uploads só acontecem na confirmação final) |
