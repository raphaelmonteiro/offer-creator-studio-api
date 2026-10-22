# video-piece-production

Da peça pronta ao vídeo entregue: prévia fiel, geração em fila com custo
informado, revisão, refazer por fala, entrega por canal e duplicação em outro
formato.

## ADDED Requirements

### Requirement: Prévia é o quadro final

A prévia estática da peça DEVE ser o quadro final do vídeo, na resolução de
saída, pixel a pixel, incluindo a silhueta do personagem. Diferença entre
prévia e quadro do vídeo é defeito.

#### Scenario: Comparação prévia × vídeo

- **WHEN** o vídeo é gerado
- **THEN** o primeiro quadro do vídeo, com o personagem em repouso, é idêntico à prévia salva na geração

### Requirement: Geração com custo informado

Antes de gerar, o sistema DEVE mostrar o custo estimado (fala, personagem por
segundo no tier escolhido) e o tempo previsto. A geração DEVE entrar em fila e
o progresso DEVE aparecer na mesma tela, com aviso ao terminar. A duração do
vídeo DEVE ser a da fala mais a folga de abertura e fechamento; o cliente não
escolhe tempo.

#### Scenario: Gerar

- **WHEN** o usuário confirma a geração de uma peça com 20 s de fala no tier econômico
- **THEN** a tela mostra o custo estimado antes da confirmação e, depois, o progresso por etapa (fala, personagem, composição)

### Requirement: Revisão e refazer por fala

Depois da entrega o usuário DEVE poder aprovar, ou refazer apenas a fala que
não gostou (nova gravação do personagem só daquela frase) mantendo as demais.

#### Scenario: Refazer a abertura

- **WHEN** o usuário pede para refazer só a abertura
- **THEN** o sistema grava de novo o personagem na abertura, reaproveita as outras falas e recompõe o vídeo

### Requirement: Entrega por canal e duplicação de formato

O vídeo DEVE ser entregue em perfil Instagram ou WhatsApp. "Duplicar em outro
formato" DEVE criar um projeto novo com a mesma peça reorganizada pelo
auto-layout, reaproveitando as falas já gravadas.

#### Scenario: Duplicar em 4:5

- **WHEN** o usuário duplica um vídeo 9:16 em 4:5
- **THEN** o novo projeto abre em revisão da peça em 4:5 com as falas já gravadas e só a composição por fazer

### Requirement: Legendas e trilha opcionais

Legendas DEVEM ser opcionais e desligadas por padrão nesta peça. Trilha DEVE
ser opcional, paga e escolhida antes da geração, como no formato atual.

#### Scenario: Legenda desligada

- **WHEN** o usuário gera sem ligar legendas
- **THEN** o vídeo não tem texto de legenda sobre a peça
