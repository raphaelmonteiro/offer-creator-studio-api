import { PipeTransform, Injectable, ArgumentMetadata } from '@nestjs/common';

@Injectable()
export class SkipValidationPipe implements PipeTransform {
  transform(value: any, _metadata: ArgumentMetadata) {
    // Simply return the value without validation
    return value;
  }
}
