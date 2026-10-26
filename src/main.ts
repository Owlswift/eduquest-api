import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Logger, ValidationPipe } from '@nestjs/common';
import helmet from 'helmet';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';

async function bootstrap() {
  // Fail fast: without this every token would be signed/verified with an
  // undefined secret.
  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET must be set');
  }

  const app = await NestFactory.create(AppModule);

  // JSON API: the CSP header adds nothing here and would break the
  // Swagger UI, so only that one is off.
  app.use(helmet({ contentSecurityPolicy: false }));

  // Browser callers (the admin dashboard) must be listed in CORS_ORIGINS
  // (comma-separated). Native mobile clients don't use CORS. With the
  // variable unset, development stays open and production allows no
  // cross-origin browser access.
  const corsOrigins = (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  app.enableCors({
    origin: corsOrigins.length > 0 ? corsOrigins : process.env.NODE_ENV !== 'production',
  });

  // Enable global validation for DTOs
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Enable global request/response logging
  app.useGlobalInterceptors(new LoggingInterceptor());

  // Set global API prefix
  app.setGlobalPrefix('api');

  // Swagger UI - browsable API docs, including bearer-auth so requests can
  // be tried directly from the browser after logging in once via the "Authorize" button.
  const swaggerConfig = new DocumentBuilder()
    .setTitle('EduQuest API')
    .setDescription(
      'EduQuest backend API, including the curriculum PDF import pipeline',
    )
    .setVersion('1.0')
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      'access-token',
    )
    .build();
  const swaggerDocument = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, swaggerDocument);

  const port = process.env.PORT ?? 3000;
  const logger = new Logger('Bootstrap');

  await app.listen(port, '0.0.0.0');
  logger.log(`EduQuest API running on http://0.0.0.0:${port}`);
  logger.log(`Swagger docs at http://0.0.0.0:${port}/api/docs`);
  logger.log('Environment:', process.env.NODE_ENV);
}
bootstrap();
