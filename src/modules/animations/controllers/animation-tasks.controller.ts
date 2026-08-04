import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../../common/decorators/user.decorator';
import { AnimationTasksService } from '../services/animation-tasks.service';
import { CreateAnimationTaskDto } from '../dto/create-animation-task.dto';

@ApiTags('animations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('animations/tasks')
export class AnimationTasksController {
  constructor(private readonly tasksService: AnimationTasksService) {}

  @Post()
  create(@CurrentUser() user: { id: string }, @Body() dto: CreateAnimationTaskDto) {
    return this.tasksService.create(user.id, dto);
  }

  @Get()
  findAll(
    @CurrentUser() user: { id: string },
    @Query('status') status?: string,
    @Query('type') type?: string,
  ) {
    return this.tasksService.findAll(user.id, { status, type });
  }

  @Get(':id')
  findOne(@CurrentUser() user: { id: string }, @Param('id', ParseUUIDPipe) id: string) {
    return this.tasksService.findOne(user.id, id);
  }

  @Post(':id/retry')
  retry(@CurrentUser() user: { id: string }, @Param('id', ParseUUIDPipe) id: string) {
    return this.tasksService.retry(user.id, id);
  }

  @Post(':id/cancel')
  cancel(@CurrentUser() user: { id: string }, @Param('id', ParseUUIDPipe) id: string) {
    return this.tasksService.cancel(user.id, id);
  }
}
