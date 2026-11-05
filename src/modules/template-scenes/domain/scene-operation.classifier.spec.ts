import * as fs from 'fs';
import * as path from 'path';
import { ClassifierInput, classifySceneRequest } from './scene-operation.classifier';
import {
  additionSubject,
  citesImageItem,
  detectZone,
  fold,
  mentionsMove,
  parseText,
  wantsNewImage,
  zoneAsPlace,
} from './scene-request-text';

interface Case {
  id: string;
  input: ClassifierInput;
  expect: Record<string, unknown>;
}

/** Mesma tabela do frontend (`parseRequest`): cópia em JSON nos dois repositórios. */
const CASES: Case[] = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'scene-operation.cases.json'), 'utf8'),
);

describe('classifySceneRequest: tabela de casos compartilhada', () => {
  it('a tabela tem os casos obrigatórios e ids únicos', () => {
    expect(new Set(CASES.map((c) => c.id)).size).toBe(CASES.length);
    expect(CASES.length).toBeGreaterThanOrEqual(40);
  });

  it.each(CASES.map((c) => [c.id, c] as const))('%s', (_id, { input, expect: expected }) => {
    expect(classifySceneRequest(input)).toMatchObject(expected);
  });
});

describe('classifySceneRequest: ordem das regras', () => {
  const base = { hasReadyVersion: true };

  it('sem versão pronta é sempre geração, mesmo com anexo', () => {
    const result = classifySceneRequest({
      hasReadyVersion: false,
      content: 'x',
      attachments: [{ assetId: 'a' }],
    });
    expect(result.operation).toBe('generate');
  });

  it('o anexo de logo vence a marcação', () => {
    const result = classifySceneRequest({
      ...base,
      content: 'coloca isso',
      attachments: [{ assetId: 'a' }],
      region: { x: 0, y: 0, w: 0.2, h: 0.2 },
    });
    expect(result.operation).toBe('set_layer');
  });

  it('mover vence a marcação e a confirmação global', () => {
    const result = classifySceneRequest({
      ...base,
      content: 'mover o sol',
      confirmGlobal: true,
      region: { x: 0, y: 0, w: 0.2, h: 0.2 },
    });
    expect(result.operation).toBe('move_unavailable');
  });

  it('o campo zone vale mesmo sem a palavra no texto', () => {
    const result = classifySceneRequest({ ...base, content: 'mais limpo', zone: 'header' });
    expect(result).toMatchObject({
      operation: 'local_edit',
      target: { kind: 'zone', zone: 'header' },
    });
  });
});

describe('texto do pedido', () => {
  it('"remover" não é "mover" (palavra inteira)', () => {
    expect(mentionsMove(fold('remover o sol'))).toBe(false);
    expect(mentionsMove(fold('mover o sol'))).toBe(true);
    expect(mentionsMove(fold('removendo a nuvem'))).toBe(false);
  });

  it('dobra acentos sem mudar o comprimento', () => {
    expect(fold('Cabeçalho À ESQUERDA')).toBe('cabecalho a esquerda');
    expect(fold('ação').length).toBe('ação'.length);
  });

  it('zonas e sinônimos', () => {
    expect(detectZone('no cabeçalho')).toBe('header');
    expect(detectZone('lá no TOPO')).toBe('header');
    expect(detectZone('no miolo')).toBe('body');
    expect(detectZone('no rodapé')).toBe('footer');
    expect(detectZone('na base')).toBe('footer');
    expect(detectZone('o sol')).toBeNull();
  });

  it('item citado contra pedido global', () => {
    expect(citesImageItem(fold('deixa o sol mais alaranjado'))).toBe(true);
    expect(citesImageItem(fold('deixa tudo mais quente'))).toBe(false);
    expect(citesImageItem(fold('muda a cor do fundo'))).toBe(false);
    expect(citesImageItem(fold('muda a cor do sol'))).toBe(true);
  });

  it('assunto do "adicionar"', () => {
    expect(additionSubject('adiciona um balão de ar quente.')).toBe('balão de ar quente');
    expect(additionSubject('Acrescenta uma nuvem')).toBe('nuvem');
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

describe('Fronteira entre zona, ajuste geral e imagem nova (correção 1)', () => {
  it('Reclamação que cita a zona: não é edição local e nada é pago sem confirmação', () => {
    for (const content of ['o header está diferente', 'você só mudou o cabeçalho']) {
      const result = classifySceneRequest({ hasReadyVersion: true, content });
      expect(result.operation).not.toBe('local_edit');
      expect(result.operation).toBe('needs_confirmation_global');
    }
  });

  it('Zona como lugar: preposição antes da zona, ou "do/da", salvo comparação', () => {
    expect(zoneAsPlace('coloca mais luz no cabeçalho')).toBe('header');
    expect(zoneAsPlace('deixa o céu do cabeçalho mais limpo')).toBe('header');
    expect(zoneAsPlace('põe uma flor para o rodapé')).toBe('footer');
    expect(zoneAsPlace('o header está diferente do body')).toBeNull();
    expect(zoneAsPlace('deixa igual ao rodapé')).toBeNull();
    expect(zoneAsPlace('mudou o cabeçalho')).toBeNull();
    expect(zoneAsPlace('deixa o rodapé mais escuro')).toBe('footer');
  });

  it('Zona citada no texto: guarda de onde veio (campo ou texto)', () => {
    const byText = classifySceneRequest({ hasReadyVersion: true, content: 'mais luz no topo' });
    const byField = classifySceneRequest({
      hasReadyVersion: true,
      content: 'mais luz',
      zone: 'footer',
    });
    expect(byText).toMatchObject({ target: { kind: 'zone', zone: 'header', from: 'text' } });
    expect(byField).toMatchObject({ target: { kind: 'zone', zone: 'footer', from: 'field' } });
  });

  it('Ajuste que diz como mudar não é imagem nova', () => {
    expect(wantsNewImage(fold('deixa tudo mais quente'))).toBe(false);
    expect(wantsNewImage(fold('muda tudo para tons de azul'))).toBe(false);
    expect(wantsNewImage(fold('quero que mude tudo'))).toBe(true);
    expect(wantsNewImage(fold('faz o sol do outro lado'))).toBe(false);
    expect(wantsNewImage(fold('crie uma nova imagem'))).toBe(true);
  });

  it('Pedido de imagem nova com área marcada: a marcação manda', () => {
    const result = classifySceneRequest({
      hasReadyVersion: true,
      content: 'gere outra imagem',
      mask: {
        kind: 'lasso',
        points: [
          { x: 0.1, y: 0.1 },
          { x: 0.3, y: 0.1 },
          { x: 0.2, y: 0.3 },
        ],
      },
    });
    expect(result.operation).toBe('local_edit');
  });

  it('"no lugar de X" sai do assunto', () => {
    expect(additionSubject('Adicione uma cesta de ovos no lugar da cerca removida')).toBe(
      'cesta de ovos',
    );
    expect(additionSubject('adiciona um balão em vez da nuvem')).toBe('balão');
  });
});
