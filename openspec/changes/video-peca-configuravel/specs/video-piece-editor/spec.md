# video-piece-editor

Montagem da peça do comercial pelo cliente: fundo, área de produtos com
auto-layout, logo, textos soltos, rodapé e modelos. A peça é o quadro inteiro
do vídeo e fica parada; só o personagem anima (ver `video-piece-character`).

## ADDED Requirements

### Requirement: Peça com formato e cliente

A peça DEVE nascer com um formato (`9:16` ou `4:5` neste lançamento) e um
cliente/loja. Logo e rodapé cadastrados no cliente DEVEM entrar preenchidos.
O cliente DEVE poder começar de uma peça em branco ou de um modelo salvo.

#### Scenario: Nova peça a partir do cliente

- **WHEN** o usuário cria uma peça escolhendo formato 9:16 e o cliente "Mercado Bom Preço"
- **THEN** a peça abre com a logo do cliente posicionada e o rodapé preenchido com endereço e telefone do cadastro

#### Scenario: Formato fora do lançamento

- **WHEN** o usuário pede uma peça em 16:9
- **THEN** o sistema recusa com `FORMAT_NOT_ENABLED` e lista os formatos disponíveis

### Requirement: Fundo da peça

O fundo DEVE aceitar três modos: cor sólida, degradê (duas cores e direção) e
imagem (galeria ou upload até 10 MB) com enquadramento, desfoque e
escurecimento em porcentagem. Trocar o modo NÃO DEVE mexer nos demais blocos.

#### Scenario: Fundo com imagem escurecida

- **WHEN** o usuário escolhe uma foto da galeria como fundo e aplica 40% de escurecimento
- **THEN** a prévia mostra a foto escurecida atrás de todos os blocos, sem alterar posição de produtos, logo, textos ou rodapé

### Requirement: Produtos do cadastro com foto da galeria

A área de produtos DEVE listar só produtos do cadastro. A foto de cada produto
DEVE vir da galeria (imagem vinculada ao produto). Nome, gramatura, preço
**de** (opcional), preço **por** e unidade DEVEM ser editáveis na peça sem
alterar o cadastro. A peça NUNCA DEVE exibir nome de arquivo ou EAN no lugar
do nome.

#### Scenario: Produto sem foto na galeria

- **WHEN** o usuário marca um produto que não tem imagem vinculada na galeria
- **THEN** o sistema pede a escolha de uma foto da galeria antes de colocar o produto na peça

#### Scenario: Produto sem nome legível

- **WHEN** o nome do produto está vazio ou é um código
- **THEN** o sistema pede o nome na hora e não aceita a peça para geração enquanto faltar

#### Scenario: Preço "de" só quando informado

- **WHEN** o produto tem só preço "por"
- **THEN** o selo mostra apenas o preço "por", sem traço nem espaço reservado

### Requirement: Auto-layout da área de produtos

Ao marcar ou desmarcar produtos, o sistema DEVE reorganizar a área de produtos
sozinho: distribuição para a quantidade (2, 3, 4, 6 e 8 itens) e o formato,
com tamanhos equilibrados e selo de preço legível. A área DEVE comportar até
12 produtos. O usuário DEVE poder, depois, arrastar para reordenar, ampliar um
produto como destaque, trocar o estilo do selo e ligar um fundo próprio da área
(cor, arredondamento, sombra). "Arrumar de novo" DEVE voltar à proposta
automática.

#### Scenario: Quarto produto entra

- **WHEN** a peça tem 3 produtos e o usuário marca o quarto
- **THEN** a área passa para a distribuição de 4 itens e os selos continuam legíveis na prévia

#### Scenario: Reordenar por arrasto

- **WHEN** o usuário arrasta o produto da posição 4 para a posição 1
- **THEN** a ordem muda na peça e na ordem das falas, sem mudar o tamanho dos demais

#### Scenario: Mais de 12 produtos

- **WHEN** o usuário tenta marcar o 13º produto
- **THEN** o sistema recusa e informa o limite de 12

### Requirement: Imagem única de produtos

Como alternativa à grade, a área DEVE aceitar uma foto montada pelo cliente
(galeria ou upload) e até 3 produtos marcados do cadastro para a fala citar.

#### Scenario: Foto única com dois produtos citados

- **WHEN** o usuário escolhe o modo imagem única, envia a foto e marca 2 produtos
- **THEN** a peça mostra a foto e a fala cita só esses 2 produtos

### Requirement: Logo, textos soltos e rodapé

A logo DEVE ser posicionável e redimensionável por arrasto. A peça DEVE aceitar
até 5 textos soltos com conteúdo, fonte (as cadastradas na conta), tamanho,
cor, alinhamento e posição. O rodapé DEVE poder ser ligado ou desligado, com
endereço, telefone/WhatsApp, validade (data inicial e final) e frase legal,
em estilo faixa ou pill.

#### Scenario: Validade no rodapé

- **WHEN** o usuário informa validade de 14/04 a 16/04/26
- **THEN** o rodapé mostra "Ofertas válidas de 14/04 até 16/04/26" seguido da frase legal escolhida

#### Scenario: Sexto texto solto

- **WHEN** o usuário tenta adicionar o sexto texto
- **THEN** o sistema recusa e informa o limite de 5

### Requirement: Guias e área segura

Todo bloco arrastado DEVE ter guias de alinhamento e DEVE ser avisado quando
sair da área segura do formato. Nada DEVE ser esticado ao trocar de formato:
os blocos são reorganizados pelo auto-layout e o usuário ajusta.

#### Scenario: Troca de 9:16 para 4:5

- **WHEN** o usuário duplica a peça em 4:5
- **THEN** fundo, produtos, logo, textos e rodapé são reposicionados sem distorção e a prévia mostra os avisos de área segura, se houver

### Requirement: Modelos salvos

A peça DEVE poder ser salva como modelo da conta, guardando fundo, posições,
estilos, textos e rodapé, sem os produtos. Abrir um modelo com outro cliente
DEVE trocar logo e rodapé pelo cliente escolhido.

#### Scenario: Reuso semanal

- **WHEN** o usuário abre o modelo "Ofertas da semana" com o mesmo cliente e marca 6 produtos novos
- **THEN** a peça sai com o mesmo visual e só produtos, preços e datas diferentes
