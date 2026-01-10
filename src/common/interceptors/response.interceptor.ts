import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

export interface Response<T> {
  success: boolean;
  data?: T;
  message?: string;
  pagination?: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
  error?: {
    code: string;
    message: string;
    details?: Array<{ field: string; message: string }>;
  };
}

@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<T, Response<T>> {
  intercept(context: ExecutionContext, next: CallHandler): Observable<Response<T>> {
    return next.handle().pipe(
      map((data) => {
        // If response already has success field, return as is
        if (data && typeof data === 'object' && 'success' in data) {
          return data;
        }

        // Extract pagination if exists
        let pagination = undefined;
        let responseData = data;

        if (data && typeof data === 'object' && 'data' in data && 'pagination' in data) {
          responseData = data.data;
          pagination = data.pagination;
        }

        return {
          success: true,
          data: responseData,
          ...(pagination && { pagination }),
        };
      }),
    );
  }
}
