Sessões separadas por feature é o melhor caminho.

Essa sessão já tem bastante contexto acumulado. Misturar desenvolvimento de código aqui vai tornar a conversa pesada e aumentar o risco de eu perder contexto importante. Cada feature merece contexto limpo e focado.

Como dar a instrução no início de cada sessão:

Uma frase simples já é suficiente, porque os documentos de requisitos têm tudo:

"Implemente a Feature 1 do projeto. Os requisitos estão em backend-new/requisitos/feature1-validacao-ortografica.md. Comece pelo backend."

Ou se quiser separar backend e frontend:

"Implemente o backend da Feature 1. Requisitos em backend-new/requisitos/feature1-validacao-ortografica.md."

"Implemente o frontend da Feature 1. Requisitos em backend-new/requisitos/feature1-validacao-ortografica.md."

Sugestão de granularidade por sessão:

Sessão	Escopo
1	F1 — Backend (módulo ai, endpoint spell-check)
2	F1 — Frontend (botão + painel lateral)
3	F2 — Backend (image-search + image-download)
4	F2 — Frontend (botão no card + modal)
5	F3 — Frontend (modal completo + Canvas API)
6	F4 — Backend (template-generate + DALL-E 3)
7	F4 — Frontend (chat panel no Template Builder)
Antes de você ir, deixa eu salvar o contexto dessa sessão na memória para que as próximas sessões já comecem alinhadas.

Write project_ai_features.md
47 lines
---
name: AI Features Planning
description: Planejamento das 4 features de IA para o Offer Creator Studio — decisões acordadas e ordem de desenvolvimento
type: project
---

Foram planejadas 4 features de IA para a plataforma. Todos os documentos de requisitos estão em `backend-new/requisitos/`.

**Ordem de desenvolvimento acordada:** F1 → F2 → F3 → F4

**Feature 1 — Validação Ortográfica** (`feature1-validacao-ortografica.md`)
- GPT-4o-mini, batch de todos os produtos do encarte aberto
- Valida: `name`, `observation`, `badgeText`
- Persiste apenas no encarte (editorStore), não no catálogo
- Botão no EditorToolbar, painel lateral com sugestões uma por uma
- Cria módulo `ai` no backend (compartilhado pelas features 2 e 4)

**Feature 2 — Busca de Imagens** (`feature2-busca-imagens-produtos.md`)
- Pixabay API (gratuita, sem atribuição obrigatória)
- Gatilho: botão no card do produto no editor (só produtos sem imagem)
- 3 opções por produto, modal de seleção
- Checkbox "Salvar também no catálogo" no modal
- Imagem baixada pelo backend e salva no bucket via UploadsService

**Feature 3 — Recorte de Template** (`feature3-recorte-template-imagem.md`)
- Zero endpoints novos no backend — usa /v1/uploads e /v1/templates existentes
- Gatilho: botão "Criar a partir de imagem" na página /templates
- Modal 3 passos: (1) nome + formato, (2) upload + recorte com 2 divisores, (3) preview + confirmar
- Recorte feito no frontend via Canvas API
- Áreas recortadas viram backgrounds das seções do template

**Feature 4 — Geração Assistida** (`feature4-criacao-assistida-templates-ia.md`)
- GPT-4o (visão) + DALL-E 3 para imagens
- Chat multi-turno no painel lateral do Template Builder
- Frontend envia histórico completo a cada chamada (backend stateless)
- DALL-E 3 via placeholder: `"imageUrl": "GENERATE: prompt em inglês"`
- Backend resolve placeholders, salva imagens no bucket, retorna configuration
- Template carregado no canvas mas não salvo automaticamente — usuário salva pelo botão existente
- Max 3 imagens de referência por conversa, últimas 10 mensagens do histórico

**Variáveis de ambiente novas:**
- `OPENAI_API_KEY` (Features 1 e 4)
- `PIXABAY_API_KEY` (Feature 2)

**Why:** demanda do cliente para evolução da plataforma com IA assistiva
**How to apply:** ao iniciar desenvolvimento de qualquer feature, referenciar o MD correspondente em backend-new/requisitos/
Globpattern: "MEMORY.md"
No files found
Write MEMORY.md
4 lines
# Memory Index

- [AI Features Planning](project_ai_features.md) — 4 features de IA planejadas (validação ortográfica, busca de imagens, recorte de template, geração assistida), ordem F1→F2→F3→F4, requisitos em backend-new/requisitos/
Contexto salvo. Nas próximas sessões já vou saber exatamente onde estamos e o que foi decidido.

Quando quiser começar, abre uma sessão nova no projeto backend-new e manda: "Implemente o backend da Feature 1. Requisitos em requisitos/feature1-validacao-ortografica.md."