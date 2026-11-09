import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipValidation } from '../../common/decorators/skip-validation.decorator';
import { CurrentUser } from '../../common/decorators/user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { createFileInterceptor } from '../../common/utils/multer.util';
import { CreateSceneDto } from './dto/create-scene.dto';
import { DeriveFaceDto } from './dto/derive-face.dto';
import {
  GetSceneQueryDto,
  ListMessagesQueryDto,
  ListScenesQueryDto,
} from './dto/list-scenes-query.dto';
import { PatchElementsDto } from './dto/patch-elements.dto';
import { SendMessageDto } from './dto/send-message.dto';
import { RestoreVersionDto } from './dto/restore-version.dto';
import { FaceKey } from './domain/scene-faces';
import { sceneNotFound, versionNotFound } from './scene.errors';
import { SceneFacesService } from './services/scene-faces.service';
import { SceneLogoService } from './services/scene-logo.service';
import { SceneTurnService } from './services/scene-turn.service';
import { SceneVersionsService } from './services/scene-versions.service';
import { TemplateScenesService } from './services/template-scenes.service';
import { TemplateSceneEnabledGuard } from './template-scene-enabled.guard';

/** Id que não é UUID também é "cena não encontrada" (sem revelar nada além disso). */
export const SceneIdPipe = new ParseUUIDPipe({ exceptionFactory: () => sceneNotFound() });
export const VersionIdPipe = new ParseUUIDPipe({ exceptionFactory: () => versionNotFound() });

@ApiTags('template-scenes')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, TemplateSceneEnabledGuard)
@Controller('template-scenes')
export class TemplateScenesController {
  constructor(
    private readonly scenes: TemplateScenesService,
    private readonly versions: SceneVersionsService,
    private readonly logos: SceneLogoService,
    private readonly turns: SceneTurnService,
    private readonly faces: SceneFacesService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Cria uma cena num formato de impressão' })
  create(@Body() dto: CreateSceneDto, @CurrentUser() user: { id: string }) {
    return this.scenes.create(dto, user?.id ?? null);
  }

  @Get()
  @ApiOperation({ summary: 'Lista as cenas de todos os usuários (leve, paginada)' })
  list(@Query() query: ListScenesQueryDto) {
    return this.scenes.list(query.page, query.limit);
  }

  @Get(':id')
  @ApiOperation({
    summary:
      'Abre a cena: faces, versão atual, zonas, mensagens e versões (da face `face`, padrão a 0)',
  })
  get(@Param('id', SceneIdPipe) id: string, @Query() query: GetSceneQueryDto) {
    return this.scenes.get(id, query.versionsPage, query.face);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Exclui (logicamente) a cena e cancela a versão em curso' })
  async remove(@Param('id', SceneIdPipe) id: string): Promise<void> {
    await this.scenes.remove(id);
  }

  @Post(':id/versions/:versionId/restore')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Restaura uma versão antiga criando uma versão nova (filha)' })
  restore(
    @Param('id', SceneIdPipe) id: string,
    @Param('versionId', VersionIdPipe) versionId: string,
    @Body() dto: RestoreVersionDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.versions.restore(id, versionId, user?.id ?? null, dto?.expectedRevision);
  }

  @Patch(':id/elements')
  @ApiOperation({ summary: 'Edita as camadas à mão (versão manual aberta), sem chamar o modelo' })
  patchElements(
    @Param('id', SceneIdPipe) id: string,
    @Body() dto: PatchElementsDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.versions.patchElements(id, dto, user?.id ?? null);
  }

  @Post(':id/assets/logo')
  @HttpCode(HttpStatus.CREATED)
  @SkipValidation()
  @UseInterceptors(createFileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary:
      'Envia o logo da cena (PNG, JPEG ou WebP até 10 MB); o campo `face` do formulário escolhe a face',
  })
  uploadLogo(
    @Param('id', SceneIdPipe) id: string,
    @UploadedFile() file: Express.Multer.File,
    @Body('face') face?: string,
  ) {
    return this.logos.upload(id, file, face);
  }

  @Post(':id/faces/:faceKey/derive')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary:
      'Faz o verso (`back`, cena de frente e verso) ou a interna (`inner`, jornal) a partir da primeira face atual (assíncrono, uma chamada de imagem)',
  })
  deriveFace(
    @Param('id', SceneIdPipe) id: string,
    @Param('faceKey') faceKey: string,
    @Body() dto: DeriveFaceDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.faces.deriveFace(id, faceKey as FaceKey, {
      expectedRevision: dto.expectedRevision,
      userId: user?.id ?? null,
    });
  }

  @Post(':id/messages')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Envia uma mensagem; a primeira gera a cena (processamento assíncrono)',
  })
  sendMessage(
    @Param('id', SceneIdPipe) id: string,
    @Body() dto: SendMessageDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.turns.sendMessage(id, dto, user?.id ?? null);
  }

  @Get(':id/messages')
  @ApiOperation({ summary: 'Mensagens anteriores ao cursor `before`, em páginas, com `hasMore`' })
  messages(@Param('id', SceneIdPipe) id: string, @Query() query: ListMessagesQueryDto) {
    return this.scenes.messages(id, query);
  }

  @Post(':id/versions/:versionId/cancel')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Pede o cancelamento da versão em curso' })
  cancel(
    @Param('id', SceneIdPipe) id: string,
    @Param('versionId', VersionIdPipe) versionId: string,
  ) {
    return this.turns.cancel(id, versionId);
  }
}
