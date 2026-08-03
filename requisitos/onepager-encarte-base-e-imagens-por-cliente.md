# One-pager — Duas melhorias na montagem de encartes

**Para:** cliente (visão de negócio)
**Data:** 27/07/2026
**Status:** proposta

---

## O problema, em uma frase

Na hora de montar um encarte novo, é comum reaproveitar algo do anterior — e é aí que
mora o erro humano: alguém esquece de trocar um preço, um nome, uma unidade ou uma
imagem. Retrabalho, arte errada indo pra rua, e tempo perdido conferindo.

As duas melhorias abaixo atacam exatamente isso: **reduzir o esquecimento na montagem.**

---

## Ideia 1 — Começar do último encarte pronto

### Como é hoje
Quem monta pega a última arte, abre em cima dela e vai trocando template, cores e itens.
Funciona, mas é manual: se esquecer de trocar uma "tranca", o erro passa.

### O que vai mudar pra você
Na hora de montar um encarte novo, o sistema vai **mostrar os últimos encartes daquele
cliente** ali na frente. Você escolhe um como ponto de partida e segue a montagem por
cima dele — layout, boxes, estrutura, tudo aproveitado.

### O que já temos
Boa parte disso já existe: o sistema **já sabe duplicar** um encarte pronto (copia o
layout e o cliente, e cria uma cópia nova pra editar). Ou seja, o motor está pronto.

### O que é novo
- Deixar essa opção **fácil e visível** no começo da montagem.
- Mostrar os **últimos encartes daquele cliente** pra escolher de onde partir.

### O que você ganha
- Menos montagem do zero.
- Padrão do cliente mantido sem precisar lembrar de tudo na mão.

---

## Ideia 2 — Imagens preferidas por cliente

### O problema real
O mesmo produto tem várias fotos no banco (ex.: várias fotos de contrafilé). Um cliente
gosta da foto 2, outro da foto 9. Hoje o sistema busca a imagem no **banco inteiro**, então
às vezes traz a "certa", às vezes a errada — e alguém tem que ficar trocando na mão.

### O que vai mudar pra você
Cada cliente vai ter **as fotos preferidas dele vinculadas ao seu cadastro**. Na montagem,
o sistema olha **primeiro** as fotos daquele cliente antes de procurar no banco geral.
Com menos opções e as opções certas, ele acerta muito mais.

### O que é novo
- Um **vínculo de verdade** entre o cliente e as fotos dele — não depende de nome de
  pasta digitado na mão (que é justamente onde dá erro).
- Na busca de imagem, **dar prioridade** às fotos do cliente. Se ele não tiver foto de um
  produto novo, o sistema ainda procura no banco geral (não fica sem imagem).
- Um jeito simples de **adicionar ou trocar** a foto preferida: quando o cliente pedir pra
  mudar, você joga a nova no cadastro dele e, dali pra frente, é essa que o sistema usa.

### O que você ganha
- A imagem certa, do jeito que o cliente gosta, sem ficar corrigindo.
- Menos erro de imagem trocada indo pra arte final.

---

## Resumo

| | Ideia 1 — Encarte base | Ideia 2 — Imagens por cliente |
|---|---|---|
| **Resolve** | Montar do zero / esquecer de trocar | Imagem errada / troca manual |
| **Já existe** | Duplicar encarte | Banco de imagens + busca por foto |
| **O que é novo** | Mostrar os últimos do cliente na montagem | Vincular fotos ao cliente e priorizar na busca |
| **Ganho pra você** | Menos retrabalho, padrão mantido | Foto certa automática, menos correção |

**As duas fazem sentido e dá pra fazer.** O próximo passo é detalhar como cada uma
funciona por dentro (documento técnico) e definir por qual começar.
