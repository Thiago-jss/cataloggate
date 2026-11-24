import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import type { Actor } from '../../identity/actor';
import { ActorGuard, CurrentActor } from '../../identity/actor-guard';
import { ImportOperations } from '../application/import-operations';

const retryPayload = z.strictObject({ expectedGeneration: z.int().min(1).max(6) });

@Controller()
@UseGuards(ActorGuard)
export class OperationsController {
  constructor(private readonly operations: ImportOperations) {}

  @Get('imports/:id/attempts')
  history(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.operations.history(actor, id.toLowerCase());
  }

  @Post('imports/:id/retry')
  @HttpCode(202)
  retry(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const parsed = retryPayload.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException('Expected an integer expectedGeneration between 1 and 6');
    return this.operations.retry(actor, id.toLowerCase(), parsed.data.expectedGeneration);
  }

  @Get('ops/metrics')
  metrics(@CurrentActor() actor: Actor) {
    return this.operations.metrics(actor);
  }
}
