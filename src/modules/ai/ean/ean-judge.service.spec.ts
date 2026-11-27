import { Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as sharp from 'sharp';
import { EAN_JUDGE_PROMPT_VERSION } from '../prompts/ean-judge.prompts';
import type { EanCandidateRecord } from './ean-match.types';
import {
  EanJudgeService,
  embaralhar,
  interpretar,
  precisaAltaResolucao,
} from './ean-judge.service';

function cand(imageId: string, filename: string): EanCandidateRecord {
  return {
    imageId,
    filename,
    url: `http://35.247.231.120/uploads/gallery/${imageId}.png`,
    title: null,
    brand: null,
    variant: null,
    quantity: null,
    score: 0.5,
    textScore: 0.5,
    vectorScore: null,
    origins: ['brand'],
    vetoes: [],
  };
}

const SEM_IMAGENS = { referencia: null, candidatas: [], detail: 'low' as const };
const NONE = '{"decision":"none","images":[],"labels":[],"reason":"x"}';
const INVALIDA = 'não é json';

describe('EanJudgeService', () => {
  let dir: string;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ean-judge-'));
    fs.mkdirSync(path.join(dir, 'gallery'));
    const cores: Record<string, string> = { cristal: '#c33', demerara: '#3c3', organico: '#33c' };
    for (const id of Object.keys(cores)) {
      const png = await sharp({
        create: { width: 900, height: 600, channels: 4, background: cores[id] },
      })
        .png()
        .toBuffer();
      fs.writeFileSync(path.join(dir, 'gallery', `${id}.png`), png);
    }
  });

  function criar(
    respostas: string[],
    env: Record<string, string> = {},
    usage: { prompt_tokens: number; completion_tokens: number } | null = {
      prompt_tokens: 2000,
      completion_tokens: 150,
    },
  ) {
    const vars: Record<string, string> = { OPENAI_API_KEY: 'sk-test', UPLOAD_DEST: dir, ...env };
    const service = new EanJudgeService({ get: (k: string, d?: string) => vars[k] ?? d } as never);
    const create = jest.fn();
    for (const r of respostas) {
      create.mockResolvedValueOnce({
        choices: [{ message: { content: r } }],
        ...(usage ? { usage } : {}),
      });
    }
    (service as unknown as { openai: unknown }).openai = { chat: { completions: { create } } };
    return { service, create };
  }

  const input = {
    itemId: 'item-1',
    ean: '7891910000197',
    descricao: 'ACUCAR CRISTALCUCAR UNIÃO 1KG',
    reference: {
      ean: '7891910000197',
      source: 'off' as const,
      name: 'Açúcar Cristal União 1kg',
      brand: 'União',
      quantity: '1 kg',
      imageUrl: null,
    },
    candidatas: [
      cand('cristal', 'Uniao - cristal 1kg.jpg'),
      cand('demerara', 'Uniao - demerara 1kg.jpg'),
      cand('organico', 'Uniao - organico 1kg.jpg'),
    ],
  };

  it('lê as imagens do UPLOAD_DEST, reduz e envia em low quando os nomes diferem', async () => {
    const { service, create } = criar([]);
    const imgs = await service.prepararImagens(input);
    expect(imgs.detail).toBe('low');
    expect(imgs.candidatas).toHaveLength(3);
    expect(imgs.candidatas[0].dataUrl).toMatch(/^data:image\/jpeg;base64,/);
    const meta = await sharp(
      Buffer.from(imgs.candidatas[0].dataUrl.split(',')[1], 'base64'),
    ).metadata();
    expect(Math.max(meta.width!, meta.height!)).toBe(512);
    expect(create).not.toHaveBeenCalled();
  });

  it('traduz letra para id, guarda o rótulo lido e o custo', async () => {
    const { service, create } = criar([], { EAN_JUDGE_MODEL_A: 'gpt-4o' });
    const imgs = await service.prepararImagens(input);
    create.mockImplementation(async (req: { messages: Array<{ content: unknown }> }) => {
      // Descobre qual letra recebeu a imagem "cristal" olhando a ordem enviada.
      const partes = req.messages[1].content as Array<{
        type: string;
        text?: string;
        image_url?: { url: string };
      }>;
      const letraCristal = partes
        .map((p, i) =>
          p.type === 'image_url' && p.image_url!.url === imgs.candidatas[0].dataUrl
            ? partes[i - 1].text!.slice(-2, -1)
            : null,
        )
        .find(Boolean);
      return {
        choices: [
          {
            message: {
              content: JSON.stringify({
                decision: 'match',
                images: [letraCristal],
                labels: [
                  { image: letraCristal, brand: 'União', variant: 'Cristal', quantity: '1kg' },
                ],
                reason: 'rótulo cristal',
              }),
            },
          },
        ],
        usage: { prompt_tokens: 2000, completion_tokens: 150 },
      };
    });

    const j = await service.julgar('A', input, imgs);
    expect(j).toMatchObject({ judge: 'A', decision: 'match', imageIds: ['cristal'] });
    expect(j.labelReadout).toEqual([
      { imageId: 'cristal', brand: 'União', variant: 'Cristal', quantity: '1kg' },
    ]);
    expect(j.costUsd).toBeCloseTo((2000 * 2.5 + 150 * 10) / 1e6, 8);
    expect(j.error).toBeUndefined();
  });

  it('saída inválida: tenta de novo e, persistindo, devolve erro (vai para revisão)', async () => {
    const { service, create } = criar([
      'não é json',
      '{"decision":"match","images":["Z"],"labels":[{"image":"Z","brand":null,"variant":null,"quantity":null}],"reason":"x"}',
    ]);
    const imgs = await service.prepararImagens(input);
    const j = await service.julgar('B', input, imgs);

    expect(create).toHaveBeenCalledTimes(2);
    expect(j.error).toMatch(/letra inexistente: Z/);
    expect(j.costUsd).toBeGreaterThan(0);
  });

  it('A e B recebem as candidatas em ordens diferentes', async () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    expect(embaralhar(ids, 'item-1:A')).not.toEqual(embaralhar(ids, 'item-1:B'));
    expect(embaralhar(ids, 'item-1:A')).toEqual(embaralhar(ids, 'item-1:A'));
  });

  it('usa alta resolução quando há fotos com o mesmo nome-base', () => {
    expect(
      precisaAltaResolucao([
        cand('1', 'Sadia - calabresa.png'),
        cand('2', 'Sadia - calabresa 002.png'),
      ]),
    ).toBe(true);
    expect(
      precisaAltaResolucao([cand('1', 'Sadia - calabresa.png'), cand('2', 'Sadia - paio.png')]),
    ).toBe(false);
  });

  it('a versão muda com o modelo (desliga o auto-aceite)', () => {
    const v1 = criar([]).service.version();
    const v2 = criar([], { EAN_JUDGE_MODEL_B: 'gpt-4.1' }).service.version();
    expect(v1).not.toBe(v2);
    expect(v1.startsWith(`${EAN_JUDGE_PROMPT_VERSION}:`)).toBe(true);
  });

  it('interpretar rejeita letra que não foi apresentada', () => {
    const mapa = new Map([['A', 'id-a']]);
    expect(
      interpretar('{"decision":"none","images":[],"labels":[],"reason":"x"}', mapa),
    ).toMatchObject({ decision: 'none' });
    expect(
      interpretar(
        '{"decision":"match","images":["B"],"labels":[{"image":"B","brand":null,"variant":null,"quantity":null}],"reason":"x"}',
        mapa,
      ),
    ).toEqual({ erro: 'letra inexistente: B' });
  });

  it('Juiz em Terra: o custo sai da tabela única (2.000 de entrada e 300 de saída = US$ 0,0035)', async () => {
    const { service } = criar(
      ['não é json'],
      { EAN_JUDGE_MODEL_A: 'gpt-6.1-terra', EAN_JUDGE_MAX_RETRIES: '0' },
      {
        prompt_tokens: 2000,
        completion_tokens: 300,
      },
    );
    const j = await service.julgar('A', input, await service.prepararImagens(input));
    expect(j.model).toBe('gpt-6.1-terra');
    expect(j.costUsd).toBeCloseTo(0.0035, 8);
  });

  it('Volta ao modelo de hoje: o mesmo uso custa US$ 0,008 pelo preço de hoje (2,5 e 10 por milhão)', async () => {
    const { service } = criar(
      ['não é json'],
      { EAN_JUDGE_MODEL_A: 'gpt-4o', EAN_JUDGE_MAX_RETRIES: '0' },
      {
        prompt_tokens: 2000,
        completion_tokens: 300,
      },
    );
    const j = await service.julgar('A', input, await service.prepararImagens(input));
    expect(j.costUsd).toBeCloseTo(0.008, 8);
  });

  describe('modelos e parâmetros por família', () => {
    it('Padrão Terra: os dois juízes chamam gpt-6.1-terra com esforço low, teto da família nova e prazo', async () => {
      const { service, create } = criar([NONE, NONE]);

      const a = await service.julgar('A', input, SEM_IMAGENS);
      const b = await service.julgar('B', input, SEM_IMAGENS);

      expect([a.model, b.model]).toEqual(['gpt-6.1-terra', 'gpt-6.1-terra']);
      const [body, options] = create.mock.calls[0];
      expect(body).toEqual({
        model: 'gpt-6.1-terra',
        reasoning_effort: 'low',
        max_completion_tokens: 4096,
        response_format: { type: 'json_object' },
        messages: expect.any(Array),
      });
      expect(options).toEqual({ timeout: 60_000, maxRetries: 0 });
    });

    it('Volta ao modelo de hoje: max_tokens 700 e temperature 0, sem esforço nem teto novo', async () => {
      const { service, create } = criar([NONE], { EAN_JUDGE_MODEL_A: 'gpt-4o' });

      await service.julgar('A', input, SEM_IMAGENS);

      const [body, options] = create.mock.calls[0];
      expect(body).toEqual({
        model: 'gpt-4o',
        max_tokens: 700,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: expect.any(Array),
      });
      expect(options).toEqual({ timeout: 60_000, maxRetries: 0 });
    });

    it('Juiz B segue o A quando a variável do B está vazia', async () => {
      const { service } = criar([NONE], { EAN_JUDGE_MODEL_A: 'gpt-6-luna', EAN_JUDGE_MODEL_B: '' });
      expect((await service.julgar('B', input, SEM_IMAGENS)).model).toBe('gpt-6-luna');
    });

    it('Variável vazia ou só com espaços vale o padrão Terra nos dois juízes', async () => {
      const { service } = criar([NONE, NONE], {
        EAN_JUDGE_MODEL_A: '   ',
        EAN_JUDGE_MODEL_B: '  ',
      });
      expect((await service.julgar('A', input, SEM_IMAGENS)).model).toBe('gpt-6.1-terra');
      expect((await service.julgar('B', input, SEM_IMAGENS)).model).toBe('gpt-6.1-terra');
    });

    it('Identidade nova: a versão muda quando o modelo troca de gpt-4o para gpt-6.1-terra', () => {
      const antiga = criar([], { EAN_JUDGE_MODEL_A: 'gpt-4o' }).service.version();
      expect(criar([]).service.version()).not.toBe(antiga);
    });
  });

  describe('custo e disponibilidade (requisito "Custo dos juízes de EAN")', () => {
    it('Modelo sem preço: o juiz fica indisponível e nenhuma chamada sai', async () => {
      const { service, create } = criar([], { EAN_JUDGE_MODEL_A: 'gpt-5-mini' });
      expect(service.isEnabled()).toBe(false);

      const j = await service.julgar('A', input, SEM_IMAGENS);

      expect(create).not.toHaveBeenCalled();
      expect(j).toMatchObject({
        decision: 'none',
        costUsd: 0,
        error: 'modelo sem preço na tabela: gpt-5-mini',
      });
    });

    it('Modelo sem preço: o log traz o motivo, uma vez, ao criar o juiz', () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      criar([], { EAN_JUDGE_MODEL_A: 'gpt-5-mini' });
      const lines = warn.mock.calls.map((call) => String(call[0]));
      warn.mockRestore();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('modelo sem preço na tabela (gpt-5-mini)');
    });

    it('Juiz B sem preço deixa o par indisponível; o A, com preço, ainda julga', async () => {
      const { service, create } = criar([NONE], { EAN_JUDGE_MODEL_B: 'gpt-5-mini' });
      expect(service.isEnabled()).toBe(false);

      const a = await service.julgar('A', input, SEM_IMAGENS);
      const b = await service.julgar('B', input, SEM_IMAGENS);

      expect(a.error).toBeUndefined();
      expect(b.error).toBe('modelo sem preço na tabela: gpt-5-mini');
      expect(create).toHaveBeenCalledTimes(1);
    });

    it('Com a chave e os dois modelos na tabela o juiz está disponível; sem a chave, não', () => {
      expect(criar([]).service.isEnabled()).toBe(true);
      expect(criar([], { EAN_JUDGE_MODEL_A: 'gpt-4o' }).service.isEnabled()).toBe(true);
      const semChave = { OPENAI_API_KEY: '', UPLOAD_DEST: dir } as Record<string, string>;
      const service = new EanJudgeService({
        get: (k: string, d?: string) => semChave[k] ?? d,
      } as never);
      expect(service.isEnabled()).toBe(false);
    });

    it('Resposta sem uso em Terra: o custo é o teto de saída (4.096) a US$ 5,00 por milhão, nunca zero', async () => {
      const { service } = criar([INVALIDA], { EAN_JUDGE_MAX_RETRIES: '0' }, null);
      const j = await service.julgar('A', input, SEM_IMAGENS);
      expect(j.costUsd).toBeCloseTo((4096 * 5) / 1e6, 8);
    });

    it('Resposta sem uso na volta: o teto de saída de hoje (700) a US$ 10 por milhão', async () => {
      const env = { EAN_JUDGE_MODEL_A: 'gpt-4o', EAN_JUDGE_MAX_RETRIES: '0' };
      const { service } = criar([INVALIDA], env, null);
      const j = await service.julgar('A', input, SEM_IMAGENS);
      expect(j.costUsd).toBeCloseTo((700 * 10) / 1e6, 8);
    });

    it('Cada tentativa soma o seu custo: a primeira com uso e a repetição sem uso', async () => {
      const { service, create } = criar([INVALIDA]);
      create.mockResolvedValueOnce({ choices: [{ message: { content: INVALIDA } }] });

      const j = await service.julgar('A', input, SEM_IMAGENS);

      expect(create).toHaveBeenCalledTimes(2);
      expect(j.costUsd).toBeCloseTo((2000 * 1 + 150 * 5) / 1e6 + (4096 * 5) / 1e6, 8);
    });
  });
});
