import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { Request, Response } from 'express';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const ctx = context.switchToHttp();
    const request = ctx.getRequest<Request>();
    const response = ctx.getResponse<Response>();
    const { method, originalUrl, ip } = request;
    const userAgent = request.get('user-agent') || 'unknown';
    const startTime = Date.now();

    // Build sanitized request body once (shared between success and error paths)
    const getSanitizedBody = () => {
      if (!['POST', 'PUT', 'PATCH'].includes(method) || !request.body) {
        return undefined;
      }
      if (typeof request.body !== 'object') {
        return request.body;
      }
      const sanitizedBody: Record<string, any> = {};
      for (const [key, value] of Object.entries(request.body as Record<string, any>)) {
        if (key.toLowerCase().includes('password')) {
          sanitizedBody[key] = '***REDACTED***';
        } else {
          sanitizedBody[key] = value;
        }
      }
      return sanitizedBody;
    };

    return next.handle().pipe(
      tap({
        next: (data: any) => {
          const statusCode = response.statusCode;
          const duration = Date.now() - startTime;

          const logData: Record<string, any> = {
            method,
            url: originalUrl,
            statusCode,
            duration: `${duration}ms`,
            ip,
            userAgent,
          };

          const body = getSanitizedBody();
          if (body) logData.body = body;

          // Log response for auth endpoints (truncate tokens)
          if (originalUrl.startsWith('/api/auth') && data && typeof data === 'object') {
            const sanitizedResponse = { ...data };
            if (sanitizedResponse.accessToken) {
              sanitizedResponse.accessToken =
                sanitizedResponse.accessToken.substring(0, 20) + '...';
            }
            logData.response = sanitizedResponse;
          }

          // Log response for quiz endpoints
          if (originalUrl.startsWith('/api/quiz') && data) {
            logData.response = data;
          }

          // Log response for 4xx errors
          if (statusCode >= 400 && data) {
            logData.response = data;
          }

          this.logger.log(JSON.stringify(logData));
        },
        error: (error: any) => {
          const duration = Date.now() - startTime;
          const statusCode = error.status || 500;

          const logData: Record<string, any> = {
            method,
            url: originalUrl,
            statusCode,
            duration: `${duration}ms`,
            ip,
            userAgent,
          };

          // ALWAYS include the request body on errors so we know what was received
          const body = getSanitizedBody();
          if (body) logData.body = body;

          // Include full error message with validation details
          logData.error = {
            message: error.message,
          };

          // For NestJS validation errors, include the full response object
          if (error.response) {
            logData.error.response = error.response;
          }

          // Include concise stack trace for debugging
          if (error.stack) {
            logData.error.stack = error.stack
              .split('\n')
              .slice(0, 3)
              .join(' | ');
          }

          this.logger.error(JSON.stringify(logData));
        },
      }),
    );
  }
}