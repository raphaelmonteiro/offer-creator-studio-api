import { RigValidationError, parseRig } from './rig-validation';
import { MascotRig } from './rig.types';

const rigValido = (): MascotRig => ({
  version: 1,
  canvas: { w: 600, h: 800 },
  layers: [
    {
      id: 'torso',
      role: 'torso',
      url: '/uploads/mascots/torso.png',
      rect: { x: 0.3, y: 0.4, w: 0.4, h: 0.4 },
      z: 20,
      pivot: { x: 0.5, y: 0.98 },
      visible: true,
    },
    {
      id: 'head',
      role: 'head',
      url: '/uploads/mascots/head.png',
      rect: { x: 0.25, y: 0.05, w: 0.5, h: 0.35 },
      z: 30,
      pivot: { x: 0.5, y: 0.97 },
      joints: ['neck'],
      visible: true,
    },
  ],
  mouth: {
    anchor: { x: 0.5, y: 0.28 },
    width: 0.12,
    height: 0.06,
    mode: 'procedural',
    openScale: 2.2,
  },
  eyes: {
    left: { x: 0.42, y: 0.2 },
    right: { x: 0.58, y: 0.2 },
    radius: 0.03,
    blinkEveryMs: [2800, 5200],
  },
  source: 'auto',
});

describe('parseRig — o rig editado à mão não pode quebrar o renderer', () => {
  it('aceita um rig bem formado e devolve cópia normalizada', () => {
    const parsed = parseRig(rigValido());
    expect(parsed.version).toBe(1);
    expect(parsed.layers).toHaveLength(2);
    expect(parsed.canvas).toEqual({ w: 600, h: 800 });
  });

  it('ordena as camadas por z', () => {
    const rig = rigValido();
    rig.layers = [rig.layers[1], rig.layers[0]]; // head antes do torso
    expect(parseRig(rig).layers.map((l) => l.role)).toEqual(['torso', 'head']);
  });

  it('descarta campos desconhecidos em vez de guardar lixo do frontend', () => {
    const rig = { ...rigValido(), sujeira: 'x' } as unknown as Record<string, unknown>;
    (rig.layers as Record<string, unknown>[])[0].hackzor = true;
    const parsed = parseRig(rig);
    expect('sujeira' in parsed).toBe(false);
    expect('hackzor' in parsed.layers[0]).toBe(false);
  });

  it('rejeita versão desconhecida', () => {
    expect(() => parseRig({ ...rigValido(), version: 2 })).toThrow(/não suportada/i);
  });

  it('rejeita rig sem camadas', () => {
    expect(() => parseRig({ ...rigValido(), layers: [] })).toThrow(/pelo menos uma peça/i);
  });

  it('rejeita papel de peça desconhecido, listando os válidos', () => {
    const rig = rigValido();
    (rig.layers[0] as unknown as Record<string, unknown>).role = 'cauda';
    expect(() => parseRig(rig)).toThrow(/papel desconhecido/i);
  });

  it('rejeita fração fora de 0..1', () => {
    const rig = rigValido();
    rig.layers[0].rect.x = 1.5;
    expect(() => parseRig(rig)).toThrow(/entre 0 e 1/i);
  });

  it('rejeita peça sem tamanho', () => {
    const rig = rigValido();
    rig.layers[0].rect.w = 0;
    expect(() => parseRig(rig)).toThrow(/sem tamanho/i);
  });

  it('rejeita ids repetidos', () => {
    const rig = rigValido();
    rig.layers[1].id = 'torso';
    expect(() => parseRig(rig)).toThrow(/mesmo identificador/i);
  });

  it('rejeita rig só de braços — precisa de cabeça ou tronco', () => {
    const rig = rigValido();
    rig.layers = [{ ...rig.layers[0], id: 'arm_left', role: 'arm_left' }];
    expect(() => parseRig(rig)).toThrow(/cabeça ou um tronco/i);
  });

  it('rejeita canvas ausente ou degenerado', () => {
    expect(() => parseRig({ ...rigValido(), canvas: undefined })).toThrow(/dimensões do canvas/i);
    expect(() => parseRig({ ...rigValido(), canvas: { w: 0, h: 10 } })).toThrow(/inválidas/i);
  });

  it('rejeita entrada que nem é objeto', () => {
    expect(() => parseRig(null)).toThrow(RigValidationError);
    expect(() => parseRig('rig')).toThrow(/vazio ou inválido/i);
  });

  it('normaliza openScale fora da faixa e blink invertido', () => {
    const rig = rigValido();
    rig.mouth.openScale = 99;
    rig.eyes.blinkEveryMs = [5000, 1000];
    const parsed = parseRig(rig);
    expect(parsed.mouth.openScale).toBe(2.2);
    expect(parsed.eyes.blinkEveryMs[1]).toBeGreaterThan(parsed.eyes.blinkEveryMs[0]);
  });

  it('filtra articulações inválidas', () => {
    const rig = rigValido();
    (rig.layers[1] as unknown as Record<string, unknown>).joints = ['neck', 'rabo'];
    expect(parseRig(rig).layers.find((l) => l.role === 'head').joints).toEqual(['neck']);
  });

  it('erro aponta o campo, para a UI destacar o que consertar', () => {
    const rig = rigValido();
    rig.layers[0].rect.x = 2;
    try {
      parseRig(rig);
      throw new Error('deveria ter lançado');
    } catch (error) {
      expect(error).toBeInstanceOf(RigValidationError);
      expect((error as RigValidationError).field).toBe('layers[0].rect.x');
    }
  });
});
