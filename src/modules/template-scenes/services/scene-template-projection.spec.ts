import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as sharp from 'sharp';
import { findSceneFormat } from '../domain/scene-formats';
import { sectionBands } from '../domain/scene-template-config';
import { projectionKeys } from '../domain/scene-template-keys';
import { TemplateImageElement, TemplateTextElement } from '../domain/scene-template.types';
import { SceneElement } from '../domain/scene.types';
import {
  layer,
  near,
  pixelOf,
  Rgb,
  solidPng,
  stripedMaster,
} from '../testing/scene-template-fixtures';
import { SceneFilesService } from './scene-files.service';
import { copyLogos, projectFull, ProjectionSource } from './scene-template-projection';
import { SceneTemplateFilesService } from './scene-template-files.service';

const FORMAT = findSceneFormat('folheto-27x54')!;
const W = 240;
const H = 480;
const RED: Rgb = [220, 20, 20];
const GREEN: Rgb = [20, 200, 20];
const BLUE: Rgb = [20, 20, 220];
const CDN = 'http://cdn.test/uploads';

describe('Projeção da cena em template (PV-1 a PV-5)', () => {
  let uploads: string;
  let files: SceneTemplateFilesService;
  const sceneId = randomUUID();
  const bands = sectionBands(FORMAT, H);

  beforeAll(async () => {
    uploads = await fs.mkdtemp(path.join(os.tmpdir(), 'scene-template-'));
    const config = new ConfigService({ UPLOAD_DEST: uploads, CDN_URL: CDN });
    files = new SceneTemplateFilesService(config, new SceneFilesService(config));
  });

  afterAll(() => fs.rm(uploads, { recursive: true, force: true }));

  const sourceOf = (elements: SceneElement[]): ProjectionSource => ({
    sceneId,
    name: 'Páscoa',
    format: FORMAT,
    widthPx: W,
    heightPx: H,
    versionId: randomUUID(),
    sceneRevision: 4,
    elements,
    keys: projectionKeys({ formatId: FORMAT.id, name: 'Páscoa', masterAssetId: 'm', elements }),
  });

  const fileOf = (url: string) => fs.readFile(path.join(uploads, url.replace(`${CDN}/`, '')));

  describe('Imagem sem esticar e emendas alinhadas', () => {
    it('fundo é a imagem inteira, fatias nas alturas das zonas e seções com a altura da fração', async () => {
      const master = await stripedMaster(W, H, bands);
      const { configuration, thumbnailUrl } = await projectFull(
        { source: sourceOf([]), master, overlays: [], logos: new Map() },
        files,
      );
      const { header, footer, bodyBackground } = configuration;
      expect(configuration.format).toBe('folheto-27x54');
      expect(header.widthCm).toBe(27.5);
      expect(header.heightCm).toBeCloseTo((6 / 54) * 55, 3);
      expect(footer.heightCm).toBeCloseTo((4 / 54) * 55, 3);
      expect(bodyBackground).toMatchObject({
        type: 'image',
        imageSize: 'cover',
        imageOpacity: 100,
      });

      const full = await fileOf(bodyBackground.imageUrl);
      const head = await fileOf(header.background.imageUrl);
      const foot = await fileOf(footer.background.imageUrl);
      expect(await sharp(full).metadata()).toMatchObject({ format: 'jpeg', width: W, height: H });
      expect(await sharp(head).metadata()).toMatchObject({ width: W, height: bands.headerPx });
      expect(await sharp(foot).metadata()).toMatchObject({ width: W, height: bands.footerPx });
      expect(bands.headerPx).toBe(Math.round(H * (6 / 54)));

      // a fatia é o pedaço da mesma imagem: a emenda não tem degrau
      expect(near(await pixelOf(head, W / 2, bands.headerPx - 1), RED)).toBe(true);
      expect(near(await pixelOf(full, W / 2, bands.headerPx - 1), RED)).toBe(true);
      expect(near(await pixelOf(full, W / 2, bands.headerPx + 1), GREEN)).toBe(true);
      expect(near(await pixelOf(foot, W / 2, 0), BLUE)).toBe(true);
      expect(near(await pixelOf(full, W / 2, H - bands.footerPx), BLUE)).toBe(true);
      expect(near(await pixelOf(full, W / 2, H - bands.footerPx - 2), GREEN)).toBe(true);
      expect(thumbnailUrl).toMatch(
        /^http:\/\/cdn\.test\/uploads\/templates\/scene-.+\/thumbnail\.jpg$/,
      );
      // lado maior até 512 px, sem ampliar a master de teste (240x480)
      expect(await sharp(await fileOf(thumbnailUrl)).metadata()).toMatchObject({
        width: W,
        height: H,
      });
    });

    it('cada projeção grava numa pasta nova e a anterior fica', async () => {
      const master = await stripedMaster(W, H, bands);
      const input = {
        source: sourceOf([]),
        master,
        overlays: [],
        logos: new Map<string, string>(),
      };
      const first = await projectFull(input, files);
      const second = await projectFull(input, files);
      expect(second.configuration.bodyBackground.imageUrl).not.toBe(
        first.configuration.bodyBackground.imageUrl,
      );
      await expect(fileOf(first.configuration.bodyBackground.imageUrl)).resolves.toBeInstanceOf(
        Buffer,
      );
    });
  });

  describe('Logo e texto como elementos', () => {
    it('logo no cabeçalho e texto no rodapé viram elements, em px de prévia, e não entram na imagem', async () => {
      const logoAssetId = randomUUID();
      const logoUrl = `/uploads/template-scenes/${sceneId}/${randomUUID()}/logo.png`;
      const logoPath = path.join(uploads, logoUrl.replace('/uploads/', ''));
      await fs.mkdir(path.dirname(logoPath), { recursive: true });
      await fs.writeFile(logoPath, await solidPng(60, 30, [250, 250, 0]));
      const elements = [
        layer({
          id: 'logo-1',
          kind: 'logo',
          name: 'Logo',
          assetId: logoAssetId,
          x: 0.25,
          y: 0.05,
          w: 0.3,
          aspect: 2,
          z: 2,
        }),
        layer({
          id: 'text-1',
          text: 'Ofertas da semana',
          x: 0.5,
          y: 0.96,
          w: 0.6,
          aspect: 5,
          fontSize: 7,
          fontFamily: 'Georgia',
          color: '#ffffff',
          z: 3,
        }),
      ];
      const source = sourceOf(elements);
      const logos = await copyLogos(source, [{ id: logoAssetId, url: logoUrl }], files);
      const { configuration } = await projectFull(
        { source, master: await stripedMaster(W, H, bands), overlays: [], logos },
        files,
      );

      const logo = configuration.header.elements[0] as TemplateImageElement;
      expect(logo).toMatchObject({ type: 'image', objectFit: 'contain', zIndex: 2 });
      expect(logo.src).toBe(logos.get(logoAssetId));
      expect(logo.src).toContain(`/templates/scene-${sceneId}/logos/${logoAssetId}.png`);
      await expect(fileOf(logo.src)).resolves.toBeInstanceOf(Buffer);
      // 27,5 cm a 72 DPI = 780 px: largura 30% = 234 px, x = 25% * 780 - 117 = 78
      expect(logo.width).toBeCloseTo(234, 1);
      expect(logo.height).toBeCloseTo(117, 1);
      expect(logo.x).toBeCloseTo(78, 1);
      const text = configuration.footer.elements[0] as TemplateTextElement;
      expect(text).toMatchObject({
        type: 'text',
        content: 'Ofertas da semana',
        textAlign: 'center',
        fontFamily: 'Georgia',
        color: '#ffffff',
      });
      expect(text.fontSize).toBeCloseTo((7 * 780) / 100, 1);
      expect(configuration.header.elements).toHaveLength(1);
      expect(configuration.footer.elements).toHaveLength(1);

      const full = await fileOf(configuration.bodyBackground.imageUrl);
      expect(near(await pixelOf(full, 0.25 * W, 0.05 * H), RED)).toBe(true);
    });

    it('a cópia da logo é reaproveitada: o mesmo asset não grava de novo', async () => {
      const assetId = randomUUID();
      const url = `/uploads/template-scenes/${sceneId}/${randomUUID()}/logo.png`;
      const abs = path.join(uploads, url.replace('/uploads/', ''));
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, await solidPng(10, 10, RED));
      const source = sourceOf([layer({ id: 'l', kind: 'logo', assetId })]);
      const first = await copyLogos(source, [{ id: assetId, url }], files);
      const copy = path.join(uploads, first.get(assetId)!.replace(`${CDN}/`, ''));
      const before = (await fs.stat(copy)).mtimeMs;
      await new Promise((resolve) => setTimeout(resolve, 20));
      const second = await copyLogos(source, [{ id: assetId, url }], files);
      expect(second.get(assetId)).toBe(first.get(assetId));
      expect((await fs.stat(copy)).mtimeMs).toBe(before);
    });
  });

  describe('Elemento adicionado é achatado', () => {
    it('o PNG transparente entra na imagem, na posição e no tamanho, e não vira elemento', async () => {
      const element = layer({
        id: 'sol',
        kind: 'generated',
        assetId: randomUUID(),
        x: 0.5,
        y: 0.5,
        w: 0.5,
        aspect: 1,
        z: 4,
      });
      const { configuration } = await projectFull(
        {
          source: sourceOf([element]),
          master: await stripedMaster(W, H, bands),
          overlays: [{ element, buffer: await solidPng(50, 50, [250, 250, 0]) }],
          logos: new Map(),
        },
        files,
      );
      const full = await fileOf(configuration.bodyBackground.imageUrl);
      expect(near(await pixelOf(full, W / 2, H / 2), [250, 250, 0])).toBe(true);
      // 50% da largura = 120 px: o canto de dentro é do elemento e o de fora continua verde
      expect(near(await pixelOf(full, W / 2 + 55, H / 2 + 55), [250, 250, 0])).toBe(true);
      expect(near(await pixelOf(full, W / 2 + 70, H / 2), GREEN)).toBe(true);
      expect(configuration.header.elements).toHaveLength(0);
      expect(configuration.footer.elements).toHaveLength(0);
    });

    it('elemento que passa da borda é cortado sem falhar, e o que cai no cabeçalho cobre a fatia dele', async () => {
      const element = layer({
        id: 'nuvem',
        kind: 'generated',
        assetId: randomUUID(),
        x: 0.02,
        y: 0.02,
        w: 0.4,
        aspect: 1,
        rotation: 30,
        z: 1,
      });
      const { configuration } = await projectFull(
        {
          source: sourceOf([element]),
          master: await stripedMaster(W, H, bands),
          overlays: [{ element, buffer: await solidPng(40, 40, [250, 250, 0]) }],
          logos: new Map(),
        },
        files,
      );
      const head = await fileOf(configuration.header.background.imageUrl);
      expect(near(await pixelOf(head, 4, 4), [250, 250, 0])).toBe(true);
    });
  });

  describe('Camada no miolo', () => {
    it('texto com centro no miolo fica fora do template e a projeção não falha', async () => {
      const elements = [layer({ id: 'feliz', text: 'Feliz Páscoa', y: 0.5, fontSize: 7 })];
      const { configuration } = await projectFull(
        {
          source: sourceOf(elements),
          master: await stripedMaster(W, H, bands),
          overlays: [],
          logos: new Map(),
        },
        files,
      );
      expect(JSON.stringify(configuration)).not.toContain('Feliz Páscoa');
      expect(configuration.header.elements).toEqual([]);
      expect(configuration.footer.elements).toEqual([]);
    });
  });

  it('o marcador de origem leva a cena, a versão, a revisão e as impressões digitais', async () => {
    const source = sourceOf([]);
    const { configuration } = await projectFull(
      { source, master: await stripedMaster(W, H, bands), overlays: [], logos: new Map() },
      files,
    );
    expect(configuration.source).toMatchObject({
      kind: 'template-scene',
      sceneId,
      versionId: source.versionId,
      sceneRevision: 4,
      pictorialKey: source.keys.pictorialKey,
      fingerprint: source.keys.fingerprint,
      projectionVersion: 1,
    });
    expect(new Date(configuration.source.syncedAt).toString()).not.toBe('Invalid Date');
  });
});
