import { classifySceneRequest, ClassifierInput } from './scene-operation.classifier';
import { fold } from '../../../shared/text/fold';
import {
  detectZone,
  mentionsIntegrate,
  mentionsMove,
  mentionsRemove,
  mentionsResize,
  sideIn,
} from './scene-request-text';
import { parseText } from './scene-request-parse';

const LOGO_ASSET = '11111111-1111-4111-8111-111111111111';
const ready = (input: Omit<ClassifierInput, 'hasReadyVersion'>): ClassifierInput => ({
  hasReadyVersion: true,
  ...input,
});
const selected = (kind: 'logo' | 'text' | 'generated' | 'sun', content: string) =>
  classifySceneRequest(ready({ content, targetElement: { id: `${kind}-1`, kind } }));

describe('classifySceneRequest: só sinais estruturados, sem texto livre (D-19)', () => {
  it('sem versão pronta é sempre geração, mesmo com anexo ou elemento selecionado', () => {
    for (const extra of [{}, { attachments: [{ assetId: LOGO_ASSET }] }]) {
      expect(
        classifySceneRequest({ hasReadyVersion: false, content: 'campo verde com sol', ...extra }),
      ).toEqual({ operation: 'generate' });
    }
  });

  it('anexo de logo: posição pelas regras curtas, e o texto entre aspas junto', () => {
    expect(
      classifySceneRequest(
        ready({
          content:
            'coloca a logo à esquerda no cabeçalho e escreve "Ofertas da semana" embaixo dela',
          attachments: [{ assetId: LOGO_ASSET }],
        }),
      ),
    ).toEqual({
      operation: 'set_layer',
      actions: [
        { type: 'add_logo', assetId: LOGO_ASSET, side: 'left', zone: 'header' },
        { type: 'set_text', text: 'Ofertas da semana', placement: 'below-logo', replace: false },
      ],
    });
    expect(
      classifySceneRequest(
        ready({
          content: 'coloca a logo à direita no rodapé',
          attachments: [{ assetId: LOGO_ASSET }],
        }),
      ),
    ).toMatchObject({ actions: [{ type: 'add_logo', side: 'right', zone: 'footer' }] });
    expect(
      classifySceneRequest(
        ready({ content: 'coloca a logo', attachments: [{ assetId: LOGO_ASSET }] }),
      ),
    ).toMatchObject({ actions: [{ type: 'add_logo', side: 'left', zone: 'header' }] });
  });

  it('elemento selecionado: mover, redimensionar e tirar são camada', () => {
    expect(selected('logo', 'passa para a direita')).toEqual({
      operation: 'set_layer',
      actions: [{ type: 'move', target: { elementId: 'logo-1' }, side: 'right' }],
    });
    expect(selected('text', 'aumenta')).toMatchObject({
      actions: [{ type: 'resize', direction: 'bigger' }],
    });
    expect(selected('logo', 'tira')).toMatchObject({ actions: [{ type: 'remove' }] });
    expect(selected('generated', 'move para a esquerda')).toMatchObject({
      actions: [{ type: 'move', side: 'left' }],
    });
  });

  it('elemento selecionado: pedido visual vale só para a camada gerada', () => {
    expect(selected('generated', 'deixa mais colorido')).toEqual({
      operation: 'local_edit',
      target: { kind: 'element', elementId: 'generated-1' },
      instruction: 'deixa mais colorido',
      remove: false,
    });
    expect(selected('logo', 'deixa mais azul')).toEqual({
      operation: 'needs_region',
      reason: 'layer_visual',
    });
    expect(selected('text', 'deixa mais azul')).toMatchObject({ reason: 'layer_visual' });
  });

  it.each([
    'integra ao fundo',
    'integre ao fundo',
    'integrar',
    'incorpora',
    'mescla com o fundo',
    'funde',
  ])('elemento gerado selecionado, "%s": integra (formas do verbo, R28)', (content) => {
    expect(selected('generated', content)).toMatchObject({
      operation: 'local_edit',
      integrate: true,
      target: { kind: 'element' },
    });
  });

  it('"integral" não é integrar (R28), e integrar numa logo selecionada pede a área', () => {
    expect(mentionsIntegrate(fold('troca por arroz integral'))).toBe(false);
    expect(selected('generated', 'deixa o pão integral')).not.toHaveProperty('integrate');
    expect(selected('logo', 'integra ao fundo')).toMatchObject({ reason: 'layer_visual' });
  });

  it('o resto depende do texto: devolve null, e o modelo decide', () => {
    for (const content of [
      'deixa tudo mais quente',
      'remove os ovos',
      'escreve "Oi"',
      'gere outra imagem',
      'passa a logo para a direita',
    ]) {
      expect(classifySceneRequest(ready({ content }))).toBeNull();
    }
  });

  it('o anexo vence o elemento selecionado', () => {
    const result = classifySceneRequest(
      ready({
        content: 'coloca isso',
        attachments: [{ assetId: LOGO_ASSET }],
        targetElement: { id: 'e', kind: 'generated' },
      }),
    );
    expect(result).toMatchObject({ operation: 'set_layer' });
  });
});

describe('Texto exato com elemento selecionado (PV-50, correção 6)', () => {
  it('generated e logo selecionados: cria um texto novo, sem modelo', () => {
    for (const kind of ['generated', 'logo'] as const) {
      const result = selected(kind, 'escreve "Feliz Páscoa"');
      expect(result).toEqual({
        operation: 'set_layer',
        actions: [{ type: 'set_text', text: 'Feliz Páscoa', placement: 'none', replace: false }],
      });
    }
  });

  it('texto selecionado: troca esse texto', () => {
    expect(selected('text', 'escreve "Feliz Páscoa"')).toEqual({
      operation: 'set_layer',
      actions: [
        {
          type: 'set_text',
          text: 'Feliz Páscoa',
          placement: 'none',
          replace: true,
          elementId: 'text-1',
        },
      ],
    });
  });

  it('sem seleção devolve null, e o anexo ainda vem primeiro', () => {
    expect(classifySceneRequest(ready({ content: 'escreve "Oi"' }))).toBeNull();
    const withLogo = classifySceneRequest(
      ready({
        content: 'escreve "Oi"',
        attachments: [{ assetId: LOGO_ASSET }],
        targetElement: { id: 'e', kind: 'generated' },
      }),
    );
    expect(withLogo).toMatchObject({ actions: [{ type: 'add_logo' }, { type: 'set_text' }] });
  });

  it('elemento selecionado sem texto exato segue a regra do elemento', () => {
    expect(selected('generated', 'deixa mais rústico')).toMatchObject({ operation: 'local_edit' });
  });
});

describe('palavras da lista curta que fica no código', () => {
  it('"remover" não é "mover" (palavra inteira)', () => {
    expect(mentionsMove(fold('remover o sol'))).toBe(false);
    expect(mentionsMove(fold('mover o sol'))).toBe(true);
    expect(mentionsMove(fold('removendo a nuvem'))).toBe(false);
    expect(mentionsRemove(fold('removendo a nuvem'))).toBe(true);
  });

  it('redimensionar e lado', () => {
    expect(mentionsResize(fold('aumenta'))).toBe('bigger');
    expect(mentionsResize(fold('deixa menor'))).toBe('smaller');
    expect(mentionsResize(fold('deixa azul'))).toBeNull();
    expect(sideIn(fold('para a esquerda'))).toBe('left');
    expect(sideIn(fold('troca de lado'))).toBe('toggle');
  });

  it('dobra acentos sem mudar o comprimento', () => {
    expect(fold('Cabeçalho À ESQUERDA')).toBe('cabecalho a esquerda');
    expect(fold('ação').length).toBe('ação'.length);
  });

  it('zonas e sinônimos (posição da logo)', () => {
    expect(detectZone('no cabeçalho')).toBe('header');
    expect(detectZone('lá no TOPO')).toBe('header');
    expect(detectZone('no miolo')).toBe('body');
    expect(detectZone('no rodapé')).toBe('footer');
    expect(detectZone('na base')).toBe('footer');
    expect(detectZone('o sol')).toBeNull();
  });

  it('texto entre aspas aceita aspas curvas e posição em cima', () => {
    expect(parseText('escreve “Hortifruti” em cima')).toMatchObject({
      text: 'Hortifruti',
      placement: 'top',
    });
    expect(parseText('sem texto nenhum')).toBeNull();
    expect(parseText('escreve ""')).toBeNull();
  });
});
