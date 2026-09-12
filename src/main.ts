import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Logger, ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // The admin dashboard (a separate web app) calls this API cross-origin -
  // wide open since this is an internal tool on a local/private network,
  // not a public-facing service.
  app.enableCors();

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
