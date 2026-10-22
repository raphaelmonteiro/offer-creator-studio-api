# Change: Peça de ofertas configurável com personagem falando

## Why

Os comerciais de referência que o cliente quer (Nini, Piccin) são **uma peça de
encarte inteira, parada, em que só o personagem se mexe e fala**: fundo da marca,
produtos com preço de/por, logo, textos soltos e rodapé com endereço, WhatsApp e
validade. O personagem (mascote, logo com rosto ou o próprio dono) faz parte da
composição.

Hoje o produto gera três tipos de vídeo com personagem e nenhum deixa o cliente
montar a peça: o layout, as cores e a tipografia são do sistema; não há logo,
rodapé nem textos; o produto aparece um por vez com um preço só; o personagem
fica numa janela à parte; nomes de arquivo e EAN vazam para a tela. O vídeo de
21/10/2026 ("ofertas em sequência" do kit realista) mostrou essa distância
(doc "Comercial de ofertas configurável", 22/10/2026).

## What Changes

- **Editor de peça**, novo e próprio do vídeo (não reaproveita o editor de
  encartes): fundo (cor, degradê, imagem), área de produtos com **auto-layout**
  (o cliente escolhe os produtos e o sistema os distribui; depois edita tudo:
  ordem, destaque, selo de preço, fundo da área), logo, textos soltos, rodapé e
  modelos salvos. Fotos dos produtos sempre da galeria.
- **Personagem dentro da peça**: recorte do personagem posicionado e
  dimensionado na composição, ou o rosto do logo animado no próprio logo. A
  janela separada do formato atual continua existindo como está.
- **Fala a partir dos produtos citados** (até 6 falados, teto de 30 s), com
  preço por extenso, edição por frase e escuta antes de gerar.
- **Prévia = quadro final** (pixel a pixel), geração em fila com custo
  informado, revisão com "refazer só esta fala", refazer automático da fala
  quando um preço muda, entrega para Instagram e WhatsApp, duplicar em outro
  formato com a peça reorganizada.
- Formatos no lançamento: 9:16 e 4:5. Legendas opcionais (desligadas por
  padrão). Trilha opcional e paga, como hoje.

Fora de escopo nesta change: animação de cards/transições; montagem automática
de uma foto única a partir das fotos dos produtos (o cliente envia a foto
pronta); 1:1 e 16:9; mais de um personagem por peça; levar o editor para o
encarte.

## Impact

- Affected specs: novas capacidades `video-piece-editor`,
  `video-piece-character`, `video-piece-speech`, `video-piece-production`.
  `video-character-kit` (kit, boca, voz, tile) é reaproveitada sem mudança de
  contrato; `video-talking-art` e `video-offer-carousel` seguem como estão.
- Affected code: módulo `commercials` do backend (projeto, roteiro, produção,
  render) e frontend (nova rota de edição de peça e de projeto). Detalhe no
  `design.md` depois da discussão técnica.
- Dados: a peça vira um documento próprio do projeto (fonte de verdade do
  quadro), com referência a produtos e imagens da galeria; modelos salvos por
  conta.
- Custo por vídeo: fala (TTS) + personagem (motor do tier) + render local; a
  peça parada não gera custo de provider.
