# AGENTS.md

Guia curto para agentes neste repositório (`flyer-api`, branch `main`). Detalhes em `CLAUDE.md` deste repositório e no `CLAUDE.md` da raiz do workspace (`../CLAUDE.md`).

- Projeto: API do Chroma / Offer Creator Studio — NestJS 10 + TypeORM 0.3 + PostgreSQL 15 (pgvector), Node 18 no container, npm.
- Ambiente: `docker compose up -d` na raiz do workspace (API em `localhost:3001`, prefixo `/v1`, Swagger em `/api`; Postgres em `localhost:5432`). O container não recarrega: `docker restart chroma_backend` depois de alterar código; `docker compose build backend` depois de instalar dependência. No host, use o Node 22 x64 do nvm (`export PATH=$HOME/.nvm/versions/node/v22.11.0/bin:$PATH`).
- Gate: `npx eslint "{src,apps,libs,test}/**/*.ts"` (sem `--fix`), `npx tsc --noEmit -p tsconfig.json`, `npm test`, `npm run build`. Comandos e linha de base em [`docs/padroes.md`](docs/padroes.md).
- Banco: toda mudança de schema por migration em `src/migrations/` (`npm run migration:generate -- src/migrations/<Nome>`), testada com `migration:run` e `migration:revert`. Em dev o `synchronize` esconde a falta de migration; em produção só migration roda (`deploy.sh`). `gallery_images` tem `synchronize: false`.
- Fonte da verdade e pendências: `../docs/resumos/decisoes.md`. Demandas viram changes em `../openspec/changes/<id>/` (proposal, specs, design.md, tasks.md); o contrato de cada rota fica no `design.md` da change.
- Integrações pagas (OpenAI, DotCompany, Replicate, Gemini, Pixabay) ficam atrás de serviço com fake e flag; teste automatizado nunca as chama; nenhuma chamada real sem autorização do desenvolvedor.
- Não tocar em `.env`, `uploads/` de terceiros, `frontend/`, produção (VM, `deploy.sh`, push). Commits locais na `main`, só os arquivos da task, por caminho; nunca descartar trabalho não commitado do desenvolvedor.
- Padrões de código (camadas, contrato HTTP, migrations, limites, testes, armadilhas): [`docs/padroes.md`](docs/padroes.md). Leia antes de codar.
