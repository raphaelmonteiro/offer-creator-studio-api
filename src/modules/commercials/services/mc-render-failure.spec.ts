import { TerminalProviderError } from '../../../shared/providers/provider-errors';
import { McRenderInterruptedError } from '../domain/mc-error-classes';
import { isProcessDeath, toRenderFailure } from './mc-render-failure';

const withCode = (code: string, message = 'x') => Object.assign(new Error(message), { code });

describe('isProcessDeath', () => {
  it.each([
    withCode('EPIPE', 'write EPIPE'),
    withCode('ECONNRESET'),
    withCode('ERR_STREAM_DESTROYED'),
    withCode('ERR_STREAM_WRITE_AFTER_END'),
    withCode('ERR_IPC_CHANNEL_CLOSED'),
    new Error('Compositor quit with signal SIGKILL'),
    new Error('Could not extract frame from compositor'),
    new Error('The browser crashed while rendering frame 4'),
    new Error('Protocol error (Target.activateTarget): Session closed.'),
    new Error('Timed out after 25000 ms while trying to connect to the browser!'),
    new Error('Browser closed'),
    'Target closed',
  ])('reconhece a morte de processo: %s', (err) => {
    expect(isProcessDeath(err)).toBe(true);
  });

  it.each([
    new Error('Could not play audio: MEDIA_ELEMENT_ERROR'),
    new Error('A delayRender() was called but not cleared after 28000ms'),
    new Error('renderMedia() got cancelled'),
    new Error('404 Not Found'),
    null,
    undefined,
  ])('não confunde com falha de conteúdo: %s', (err) => {
    expect(isProcessDeath(err)).toBe(false);
  });
});

describe('toRenderFailure', () => {
  it('morte de processo em qualquer fase vira render_interrupted com a fase e a causa', () => {
    for (const phase of ['select_composition', 'render_media', 'render_still'] as const) {
      const original = withCode('EPIPE', 'write EPIPE');
      const out = toRenderFailure(original, phase) as McRenderInterruptedError;
      expect(out).toBeInstanceOf(McRenderInterruptedError);
      expect(out.phase).toBe(phase);
      expect(out.message).toBe(`render interrompido na fase ${phase}: write EPIPE`);
      expect((out as { cause?: unknown }).cause).toBe(original);
    }
  });

  it('qualquer falha ao abrir o navegador vira render_interrupted', () => {
    const out = toRenderFailure(new Error('spawn chrome ENOENT'), 'open_browser');
    expect(out).toBeInstanceOf(McRenderInterruptedError);
  });

  it('falha de conteúdo ou de bundle não é remapeada', () => {
    const delay = new Error('A delayRender() was called but not cleared');
    expect(toRenderFailure(delay, 'render_media')).toBe(delay);
    const bundle = new Error('Module not found');
    expect(toRenderFailure(bundle, 'bundle')).toBe(bundle);
  });

  it('erro tipado terminal passa intacto, inclusive ao abrir o navegador', () => {
    const unavailable = new TerminalProviderError(
      'MC_RENDER_BROWSER não definido',
      'RENDER_UNAVAILABLE',
    );
    expect(toRenderFailure(unavailable, 'open_browser')).toBe(unavailable);
  });

  it('não embrulha duas vezes e corta a mensagem em 300 caracteres', () => {
    const once = toRenderFailure(new Error('SIGKILL ' + 'a'.repeat(500)), 'render_media');
    expect(toRenderFailure(once, 'render_media')).toBe(once);
    expect((once as Error).message.length).toBeLessThan(400);
  });
});
