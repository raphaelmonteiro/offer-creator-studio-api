import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as sharp from 'sharp';
import type { EanCandidateRecord } from './ean-match.types';
import {
  custoDe,
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

  function criar(respostas: string[], env: Record<string, string> = {}) {
    const vars: Record<string, string> = { OPENAI_API_KEY: 'sk-test', UPLOAD_DEST: dir, ...env };
    const service = new EanJudgeService({ get: (k: string, d?: string) => vars[k] ?? d } as never);
    const create = jest.fn();
    for (const r of respostas) {
      create.mockResolvedValueOnce({
        choices: [{ message: { content: r } }],
        usage: { prompt_tokens: 2000, completion_tokens: 150 },
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
    const { service, create } = criar([]);
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
    expect(v1).toMatch(/^ean-judge-v1:/);
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

  it('custo por modelo, com prefixo mais específico', () => {
    expect(
      custoDe('gpt-4o-mini-2024', { prompt_tokens: 1e6, completion_tokens: 0 } as never),
    ).toBeCloseTo(0.15);
    expect(custoDe('gpt-4o', { prompt_tokens: 1e6, completion_tokens: 0 } as never)).toBeCloseTo(
      2.5,
    );
  });
});
