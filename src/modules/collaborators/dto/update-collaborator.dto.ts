import { PartialType, OmitType } from '@nestjs/swagger';
import { CreateCollaboratorDto } from './create-collaborator.dto';

export class UpdateCollaboratorDto extends PartialType(
  OmitType(CreateCollaboratorDto, ['password'] as const),
) {}
