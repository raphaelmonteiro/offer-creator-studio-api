import { PipeTransform, Injectable, ArgumentMetadata } from '@nestjs/common';

@Injectable()
export class SkipValidationPipe implements PipeTransform {
  transform(value: any, metadata: ArgumentMetadata) {
    // Simply return the value without validation
    return value;
  }
}
