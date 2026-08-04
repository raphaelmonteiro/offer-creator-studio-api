import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../../common/decorators/user.decorator';
import { RenderJobsService } from '../services/render-jobs.service';
import { CreateRenderJobDto } from '../dto/create-render-job.dto';

@ApiTags('animations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('animations/renders')
export class RenderJobsController {
  constructor(private readonly renders: RenderJobsService) {}

  @Post()
  async create(@CurrentUser() user: { id: string }, @Body() dto: CreateRenderJobDto) {
    const { job, degradedMode, queuePosition } = await this.renders.create(user.id, dto);
    return { ...job, degradedMode, queuePosition };
  }

  @Get(':id')
  findOne(@CurrentUser() user: { id: string }, @Param('id', ParseUUIDPipe) id: string) {
    return this.renders.findOneWithDownload(user.id, id);
  }

  @Post(':id/cancel')
  cancel(@CurrentUser() user: { id: string }, @Param('id', ParseUUIDPipe) id: string) {
    return this.renders.cancel(user.id, id);
  }
}
