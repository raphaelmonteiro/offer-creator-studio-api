import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, ILike, IsNull, Repository } from 'typeorm';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as sharp from 'sharp';
import { paginate } from '../../common/utils/pagination.util';
import { UploadsService } from '../uploads/uploads.service';
import { BackgroundRemovalService } from '../ai/background-removal.service';
import { MascotRigService } from './services/mascot-rig.service';
import { MascotRig, isMascotRig } from './domain/rig.types';
import { RigValidationError, parseRig } from './domain/rig-validation';
import { Mascot } from './entities/mascot.entity';
import { MascotPreviewQueryDto, QueryMascotsDto, UpdateMascotDto } from './dto/mascot.dto';
import {
  MASCOT_CRAFT,
  MascotEntrance,
  MascotGesture,
  MascotPresenceTimeline,
  buildPresenceTimeline,
  isMascotEntrance,
  isMascotGesture,
} from './domain/presence-animation';

const UPLOAD_FOLDER = 'mascots';
const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
const ACCEPTED_MIME = ['image/png', 'image/webp'];
const PREVIEW_MAX_SIZE = 512;
const DEFAULT_PREVIEW_DURATION_MS = 6000;

export interface MascotView extends Mascot {
  /**
   * Caminho `/uploads/*` do recorte, pronto para virar camada de render
   * (o RenderLayerDto recusa URL externa — anti-SSRF, TDD §4.1).
   */
  renderUrl: string | null;
  /** `true` quando o mascote pode ser usado numa arte. */
  usable: boolean;
  /** `true` quando o mascote já foi desmontado em peças (rig 2D). */
  hasRig: boolean;
}

@Injectable()
export class MascotsService {
  private readonly logger = new Logger(MascotsService.name);

  constructor(
    @InjectRepository(Mascot) private readonly repo: Repository<Mascot>,
    private readonly uploads: UploadsService,
    private readonly backgroundRemoval: BackgroundRemovalService,
    private readonly rigService: MascotRigService,
    private readonly config: ConfigService,
  ) {}

  // ────────────────────────────── criação ──────────────────────────────

  /**
   * Upload do PNG do mascote.
   *
   * O arquivo enviado vira `sourceImageUrl` e **nunca mais é tocado** — recorte
   * e preview são arquivos derivados (spike §8.1). Quando o PNG já chega com
   * canal alpha, o recorte é uma CÓPIA byte a byte do original: continua sendo
   * um derivado (a fonte permanece intacta) e o mascote fica utilizável sem
   * depender de nenhuma API paga.
   */
  async create(
    userId: string,
    file: Express.Multer.File,
    fields: { name?: string; clientId?: string; rightsConfirmed?: unknown },
  ): Promise<MascotView> {
    if (!file?.buffer) {
      throw new BadRequestException({
        code: 'FILE_REQUIRED',
        message: 'Envie a imagem do mascote (PNG com fundo transparente, de preferência).',
      });
    }
    if (!ACCEPTED_MIME.includes(file.mimetype)) {
      throw new BadRequestException({
        code: 'INVALID_MASCOT_FILE',
        message: 'Formato não suportado. Envie o mascote em PNG ou WebP.',
      });
    }
    if (file.size > MAX_SOURCE_BYTES) {
      throw new BadRequestException({
        code: 'FILE_TOO_LARGE',
        message: 'A imagem do mascote excede o limite de 10 MB.',
      });
    }
    const name = String(fields.name ?? '').trim();
    if (name.length < 2 || name.length > 120) {
      throw new BadRequestException({
        code: 'MISSING_FIELDS',
        message: 'Informe um nome para o mascote (entre 2 e 120 caracteres).',
      });
    }

    let meta: sharp.Metadata;
    try {
      meta = await sharp(file.buffer).metadata();
    } catch {
      throw new BadRequestException({
        code: 'INVALID_MASCOT_FILE',
        message: 'Não foi possível ler a imagem enviada. Verifique o arquivo e tente de novo.',
      });
    }

    const source = await this.uploads.uploadFile(file, UPLOAD_FOLDER);
    const hasAlpha = Boolean(meta.hasAlpha);

    const previewUrl = await this.derivePreview(file.buffer, source.id);
    const cutoutUrl = hasAlpha ? await this.deriveCutoutFromAlpha(file.buffer, source.id) : null;

    const rightsConfirmed = this.parseBoolean(fields.rightsConfirmed);
    const mascot = this.repo.create({
      userId,
      clientId: fields.clientId || null,
      name,
      sourceImageUrl: source.url,
      cutoutUrl,
      previewUrl,
      width: meta.width ?? null,
      height: meta.height ?? null,
      hasAlpha,
      rig: {},
      rigVersion: 1,
      metadata: {
        originalFilename: file.originalname,
        sourceMimeType: file.mimetype,
        cutoutSource: cutoutUrl ? 'alpha-original' : null,
      },
      rightsConfirmedAt: rightsConfirmed ? new Date() : null,
      rightsConfirmedBy: rightsConfirmed ? userId : null,
      status: 'draft',
    });
    mascot.status = this.resolveStatus(mascot);
    return this.toView(await this.repo.save(mascot));
  }

  // ─────────────────────────────── recorte ───────────────────────────────

  /**
   * Recorte de fundo REUSANDO `background-removal.service` (Replicate).
   * Só transforma pixels no sentido de remover fundo — nunca redesenha.
   */
  async removeBackground(userId: string, id: string): Promise<MascotView> {
    const mascot = await this.getOwned(userId, id);
    if (!this.backgroundRemoval.isAvailable()) {
      throw new BadRequestException({
        code: 'BACKGROUND_REMOVAL_UNAVAILABLE',
        message:
          'O recorte automático está indisponível no servidor. Envie o mascote já em PNG com fundo transparente.',
      });
    }

    const buffer = await this.readLocalFile(mascot.sourceImageUrl);
    if (!buffer) {
      throw new BadRequestException({
        code: 'MASCOT_SOURCE_MISSING',
        message: 'A imagem original do mascote não foi encontrada. Envie o arquivo novamente.',
      });
    }

    const previous = mascot.status;
    mascot.status = 'segmenting';
    await this.repo.save(mascot);

    try {
      const result = await this.backgroundRemoval.removeBackground(
        {
          buffer,
          originalname: `${this.slug(mascot.name)}.png`,
          size: buffer.length,
          mimetype: 'image/png',
          fieldname: 'file',
          encoding: '7bit',
        } as Express.Multer.File,
        UPLOAD_FOLDER,
      );
      mascot.cutoutUrl = result.url;
      mascot.hasAlpha = true;
      mascot.metadata = { ...mascot.metadata, cutoutSource: 'background-removal.service' };
      mascot.status = this.resolveStatus(mascot);
      return this.toView(await this.repo.save(mascot));
    } catch (error) {
      this.logger.error(`Recorte do mascote ${id} falhou: ${(error as Error).message}`);
      mascot.status = previous === 'ready' ? 'ready' : 'failed';
      await this.repo.save(mascot);
      throw error;
    }
  }

  // ────────────────────────── aceite de direitos ──────────────────────────

  async confirmRights(userId: string, id: string, note?: string): Promise<MascotView> {
    const mascot = await this.getOwned(userId, id);
    if (!mascot.rightsConfirmedAt) {
      mascot.rightsConfirmedAt = new Date();
      mascot.rightsConfirmedBy = userId;
      mascot.metadata = { ...mascot.metadata, ...(note ? { rightsNote: note } : {}) };
    }
    mascot.status = this.resolveStatus(mascot);
    return this.toView(await this.repo.save(mascot));
  }

  // ────────────────────────────── rig 2D ──────────────────────────────

  /**
   * Desmonta o mascote em peças (fatia 1 da Fase 3).
   *
   * Roda síncrono de propósito: é geometria pura sobre o recorte, sem IA e sem
   * rede — alguns segundos no pior caso. Sai em `needs_review` porque o rig
   * automático é um palpite; quem aprova é o usuário, no editor.
   */
  async prepareRig(userId: string, id: string): Promise<{ mascot: MascotView; rig: MascotRig }> {
    const mascot = await this.getOwned(userId, id);
    if (!mascot.cutoutUrl) {
      throw new BadRequestException({
        code: 'MASCOT_WITHOUT_CUTOUT',
        message:
          'Faça o recorte do fundo antes de montar o rig — as peças são cortadas a partir dele.',
      });
    }
    const cutout = await this.readLocalFile(mascot.cutoutUrl);
    if (!cutout) {
      throw new BadRequestException({
        code: 'MASCOT_CUTOUT_MISSING',
        message: 'O recorte do mascote não foi encontrado. Rode o recorte de fundo novamente.',
      });
    }

    const previous = mascot.status;
    mascot.status = 'segmenting';
    await this.repo.save(mascot);

    try {
      const rig = await this.rigService.buildRig(cutout, mascot.name);
      mascot.rig = rig as unknown as Record<string, unknown>;
      mascot.status = 'needs_review';
      const saved = await this.repo.save(mascot);
      return { mascot: this.toView(saved), rig };
    } catch (error) {
      this.logger.error(`Rig do mascote ${id} falhou: ${(error as Error).message}`);
      mascot.status = previous;
      await this.repo.save(mascot);
      throw error;
    }
  }

  async getRig(userId: string, id: string): Promise<{ mascot: MascotView; rig: MascotRig | null }> {
    const mascot = await this.getOwned(userId, id);
    return {
      mascot: this.toView(mascot),
      rig: isMascotRig(mascot.rig) ? (mascot.rig as unknown as MascotRig) : null,
    };
  }

  /**
   * Salva o rig conferido no editor.
   *
   * Regra do spike §6.1: **o rig é imutável depois de `ready`**. Editar um rig
   * já aprovado cria `rigVersion + 1`, para que campanhas antigas possam ser
   * regeradas com o rig da época em vez do rig atual.
   */
  async saveRig(
    userId: string,
    id: string,
    input: unknown,
  ): Promise<{ mascot: MascotView; rig: MascotRig }> {
    const mascot = await this.getOwned(userId, id);
    let rig: MascotRig;
    try {
      rig = parseRig(input);
    } catch (error) {
      if (error instanceof RigValidationError) {
        throw new BadRequestException({
          code: 'INVALID_RIG',
          message: error.message,
          ...(error.field ? { field: error.field } : {}),
        });
      }
      throw error;
    }

    const wasApproved = mascot.status === 'ready' && isMascotRig(mascot.rig);
    if (wasApproved) mascot.rigVersion += 1;

    mascot.rig = { ...rig, source: 'manual' } as unknown as Record<string, unknown>;
    mascot.status = this.resolveStatus(mascot, false);
    const saved = await this.repo.save(mascot);
    this.logger.log(
      `Rig do mascote ${id} salvo na versão ${saved.rigVersion} (${rig.layers.length} peças).`,
    );
    return { mascot: this.toView(saved), rig: saved.rig as unknown as MascotRig };
  }

  // ──────────────────────────────── CRUD ────────────────────────────────

  async findAll(userId: string, query: QueryMascotsDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where: FindOptionsWhere<Mascot> = {
      userId,
      ...(query.clientId && { clientId: query.clientId }),
      ...(query.status && { status: query.status as Mascot['status'] }),
      ...(query.search && { name: ILike(`%${query.search}%`) }),
      ...(query.includeArchived === 'true' ? {} : { archivedAt: IsNull() }),
    };
    const [items, total] = await this.repo.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return paginate(
      items.map((m) => this.toView(m)),
      total,
      { page, limit },
    );
  }

  async findOne(userId: string, id: string): Promise<MascotView> {
    return this.toView(await this.getOwned(userId, id));
  }

  async update(userId: string, id: string, dto: UpdateMascotDto): Promise<MascotView> {
    const mascot = await this.getOwned(userId, id);
    if (dto.name !== undefined) mascot.name = dto.name.trim();
    if (dto.clientId !== undefined) mascot.clientId = dto.clientId || null;
    return this.toView(await this.repo.save(mascot));
  }

  async archive(userId: string, id: string, archived: boolean): Promise<MascotView> {
    const mascot = await this.getOwned(userId, id);
    mascot.archivedAt = archived ? new Date() : null;
    return this.toView(await this.repo.save(mascot));
  }

  // ─────────────────────────────── preview ───────────────────────────────

  /**
   * Timeline de presença (sem IA) para o preview do editor e para o render.
   * A MESMA função roda no browser — ver o espelho em
   * `frontend/src/utils/mascot/presenceAnimation.ts`.
   */
  async preview(
    userId: string,
    id: string,
    query: MascotPreviewQueryDto,
  ): Promise<{
    mascot: MascotView;
    timeline: MascotPresenceTimeline;
    craft: typeof MASCOT_CRAFT;
    warnings: string[];
  }> {
    const mascot = await this.getOwned(userId, id);
    const view = this.toView(mascot);
    const warnings: string[] = [];
    if (!mascot.rightsConfirmedAt) {
      warnings.push(
        'Confirme a titularidade ou licença de uso da marca antes de publicar este mascote.',
      );
    }
    if (!mascot.cutoutUrl) {
      warnings.push(
        'Este mascote ainda não tem recorte. Rode o recorte de fundo ou envie um PNG transparente.',
      );
    }

    const gesture: MascotGesture = isMascotGesture(query.gesture) ? query.gesture : 'idle_bounce';
    const entrance: MascotEntrance = isMascotEntrance(query.entrance) ? query.entrance : 'none';
    const timeline = buildPresenceTimeline({
      durationMs: query.durationMs ?? DEFAULT_PREVIEW_DURATION_MS,
      gesture,
      entrance,
      intensity: query.intensity,
    });
    return { mascot: view, timeline, craft: MASCOT_CRAFT, warnings };
  }

  // ─────────────────────────────── internos ───────────────────────────────

  private async getOwned(userId: string, id: string): Promise<Mascot> {
    const mascot = await this.repo.findOne({ where: { id } });
    if (!mascot) throw new NotFoundException('Mascote não encontrado.');
    if (mascot.userId !== userId) {
      throw new ForbiddenException('Este mascote pertence a outro usuário.');
    }
    return mascot;
  }

  /**
   * `ready` exige recorte E aceite de direitos. Sem o aceite o mascote fica em
   * `draft` — é o portão do requisito legal (spike risco 4).
   */
  private resolveStatus(mascot: Mascot, keepReview = true): Mascot['status'] {
    if (mascot.status === 'failed' && !mascot.cutoutUrl) return 'failed';
    if (!mascot.cutoutUrl || !mascot.rightsConfirmedAt) return 'draft';
    // rig recém-montado espera a conferência do usuário no editor
    if (keepReview && mascot.status === 'needs_review') return 'needs_review';
    return 'ready';
  }

  private toView(mascot: Mascot): MascotView {
    return {
      ...mascot,
      renderUrl: this.toUploadsPath(mascot.cutoutUrl),
      usable: mascot.status === 'ready' && !mascot.archivedAt,
      hasRig: isMascotRig(mascot.rig),
    };
  }

  /** Miniatura derivada — só redimensiona, preserva o alpha. */
  private async derivePreview(buffer: Buffer, sourceFileName: string): Promise<string | null> {
    try {
      const resized = await sharp(buffer)
        .resize(PREVIEW_MAX_SIZE, PREVIEW_MAX_SIZE, { fit: 'inside', withoutEnlargement: true })
        .png()
        .toBuffer();
      const upload = await this.uploads.uploadFile(
        {
          buffer: resized,
          originalname: `preview-${sourceFileName}`,
          size: resized.length,
          mimetype: 'image/png',
          fieldname: 'file',
          encoding: '7bit',
        } as Express.Multer.File,
        UPLOAD_FOLDER,
      );
      return upload.url;
    } catch (error) {
      this.logger.warn(`Preview do mascote não pôde ser gerado: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * PNG já veio com alpha: o "recorte" é uma cópia do original salva como
   * arquivo derivado. Nenhum pixel é reescrito e `sourceImageUrl` continua
   * apontando para o arquivo enviado.
   */
  private async deriveCutoutFromAlpha(
    buffer: Buffer,
    sourceFileName: string,
  ): Promise<string | null> {
    try {
      const upload = await this.uploads.uploadFile(
        {
          buffer,
          originalname: `cutout-${sourceFileName}`,
          size: buffer.length,
          mimetype: 'image/png',
          fieldname: 'file',
          encoding: '7bit',
        } as Express.Multer.File,
        UPLOAD_FOLDER,
      );
      return upload.url;
    } catch (error) {
      this.logger.warn(`Recorte derivado do alpha falhou: ${(error as Error).message}`);
      return null;
    }
  }

  /** `http://host/uploads/mascots/x.png` → `/uploads/mascots/x.png`. */
  private toUploadsPath(url: string | null): string | null {
    if (!url) return null;
    if (url.startsWith('/uploads/')) return url;
    const marker = '/uploads/';
    const index = url.indexOf(marker);
    return index >= 0 ? url.slice(index) : null;
  }

  /** Lê de volta um arquivo do bucket local a partir da URL persistida. */
  private async readLocalFile(url: string): Promise<Buffer | null> {
    const uploadsPath = this.toUploadsPath(url);
    if (!uploadsPath) return null;
    const uploadsDir = path.resolve(this.config.get<string>('UPLOAD_DEST', './uploads'));
    const filePath = path.resolve(uploadsDir, uploadsPath.replace(/^\/uploads\//, ''));
    if (!filePath.startsWith(uploadsDir + path.sep)) return null;
    try {
      return await fs.readFile(filePath);
    } catch {
      return null;
    }
  }

  private parseBoolean(value: unknown): boolean {
    return value === true || value === 'true' || value === '1' || value === 1;
  }

  private slug(value: string): string {
    return (
      value
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/gi, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60)
        .toLowerCase() || 'mascote'
    );
  }
}
