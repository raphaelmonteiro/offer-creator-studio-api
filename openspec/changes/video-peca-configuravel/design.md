# Design: peça de ofertas configurável

Estado: **rascunho de produto**. A visão do cliente e a usabilidade estão
fechadas (doc "Comercial de ofertas configurável", 22/10/2026). A solução
técnica (modelo de dados, rotas, executor de render) será preenchida depois da
discussão técnica. Este arquivo registra o que já está decidido e as
perguntas que a discussão precisa responder.

## Decisões de produto (fechadas em 22/10/2026)

| Tema | Decisão |
| --- | --- |
| Onde o cliente monta a peça | Editor novo, feito do zero para o vídeo, livre e com auto-layout. Não reaproveita o editor de encartes; se ficar bom, vai para o encarte depois. |
| Fotos dos produtos | Sempre da galeria (produtos já cadastrados). Foto única enviada pelo cliente fica como alternativa. |
| Personagem | Dentro da peça (recorte posicionado) e rosto do logo no lançamento; janela continua como está. |
| Produtos | Até 12 na tela, até 6 falados. |
| Legendas | Opcionais, desligadas por padrão. |
| Trilha | Opcional, paga. |
| Formatos | 9:16 e 4:5 no lançamento. |
| Modelos | Por conta, reutilizáveis entre clientes (logo e rodapé trocam pelo cliente). |
| Limites | Um personagem por peça; até 5 textos soltos; fontes da conta; imagem de fundo até 10 MB. |

## Princípios do editor

- **O sistema propõe, o cliente ajusta.** Marcar produtos já produz uma peça
  apresentável; cada ajuste é opcional.
- **Prévia fiel.** O que o editor desenha é exatamente o quadro do vídeo. Isso
  fixa uma regra para a solução técnica: o mesmo descritor da peça alimenta a
  prévia e o render.
- **Peça parada, personagem vivo.** O vídeo é a peça estática mais a região
  animada do personagem. Movimento de blocos não existe nesta change.
- **Nada herdado do editor de encartes.** Conceitos, telas e modelo de dados
  nascem aqui, pensados para a peça de vídeo.

## Auto-layout (comportamento, sem implementação)

- Entradas: formato do quadro, quantidade de produtos (2 a 12), presença de
  logo, textos e rodapé, modo do personagem e sua posição.
- Saída: posição e tamanho de cada produto e do selo de preço, de forma que
  nenhum texto fique abaixo do tamanho mínimo legível no formato de saída.
- Distribuições pré-definidas para 2, 3, 4, 6 e 8 itens; 5, 7 e 9 a 12 usam a
  distribuição seguinte com a última linha centralizada.
- Produto em destaque ocupa o espaço de dois.
- Qualquer edição manual marca a peça como "ajustada"; "arrumar de novo"
  descarta os ajustes e volta à proposta.

## Perguntas para a discussão técnica

1. Descritor da peça: um documento próprio (JSON versionado) por projeto, com
   referências a produto e imagem da galeria. Como fica o congelamento de
   preços e fotos na geração?
2. Render da peça parada: imagem única (rasterizada do descritor) sobre a qual
   o clipe do personagem é composto, ou composição por camadas no render?
   A regra "prévia = quadro final" favorece a primeira.
3. Personagem dentro da peça: o clipe do motor de fala é gerado sobre o tile
   com fundo liso; a composição precisa recortar o fundo e posicionar o clipe
   na região da peça. Qual a regra para o fundo do clipe quando o motor não
   preserva o alfa?
4. Rosto do logo: reaproveita a caixa do logo e o motor de logo da "arte que
   fala"?
5. Reaproveitamento das falas por hash entre duplicações de formato e
   regerações parciais: o mecanismo atual atende?
6. Modelos: onde vivem e como se relacionam com clientes.
7. Rotas e contratos: a definir aqui depois das respostas acima.
