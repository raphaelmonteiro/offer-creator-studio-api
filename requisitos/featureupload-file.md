📋 Smart Import Feature Roadmap — Checklist Completo (Spec Profissional)

Objetivo macro

Transformar o importador atual de planilhas em um Smart Importer profissional, capaz de:

✅ aceitar múltiplos formatos reais de clientes
✅ validar dados automaticamente
✅ mostrar preview confiável
✅ criar seções automáticas no flyer
✅ associar imagens automaticamente
✅ reduzir trabalho manual drasticamente

⸻

🧭 Estado Atual

Já entregue ✅

Phase 1 — Import Engine
	•	Auto detect Type A / B / C
	•	Parser modular separado do componente
	•	Compatibilidade com formato atual
	•	Formato cliente “Jornal”
	•	Formato padronizado rico
	•	Extração básica de unidade
	•	npx tsc --noEmit

⸻

🚀 FASE 2 — Import Preview + Validation UX

PRIORIDADE ALTÍSSIMA

Objetivo

Dar confiança ao usuário antes de importar.

⸻

UX esperado

Ao subir arquivo:

Etapa 1 — leitura

Arquivo processado com sucesso
Formato detectado: Jornal Cliente

Etapa 2 — resumo

92 linhas lidas
87 produtos válidos
3 linhas ignoradas
2 alertas
6 categorias detectadas

Etapa 3 — preview grid

Nome	Preço	Unidade	Categoria	Status



⸻

Checklist técnico

Frontend
	•	Adicionar estado importAnalysis
	•	Modal preview antes do confirmar
	•	Tabela paginada / scroll
	•	Badge de formato detectado
	•	Totais e warnings

Validation Rules
	•	preço inválido
	•	nome vazio
	•	unidade desconhecida
	•	linha suspeita
	•	duplicados opcionais

UX
	•	botão Confirmar Importação
	•	botão Cancelar
	•	botão Baixar erros CSV (opcional)

⸻

🚀 FASE 3 — Categoria → Sections automáticas no Flyer

PRIORIDADE MUITO ALTA

Objetivo

Se planilha tiver:

MERCEARIA
AÇOUGUE
HORTIFRUTI

Criar automaticamente no editor:

Section: Mercearia
Section: Açougue
Section: Hortifruti


⸻

Resultado esperado

Ao importar:

Página atual:
[ MERCEARIA ]
produtos...

[ AÇOUGUE ]
produtos...


⸻

Checklist técnico

Parser
	•	Preservar categoria no metadata final

Editor Store
	•	Criar sections automaticamente
	•	Agrupar produtos por categoria
	•	Ordem preservada da planilha

UI
	•	Toggle no modal:

[x] Criar seções automaticamente


⸻

🚀 FASE 4 — Auto Match de Imagens

PRIORIDADE MUITO ALTA

(13.790 imagens)

⸻

Objetivo

Relacionar produtos importados com imagens existentes.

ARROZ CAMIL -> arroz-camil.jpg
COCA COLA 2L -> coca-cola-2l.png


⸻

Matching engine

Regras
	•	exact match
	•	normalized match
	•	fuzzy contains
	•	remove unidade/peso do nome
	•	ignore stopwords

⸻

UX

Produto	Imagem sugerida	Confiança


ARROZ CAMIL | arroz-camil.jpg | 98%


⸻

Checklist técnico
	•	indexar 13k imagens
	•	cache local
	•	lazy search
	•	score matcher

⸻

🚀 FASE 5 — Import Multi-page Automático

PRIORIDADE ALTA

Objetivo

Se exceder capacidade da página atual:

92 produtos
Grid atual suporta 24

Sistema sugere:

Criar 4 páginas automaticamente?


⸻

Regras
	•	detectar capacidade por template/grid
	•	distribuir produtos
	•	manter categorias juntas quando possível
	•	preservar ordem original

⸻

🚀 FASE 6 — Import Wizard Profissional

PRIORIDADE ALTA

Etapas do Wizard

Step 1

Upload arquivo

Step 2

Preview + validação

Step 3

Escolher opções

[x] Criar seções
[x] Buscar imagens
[x] Criar páginas extras

Step 4

Resultado final

⸻

🚀 FASE 7 — Histórico de Imports

PRIORIDADE MÉDIA

Objetivo

Guardar logs:

Importado:
arquivo abril.xlsx
92 produtos
6 categorias
03/04/2026


⸻

🚀 FASE 8 — Templates inteligentes por categoria

PRIORIDADE MÉDIA

Exemplo

Açougue:

template vermelho

Hortifruti:

template verde

Bebidas:

template azul

⸻

📊 Métricas de sucesso

Tempo atual manual:

2h organizar planilha

Meta:

10 min upload + ajustar

⸻

🧱 Arquitetura recomendada

Pastas

src/services/import/
  flyerSpreadsheetImporter.ts
  importValidator.ts
  importImageMatcher.ts
  importPaginationEngine.ts


⸻

📁 Componentes

FlyerProductImportDialog.tsx
ImportPreviewTable.tsx
ImportSummary.tsx
ImportWizard.tsx


⸻

🧪 Testes obrigatórios

Arquivos reais
	•	template atual
	•	jornal abril
	•	padronizado categorias
	•	arquivo vazio
	•	preço inválido
	•	nomes duplicados

⸻

🎯 Ordem ideal de execução

Sprint 1

Phase 2 Preview + Validation

Sprint 2

Phase 3 Sections automáticas

Sprint 3

Phase 4 Match imagens

Sprint 4

Phase 5 Multi-page automático

Sprint 5

Wizard final

⸻

💰 O que impressiona cliente mais rápido

Top 3 WOW Features

1.

Upload Excel bagunçado → sistema entende tudo

2.

Imagens entram automáticas

3.

92 produtos viram 4 páginas prontas

⸻

Minha recomendação sincera

Próximo passo AGORA:

FASE 2 Preview + Validation

Porque aumenta confiança imediata.

⸻

Se quiser, também posso te transformar isso em PROMPTS PRONTOS PARA CODEX por fase, um por um, igual fizemos no multipage.




🚀 Smart Import Roadmap — Prompts Prontos para Codex (por Fase)

Vou te entregar no mesmo estilo que funcionou no multi-page:
fases pequenas, seguras e profissionais.

⸻

🔥 FASE 2 — Preview + Validation UX

Objetivo

Usuário sobe planilha e vê exatamente o que será importado.

Prompt

Great.

Now implement ONLY phase 2 of Smart Import:

Improve flyer product import UX with validation + preview before confirming import.

Current entry point:
offer-creator-studio/src/components/editor/FlyerProductImportDialog.tsx

Requirements:

1. After reading spreadsheet, show import summary:

- detected format (Type A / Type B / Type C)
- total rows read
- valid products found
- ignored rows count
- warnings count
- categories detected count

2. Show preview table with columns:

- nome
- preco
- unidade
- categoria (if available)
- status

3. Highlight warnings:

- missing price
- suspicious row skipped
- unknown unit
- duplicate name (if easy)

4. Keep current import confirm flow.

5. Minimal UI changes only.
6. Use current UI library/components.
7. Do NOT redesign editor.

Implementation goals:
- trustworthy import UX
- clear feedback
- minimal safe changes

Run typecheck after changes.
Show changed files first.


⸻

🔥 FASE 3 — Categoria → Sections automáticas

Objetivo

Categorias da planilha viram seções no flyer.

Prompt

Great.

Now implement ONLY phase 3 of Smart Import:

Support optional automatic category sections inside flyer editor after import.

Requirements:

1. If imported rows contain categoria values, allow option:

[x] Create sections automatically from categories

2. Example:

MERCEARIA
AÇOUGUE
HORTIFRUTI

Should create grouped sections in the flyer.

3. Products must remain inside correct section.

4. Preserve category order from spreadsheet.

5. If no categories exist, keep current behavior.

6. Minimal changes only.
7. Do NOT redesign editor.

Implementation goals:
- productivity boost
- safe grouping
- preserve existing imports

Run typecheck after changes.
Show changed files first.


⸻

🔥 FASE 4 — Auto Match de Imagens

Objetivo

Relacionar produtos importados com imagens automaticamente.

Prompt

Great.

Now implement ONLY phase 4 of Smart Import:

Add automatic image matching for imported products.

Requirements:

1. When importing products, try to match existing image assets by product name.

2. Matching priority:

- exact match
- normalized match
- contains match
- fuzzy match if simple

3. Ignore units/weights in matching:

Examples:
ARROZ CAMIL 5KG -> arroz camil
COCA COLA 2L -> coca cola

4. Show confidence score if preview already exists.

5. If no image found, keep current behavior.

6. Do NOT slow down import heavily.
7. Minimal safe changes only.

Implementation goals:
- useful automatic matching
- high confidence first
- no regressions

Run typecheck after changes.
Show changed files first.


⸻

🔥 FASE 5 — Auto Pagination / Multi-page Import

Objetivo

Planilha grande cria múltiplas páginas automaticamente.

Prompt

Great.

Now implement ONLY phase 5 of Smart Import:

Support automatic multi-page flyer creation when imported products exceed current page capacity.

Requirements:

1. Detect current template/grid capacity.

2. If imported product count exceeds capacity:

Ask user:

Create additional pages automatically?

3. Distribute products across pages in correct order.

4. Preserve category grouping when possible.

5. Use existing multi-page flyer architecture.

6. Do NOT redesign editor UI.

Implementation goals:
- save manual work
- predictable pagination
- preserve order

Run typecheck after changes.
Show changed files first.


⸻

🔥 FASE 6 — Import Wizard Profissional

Objetivo

Transformar import em fluxo premium.

Prompt

Great.

Now implement ONLY phase 6 of Smart Import:

Convert import dialog into a step-by-step wizard.

Steps:

1. Upload spreadsheet
2. Analyze + preview
3. Import options:
- create sections
- auto match images
- auto create pages
4. Confirm import

Requirements:

- keep current logic
- improve UX only
- use existing UI components
- minimal safe refactor

Implementation goals:
- premium user experience
- clear workflow
- scalable future features

Run typecheck after changes.
Show changed files first.


⸻

🔥 FASE 7 — Histórico de Imports

Prompt

Implement import history inside frontend:

Track:
- file name
- date
- rows imported
- format detected
- warnings count

Minimal local persistence is acceptable first.


⸻

🔥 Ordem recomendada REAL

Agora faça:

1️⃣ Fase 2 Preview

Depois:

2️⃣ Fase 3 Sections

Depois:

3️⃣ Fase 4 Imagens

Depois:

4️⃣ Fase 5 Multi-page import

⸻

🎯 Minha recomendação sincera

Se quer impressionar cliente rápido:

Faça nessa ordem:
	1.	Preview
	2.	Auto imagens
	3.	Auto pages

⸻

🧠 Dica profissional

Sempre use:

Medium

Para UI

High

Para parser / multi-page / image matching

⸻

🚀 Se quiser, próximo nível:

Posso também te montar PROMPTS ESPECÍFICOS para o seu cliente de supermercado, tipo:
	•	Açougue import flow
	•	Hortifruti import flow
	•	Promoções 2 preços (de/por)
	•	Encartes sazonais (Páscoa / Natal)
	•	Jornal 27x40 profissional

Isso pode gerar MUITO valor comercial.