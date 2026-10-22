# video-piece-character

O personagem dentro da peça: um kit aprovado (`video-character-kit`) posicionado
na composição, ou o rosto do logo animado no próprio logo. Só o personagem
anima; o resto da peça fica parado.

## ADDED Requirements

### Requirement: Um personagem por peça, de um kit aprovado

A peça DEVE ter exatamente um personagem, vindo de um kit aprovado do mesmo
usuário. Kit em revisão, sem tile de fala ou de outro dono DEVE ser recusado
com `KIT_NOT_APPROVED` / `KIT_TILE_MISSING` / `FORBIDDEN`.

#### Scenario: Kit sem tile

- **WHEN** o usuário escolhe um kit aprovado antes do recorte de fala existir
- **THEN** o sistema recusa com `KIT_TILE_MISSING` e sugere criar um kit novo

### Requirement: Modo "dentro da peça"

No modo dentro da peça, o recorte do personagem (tile com alfa) DEVE ser
posicionado e dimensionado por arrasto, com lado menor de pelo menos 25% da
largura do quadro. A prévia DEVE mostrar a silhueta exata do que vai animar.
A região animada DEVE substituir só o recorte do personagem; nenhum outro
bloco da peça muda entre os quadros.

#### Scenario: Personagem sobre a logo

- **WHEN** o usuário posiciona o personagem sobrepondo a logo
- **THEN** a prévia avisa a sobreposição e mantém a logo acima ou abaixo conforme a ordem de camadas escolhida

#### Scenario: Personagem pequeno demais

- **WHEN** o usuário reduz o personagem abaixo de 25% da largura
- **THEN** o sistema trava no mínimo e explica que a boca precisa ser legível no vídeo

### Requirement: Modo "rosto do logo"

Com kit `logo_as_is`, o modo rosto do logo DEVE animar a boca no próprio logo
posicionado na peça. Sem caixa do logo confirmada, o sistema DEVE pedir a
marcação antes de gerar (`LOGO_BOX_REQUIRED`).

#### Scenario: Logo com rosto

- **WHEN** o usuário escolhe o kit do logo e o modo rosto do logo
- **THEN** a prévia destaca a caixa do logo que vai animar e o restante do logo fica parado no vídeo

### Requirement: Janela continua disponível

O modo janela (personagem numa moldura separada) DEVE continuar disponível
como está no formato atual, sem alteração de contrato.

#### Scenario: Escolha da janela

- **WHEN** o usuário escolhe o modo janela
- **THEN** a peça reserva a moldura e o personagem aparece nela com o fundo do kit
