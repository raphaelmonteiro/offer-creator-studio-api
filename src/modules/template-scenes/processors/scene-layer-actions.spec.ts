import { LayerAction } from '../domain/scene-layer.types';
import { computeSceneZones, findSceneFormat } from '../domain/scene-formats';
import { SceneElement } from '../domain/scene.types';
import { applyLayerActions, LayerContext } from './scene-layer-actions';

const zones = computeSceneZones(findSceneFormat('folheto-27x54')!);
const LOGO_ASSET = { id: 'asset-1', url: '/u/logo.png', width: 600, height: 300 };

const ctx = (elements: SceneElement[] = []): LayerContext => ({
  zones,
  widthPx: 1920,
  heightPx: 3840,
  elements,
  attachments: [LOGO_ASSET],
});

const logo = (over: Partial<SceneElement> = {}): SceneElement => ({
  id: 'logo-1',
  kind: 'logo',
  name: 'Logo 1',
  x: 0.2,
  y: 0.05,
  w: 0.3,
  aspect: 2,
  rotation: 0,
  z: 1,
  assetId: 'asset-1',
  ...over,
});
const text = (over: Partial<SceneElement> = {}): SceneElement => ({
  id: 'text-1',
  kind: 'text',
  name: 'Texto 1',
  x: 0.5,
  y: 0.9,
  w: 0.6,
  aspect: 5,
  rotation: 0,
  z: 2,
  text: 'Páscoa',
  fontSize: 7,
  ...over,
});

const apply = (actions: LayerAction[], elements: SceneElement[] = []) =>
  applyLayerActions(actions, ctx(elements));

describe('applyLayerActions', () => {
  it('logo à esquerda no cabeçalho: camada na frente, dentro da faixa do cabeçalho', () => {
    const result = apply([{ type: 'add_logo', assetId: 'asset-1', side: 'left', zone: 'header' }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.elements).toHaveLength(1);
    expect(result.elements[0]).toMatchObject({
      kind: 'logo',
      name: 'Logo 1',
      assetId: 'asset-1',
      aspect: 2,
      w: 0.3,
      z: 1,
    });
    expect(result.elements[0].x).toBeCloseTo(0.19);
    expect(result.elements[0].y).toBeLessThanOrEqual(zones.header.h);
    expect(result.changed).toEqual(['Logo 1']);
  });

  it('logo à direita e no centro; o nome sobe ("Logo 2")', () => {
    const right = apply(
      [{ type: 'add_logo', assetId: 'asset-1', side: 'right', zone: 'footer' }],
      [logo()],
    );
    expect(right.ok && right.elements[1].name).toBe('Logo 2');
    expect(right.ok && right.elements[1].x).toBeCloseTo(0.81);
    expect(right.ok && right.elements[1].y).toBeGreaterThan(1 - zones.footer.h);
    const center = apply([
      { type: 'add_logo', assetId: 'asset-1', side: 'center', zone: 'header' },
    ]);
    expect(center.ok && center.elements[0].x).toBe(0.5);
  });

  it('logo e frase embaixo dela: o texto fica logo abaixo da logo', () => {
    const result = apply([
      { type: 'add_logo', assetId: 'asset-1', side: 'left', zone: 'header' },
      { type: 'set_text', text: 'Ofertas da semana', placement: 'below-logo', replace: false },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [added, label] = result.elements;
    expect(label).toMatchObject({ kind: 'text', text: 'Ofertas da semana', x: added.x });
    expect(label.y).toBeGreaterThan(added.y);
  });

  it('anexo ilegível: responde ao cliente e nada muda', () => {
    const result = applyLayerActions(
      [{ type: 'add_logo', assetId: 'outro', side: 'left', zone: 'header' }],
      {
        ...ctx(),
        attachments: [],
      },
    );
    expect(result).toEqual({ ok: false, reply: expect.stringContaining('logo enviado') });
  });

  it.each([
    ['top', 'header'],
    ['bottom', 'footer'],
    ['none', 'footer'],
  ] as const)('texto %s fica na faixa de %s', (placement, zone) => {
    const result = apply([{ type: 'set_text', text: 'Oferta', placement, replace: false }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const z = zones[zone];
    expect(result.elements[0].y).toBeCloseTo(z.y + z.h / 2);
  });

  it('"muda o texto para" troca o texto do último em vez de criar outro', () => {
    const result = apply(
      [{ type: 'set_text', text: 'Black Friday', placement: 'none', replace: true }],
      [text()],
    );
    expect(result.ok && result.elements).toHaveLength(1);
    expect(result.ok && result.elements[0].text).toBe('Black Friday');
  });

  it('texto selecionado (elementId) troca esse texto, não o último', () => {
    const els = [text({ id: 't1', text: 'A' }), text({ id: 't2', text: 'B' })];
    const result = apply(
      [{ type: 'set_text', text: 'Novo', placement: 'none', replace: true, elementId: 't1' }],
      els,
    );
    expect(result.ok && result.elements.map((e) => e.text)).toEqual(['Novo', 'B']);
  });

  it('mover por tipo citado: direita, esquerda e alternar; o resto da cena não é tocado', () => {
    const els = [logo({ x: 0.2 }), text()];
    const right = apply([{ type: 'move', target: { kind: 'logo' }, side: 'right' }], els);
    expect(right.ok && right.elements[0].x).toBeCloseTo(0.8);
    expect(right.ok && right.elements[1]).toEqual(els[1]);
    const left = apply(
      [{ type: 'move', target: { elementId: 'logo-1' }, side: 'left' }],
      [logo({ x: 0.8 })],
    );
    expect(left.ok && left.elements[0].x).toBeCloseTo(0.2);
    const toggle = apply([{ type: 'move', target: { kind: 'logo' }, side: 'toggle' }], els);
    expect(toggle.ok && toggle.elements[0].x).toBeCloseTo(0.8);
  });

  it('redimensiona logo (largura) e texto (fonte) com limites', () => {
    const big = apply(
      [{ type: 'resize', target: { kind: 'logo' }, direction: 'bigger' }],
      [logo()],
    );
    expect(big.ok && big.elements[0].w).toBeCloseTo(0.375);
    const small = apply(
      [{ type: 'resize', target: { kind: 'text' }, direction: 'smaller' }],
      [text()],
    );
    expect(small.ok && small.elements[0].fontSize).toBeCloseTo(5.6);
    const capped = apply(
      [{ type: 'resize', target: { kind: 'logo' }, direction: 'bigger' }],
      [logo({ w: 0.85 })],
    );
    expect(capped.ok && capped.elements[0].w).toBe(0.9);
  });

  it('tira a camada', () => {
    const result = apply([{ type: 'remove', target: { kind: 'text' } }], [logo(), text()]);
    expect(result.ok && result.elements.map((e) => e.id)).toEqual(['logo-1']);
  });

  it('elemento adicionado (generated) também é movido pela seleção', () => {
    const generated: SceneElement = {
      ...logo({ id: 'g1', kind: 'generated', name: 'Balão', x: 0.3 }),
    };
    const result = apply(
      [{ type: 'move', target: { elementId: 'g1' }, side: 'right' }],
      [generated],
    );
    expect(result.ok && result.elements[0].x).toBeCloseTo(0.7);
  });

  it.each([
    [{ type: 'move', target: { kind: 'logo' }, side: 'right' }, [], 'Não encontrei a logo'],
    [{ type: 'remove', target: { kind: 'text' } }, [logo()], 'Não encontrei o texto'],
    [
      { type: 'move', target: { kind: 'logo' }, side: 'right' },
      [logo(), logo({ id: 'l2', name: 'Logo 2' })],
      'Há mais de uma logo',
    ],
    [
      { type: 'resize', target: { elementId: 'x' }, direction: 'bigger' },
      [logo()],
      'Não encontrei esse elemento',
    ],
  ] as const)('alvo ausente ou ambíguo (%j): responde e não altera nada', (action, els, trecho) => {
    const before = structuredClone(els);
    const result = apply([action as LayerAction], els as unknown as SceneElement[]);
    expect(result).toEqual({ ok: false, reply: expect.stringContaining(trecho) });
    expect(els).toEqual(before);
  });

  it('não altera a lista de entrada', () => {
    const els = [logo()];
    apply([{ type: 'move', target: { kind: 'logo' }, side: 'right' }], els);
    expect(els[0].x).toBe(0.2);
  });
});
