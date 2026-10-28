import { hasChildWorkInFlight } from '../../../shared/process/in-flight-child-work';
import { TerminalProviderError } from '../../../shared/providers/provider-errors';
import { McRenderInterruptedError } from '../domain/mc-error-classes';
import { MC_NO_MUSIC_SRC, OfferCarouselProps } from '../domain/mc-offer-carousel-props';
import { RemotionCarouselRenderer, RemotionModules } from './mc-carousel-renderer';
import { fakeModules, props, request } from './mc-carousel-renderer.fixture';
import { MC_RENDER_DEATH_GRACE_MS } from './mc-render-watchdog';
import { RemotionStillRenderer } from './mc-still-renderer';

type Listener = () => void;

/** Navegador falso que guarda os ouvintes de `closed`/`closed-silent` e deixa o teste disparar a morte. */
function listeningBrowser() {
  const listeners: Record<string, Listener[]> = {};
  return {
    close: jest.fn().mockResolvedValue(undefined),
    on: jest.fn((event: string, cb: Listener) => {
      (listeners[event] ??= []).push(cb);
    }),
    emit: (event: string) => (listeners[event] ?? []).forEach((cb) => cb()),
  };
}

const death = () => Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });

describe('RemotionCarouselRenderer — morte de processo vira falha do step (corrigir-render-remotion-epipe)', () => {
  const env = { MC_RENDER_BROWSER: '/usr/bin/chromium-browser' };
  let renderer: RemotionCarouselRenderer;
  let fake: ReturnType<typeof fakeModules>;

  beforeEach(() => {
    fake = fakeModules();
    renderer = new RemotionCarouselRenderer(env, async () => fake.modules as RemotionModules);
  });

  it('renderMedia rejeitado por EPIPE: render_interrupted na fase, navegador descartado, o seguinte abre outro', async () => {
    fake.modules.renderer.renderMedia.mockRejectedValueOnce(death());
    const err = await renderer.render(request()).catch((e) => e);
    expect(err).toBeInstanceOf(McRenderInterruptedError);
    expect(err.phase).toBe('render_media');
    expect(fake.browser.close).toHaveBeenCalledTimes(1);
    expect(fake.modules.renderer.openBrowser).toHaveBeenCalledTimes(1);

    await expect(renderer.render(request())).resolves.toMatchObject({ renderer: 'remotion' });
    expect(fake.modules.renderer.openBrowser).toHaveBeenCalledTimes(2);
    expect(fake.modules.bundler.bundle).toHaveBeenCalledTimes(1); // o bundle sobrevive à queda
  });

  it('selectComposition: compositor morto vira render_interrupted', async () => {
    fake.modules.renderer.selectComposition.mockRejectedValueOnce(
      new Error('Compositor quit with signal SIGKILL'),
    );
    const err = await renderer.render(request()).catch((e) => e);
    expect(err).toBeInstanceOf(McRenderInterruptedError);
    expect(err.phase).toBe('select_composition');
    expect(fake.browser.close).toHaveBeenCalledTimes(1);
  });

  it('openBrowser que não conecta vira render_interrupted e não deixa navegador em cache', async () => {
    fake.modules.renderer.openBrowser.mockRejectedValueOnce(
      new Error('Timed out after 25000 ms while trying to connect to the browser!'),
    );
    const err = await renderer.render(request()).catch((e) => e);
    expect(err).toBeInstanceOf(McRenderInterruptedError);
    expect(err.phase).toBe('open_browser');
    await expect(renderer.render(request())).resolves.toBeDefined();
    expect(fake.modules.renderer.openBrowser).toHaveBeenCalledTimes(2);
  });

  it('falha do bundle e de conteúdo seguem como vieram (não viram "interrompido"); o navegador é descartado', async () => {
    fake.modules.bundler.bundle.mockRejectedValueOnce(new Error('Module not found: foo'));
    await expect(renderer.render(request())).rejects.toThrow('Module not found: foo');
    fake.modules.renderer.renderMedia.mockRejectedValueOnce(
      new Error('A delayRender() was called but not cleared after 28000ms'),
    );
    const err = await renderer.render(request()).catch((e) => e);
    expect(err).not.toBeInstanceOf(McRenderInterruptedError);
    expect(err.message).toContain('delayRender');
    expect(fake.browser.close).toHaveBeenCalledTimes(1);
  });

  it('RENDER_UNAVAILABLE inalterado: sem MC_RENDER_BROWSER, erro terminal sem tentar abrir navegador', async () => {
    const semNavegador = new RemotionCarouselRenderer(
      {},
      async () => fake.modules as RemotionModules,
    );
    const err = await semNavegador.render(request()).catch((e) => e);
    expect(err).toBeInstanceOf(TerminalProviderError);
    expect(err.code).toBe('RENDER_UNAVAILABLE');
    expect(fake.modules.renderer.openBrowser).not.toHaveBeenCalled();
    expect(fake.browser.close).not.toHaveBeenCalled();
  });

  it('Chromium que morre sozinho (closed-silent) zera o cache: o próximo render abre navegador novo', async () => {
    const first = listeningBrowser();
    const second = listeningBrowser();
    fake.modules.renderer.openBrowser.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    await renderer.render(request());
    first.emit('closed-silent');
    await renderer.render(request());
    expect(fake.modules.renderer.openBrowser).toHaveBeenCalledTimes(2);
    const used = fake.modules.renderer.renderMedia.mock.calls.map((c) => c[0].puppeteerInstance);
    expect(used).toEqual([first, second]);
  });

  it('evento tardio do navegador antigo não apaga o navegador novo (comparação por identidade)', async () => {
    const first = listeningBrowser();
    const second = listeningBrowser();
    fake.modules.renderer.openBrowser.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    await renderer.render(request());
    first.emit('closed'); // morre: cache zerado
    await renderer.render(request()); // abre o segundo
    first.emit('closed-silent'); // evento atrasado do antigo
    await renderer.render(request());
    expect(fake.modules.renderer.openBrowser).toHaveBeenCalledTimes(2);
    expect(fake.modules.renderer.renderMedia.mock.calls[2][0].puppeteerInstance).toBe(second);
  });

  it('navegador falso sem `on` continua valendo (superfície opcional)', async () => {
    await expect(renderer.render(request())).resolves.toBeDefined();
  });

  it('o render conta como trabalho de processo filho enquanto roda e deixa de contar ao terminar ou falhar', async () => {
    const seen: boolean[] = [];
    fake.modules.renderer.renderMedia.mockImplementationOnce(async () => {
      seen.push(hasChildWorkInFlight());
    });
    await renderer.render(request());
    fake.modules.renderer.renderMedia.mockImplementationOnce(async () => {
      seen.push(hasChildWorkInFlight());
      throw death();
    });
    await renderer.render(request()).catch(() => undefined);
    expect(seen).toEqual([true, true]);
    expect(hasChildWorkInFlight()).toBe(false);
  });

  it('as duas chamadas (selectComposition e renderMedia) recebem as mesmas props, com music mudo explícito', async () => {
    const p = props();
    await renderer.render(request(p));
    const select = fake.modules.renderer.selectComposition.mock.calls[0][0]
      .inputProps as OfferCarouselProps;
    const media = fake.modules.renderer.renderMedia.mock.calls[0][0].inputProps;
    expect(select).toBe(p);
    expect(media).toBe(p);
    expect(select.music).toEqual({ src: MC_NO_MUSIC_SRC, volume: 0 });
    expect(fake.modules.core.parseOfferCarouselProps).toHaveBeenCalledWith(p);
  });
});

describe('RemotionCarouselRenderer — Chromium morre no meio do render e o Remotion não retoma (vigia)', () => {
  const env = { MC_RENDER_BROWSER: '/usr/bin/chromium-browser' };
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  /** renderMedia fica pendurado até o cancelamento (`cancel()`), como o render medido na stack qa-wc. */
  function hangingRender() {
    const fake = fakeModules();
    const browser = listeningBrowser();
    fake.modules.renderer.openBrowser.mockResolvedValue(browser);
    let progress: ((p: { progress: number }) => void) | undefined;
    let finish: () => void = () => undefined;
    fake.modules.renderer.renderMedia.mockImplementationOnce(
      (opts: { onProgress?: (p: { progress: number }) => void }) =>
        new Promise((resolve, reject) => {
          progress = opts.onProgress;
          finish = () => resolve(undefined);
          fake.cancel.mockImplementation(() => reject(new Error('renderMedia() got cancelled')));
        }),
    );
    const renderer = new RemotionCarouselRenderer(env, async () => fake.modules as RemotionModules);
    return { fake, browser, renderer, progress: () => progress, finish: () => finish() };
  }

  it('navegador morre e os quadros não voltam em 60 s: cancela e falha como render_interrupted (não espera o prazo total)', async () => {
    const { fake, browser, renderer } = hangingRender();
    const result = renderer.render(request()).catch((e) => e);
    await jest.advanceTimersByTimeAsync(1_000);
    browser.emit('closed-silent'); // o Remotion fecha o navegador morto
    await jest.advanceTimersByTimeAsync(MC_RENDER_DEATH_GRACE_MS + 6_000);
    const err = await result;
    expect(fake.cancel).toHaveBeenCalledTimes(1);
    expect(err).toBeInstanceOf(McRenderInterruptedError);
    expect(err.phase).toBe('render_media');
    expect(err.message).toContain('Chromium morreu durante o render');
  });

  it('o Remotion retoma sozinho (quadros voltam a andar): a vigia não cancela e o render termina', async () => {
    const { fake, browser, renderer, progress, finish } = hangingRender();
    const result = renderer.render(request());
    await jest.advanceTimersByTimeAsync(1_000);
    browser.emit('closed-silent');
    for (let i = 0; i < 20; i++) {
      await jest.advanceTimersByTimeAsync(10_000); // 200 s no total, com quadros andando
      progress()?.({ progress: i / 20 });
    }
    expect(fake.cancel).not.toHaveBeenCalled();
    finish();
    await expect(result).resolves.toMatchObject({ renderer: 'remotion' });
  });

  it('onProgress repetido com o mesmo valor (render parado) não conta como retomada', async () => {
    const { fake, browser, renderer, progress } = hangingRender();
    const result = renderer.render(request()).catch((e) => e);
    await jest.advanceTimersByTimeAsync(1_000);
    progress()?.({ progress: 0.14 });
    browser.emit('closed-silent');
    for (let i = 0; i < 14; i++) {
      await jest.advanceTimersByTimeAsync(5_000);
      progress()?.({ progress: 0.14 }); // mesmo valor: o render segue parado
    }
    const err = await result;
    expect(fake.cancel).toHaveBeenCalledTimes(1);
    expect(err).toBeInstanceOf(McRenderInterruptedError);
  });

  it('sem morte do navegador a vigia não interfere (render lento não é cancelado)', async () => {
    const { fake, renderer, finish } = hangingRender();
    const result = renderer.render(request());
    await jest.advanceTimersByTimeAsync(MC_RENDER_DEATH_GRACE_MS * 3);
    expect(fake.cancel).not.toHaveBeenCalled();
    finish();
    await expect(result).resolves.toBeDefined();
  });
});

describe('RemotionStillRenderer — mesma proteção no quadro parado da peça (D-2)', () => {
  function stillSetup() {
    const fake = fakeModules();
    const carousel = new RemotionCarouselRenderer(
      { MC_RENDER_BROWSER: '/usr/bin/chromium' },
      async () => fake.modules as RemotionModules,
    );
    const renderer = {
      ...fake.modules.renderer,
      renderStill: jest.fn().mockResolvedValue(undefined),
    };
    fake.modules.renderer = renderer as typeof fake.modules.renderer;
    return { fake, carousel, still: new RemotionStillRenderer(carousel, {}), renderer };
  }
  const stillRequest = { props: {} as never, localFiles: {}, outputPath: '/tmp/s.png' };

  it('Chromium morto no renderStill: render_interrupted, navegador descartado e próximo quadro com navegador novo', async () => {
    const { fake, still, renderer } = stillSetup();
    renderer.renderStill.mockRejectedValueOnce(new Error('Target closed'));
    const err = await still.renderStill(stillRequest).catch((e) => e);
    expect(err).toBeInstanceOf(McRenderInterruptedError);
    expect(err.phase).toBe('render_still');
    expect(fake.browser.close).toHaveBeenCalledTimes(1);
    await still.renderStill(stillRequest);
    expect(renderer.openBrowser).toHaveBeenCalledTimes(2);
  });

  it('navegador que não sobe vira render_interrupted também no quadro, e closed-silent zera o cache', async () => {
    const { fake, still, renderer } = stillSetup();
    renderer.openBrowser.mockRejectedValueOnce(new Error('spawn ENOEXEC'));
    const err = await still.renderStill(stillRequest).catch((e) => e);
    expect(err).toBeInstanceOf(McRenderInterruptedError);
    expect(err.phase).toBe('open_browser');

    const first = listeningBrowser();
    renderer.openBrowser.mockResolvedValueOnce(first);
    await still.renderStill(stillRequest);
    first.emit('closed-silent');
    await still.renderStill(stillRequest);
    expect(renderer.openBrowser).toHaveBeenCalledTimes(3);
    expect(fake.browser.close).toHaveBeenCalledTimes(0);
  });

  it('o quadro conta como trabalho de processo filho', async () => {
    const { still, renderer } = stillSetup();
    let during = false;
    renderer.renderStill.mockImplementationOnce(async () => {
      during = hasChildWorkInFlight();
    });
    await still.renderStill(stillRequest);
    expect(during).toBe(true);
    expect(hasChildWorkInFlight()).toBe(false);
  });
});
