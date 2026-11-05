import { SceneIntent } from './scene-intent';
import { IntentPlanInput, planFromIntent } from './scene-intent-plan';
import { LocalTarget } from './scene-operation.classifier';
import { SceneElement } from './scene.types';

const intent = (extra: Partial<SceneIntent>): SceneIntent => ({
  action: 'edit',
  zone: null,
  object: null,
  subject: null,
  imagePrompt: null,
  relativePlace: false,
  layer: null,
  text: null,
  ...extra,
});
const RECT: LocalTarget = { kind: 'rect', rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } };
const basket = (id: string, name: string): SceneElement => ({
  id,
  kind: 'generated',
  name,
  x: 0.5,
  y: 0.5,
  w: 0.2,
  aspect: 1,
  rotation: 0,
  z: 1,
  assetId: 'a',
});
const plan = (extra: Partial<SceneIntent>, input: Partial<IntentPlanInput> = {}) =>
  planFromIntent(intent(extra), { content: 'a mensagem', marked: null, layers: [], ...input });
const marked = { marked: RECT };

describe('planFromIntent: da intenção ao plano (D-19)', () => {
  describe('edit e remove', () => {
    it('sem marcação, a zona citada como lugar vale', () => {
      expect(plan({ action: 'edit', zone: 'header', imagePrompt: 'mais luz' })).toEqual({
        operation: 'local_edit',
        target: { kind: 'zone', zone: 'header', from: 'text' },
        instruction: 'a mensagem',
        remove: false,
        imagePrompt: 'mais luz',
        object: null,
      });
    });

    it('sem marcação e sem zona, pede a área', () => {
      expect(plan({ action: 'edit' })).toEqual({ operation: 'needs_region', reason: 'item' });
      expect(plan({ action: 'remove', object: 'os ovos' })).toEqual({
        operation: 'needs_region',
        reason: 'item',
      });
    });

    it('com marcação, o alvo é sempre a marcação e a zona do modelo é ignorada', () => {
      expect(plan({ action: 'edit', zone: 'footer' }, marked)).toMatchObject({
        operation: 'local_edit',
        target: RECT,
        remove: false,
      });
    });

    it('remove leva remove: true e o objeto nomeado; objeto nulo fica nulo (R25)', () => {
      expect(plan({ action: 'remove', object: 'os ovos' }, marked)).toMatchObject({
        remove: true,
        object: 'os ovos',
      });
      expect(plan({ action: 'remove' }, marked)).toMatchObject({ remove: true, object: null });
    });
  });

  describe('add_element', () => {
    const add = { action: 'add_element' as const, subject: 'cesta de ovos' };

    it('"no lugar de X" sem área pede onde, com o assunto limpo (R35)', () => {
      expect(plan({ ...add, relativePlace: true })).toEqual({
        operation: 'needs_region',
        reason: 'place',
        subject: 'cesta de ovos',
      });
    });

    it('com área, nasce nela, mesmo com lugar relativo', () => {
      expect(plan({ ...add, relativePlace: true }, marked)).toEqual({
        operation: 'add_element',
        subject: 'cesta de ovos',
        target: RECT,
      });
    });

    it('zona citada: centro da zona; nada: centro do miolo (alvo nulo)', () => {
      expect(plan({ ...add, zone: 'footer' })).toMatchObject({
        target: { kind: 'zone', zone: 'footer', from: 'text' },
      });
      expect(plan(add)).toEqual({
        operation: 'add_element',
        subject: 'cesta de ovos',
        target: null,
      });
    });
  });

  describe('integrate', () => {
    it('com marcação, local_edit com integrate: true (o alvo da camada vem depois)', () => {
      expect(plan({ action: 'integrate', object: 'a cesta' }, marked)).toMatchObject({
        operation: 'local_edit',
        target: RECT,
        integrate: true,
      });
    });

    it('sem marcação, fica para o resolvedor (nunca vira ajuste geral, R29)', () => {
      expect(plan({ action: 'integrate' })).toEqual({
        operation: 'needs_region',
        reason: 'integrate',
      });
    });
  });

  describe('ajuste geral, imagem nova e "pedir a área"', () => {
    it('sem marcação, perguntam', () => {
      expect(plan({ action: 'global_adjust' })).toEqual({ operation: 'needs_confirmation_global' });
      expect(plan({ action: 'new_image' })).toEqual({ operation: 'needs_confirmation_new_image' });
      expect(plan({ action: 'ask_region' })).toEqual({ operation: 'needs_region', reason: 'item' });
    });

    it('com marcação, a marcação manda: edição local da área, com a mensagem do cliente', () => {
      for (const action of ['global_adjust', 'new_image', 'ask_region'] as const) {
        expect(plan({ action, imagePrompt: 'paráfrase' }, marked)).toEqual({
          operation: 'local_edit',
          target: RECT,
          instruction: 'a mensagem',
          remove: false,
        });
      }
    });
  });

  it('move_item nunca vira edição, com ou sem marcação', () => {
    expect(plan({ action: 'move_item' })).toEqual({ operation: 'move_unavailable' });
    expect(plan({ action: 'move_item' }, marked)).toEqual({ operation: 'move_unavailable' });
  });

  describe('camadas', () => {
    it('logo e texto pelo tipo', () => {
      const layer = { kind: 'logo' as const, name: null, side: 'right' as const, direction: null };
      expect(plan({ action: 'layer_move', layer }, marked)).toEqual({
        operation: 'set_layer',
        actions: [{ type: 'move', target: { kind: 'logo' }, side: 'right' }],
      });
      expect(
        plan({ action: 'layer_resize', layer: { ...layer, kind: 'text', direction: 'smaller' } }),
      ).toMatchObject({
        actions: [{ type: 'resize', target: { kind: 'text' }, direction: 'smaller' }],
      });
      expect(plan({ action: 'layer_remove', layer })).toMatchObject({
        actions: [{ type: 'remove', target: { kind: 'logo' } }],
      });
      expect(plan({ action: 'layer_move', layer: { ...layer, side: null } })).toMatchObject({
        actions: [{ side: 'toggle' }],
      });
    });

    it('camada gerada pelo nome, se só uma serve; senão pede a seleção', () => {
      const layer = { kind: 'generated' as const, name: 'cesta', side: null, direction: null };
      const layers = [basket('g1', 'Cesta de ovos'), basket('g2', 'Coelho')];
      expect(plan({ action: 'layer_remove', layer }, { layers })).toMatchObject({
        actions: [{ type: 'remove', target: { elementId: 'g1' } }],
      });
      const two = [...layers, basket('g3', 'Cesta de palha')];
      expect(plan({ action: 'layer_remove', layer }, { layers: two })).toEqual({
        operation: 'needs_region',
        reason: 'select_layer',
      });
      expect(plan({ action: 'layer_remove', layer }, { layers: [] })).toMatchObject({
        reason: 'select_layer',
      });
    });
  });

  describe('set_text', () => {
    it('texto exato vira camada, sem marcação ou com ela', () => {
      const text = { value: 'Black Friday', placement: 'top' as const };
      expect(plan({ action: 'set_text', text }, marked)).toEqual({
        operation: 'set_layer',
        actions: [{ type: 'set_text', text: 'Black Friday', placement: 'top', replace: false }],
      });
    });

    it('trocar o texto existente (layer text) substitui', () => {
      const text = { value: 'Black Friday', placement: 'none' as const };
      const layer = { kind: 'text' as const, name: null, side: null, direction: null };
      expect(plan({ action: 'set_text', text, layer })).toMatchObject({
        actions: [{ replace: true }],
      });
    });
  });
});
