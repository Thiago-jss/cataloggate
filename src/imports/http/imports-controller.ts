import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import type { Actor } from '../../identity/actor';
import { ActorGuard, CurrentActor } from '../../identity/actor-guard';
import { ReadImport, ReadReport } from '../application/import-queries';
import { SubmitImport, type SubmittedItems } from '../application/submit-import';

const submission = z.strictObject({
  supplier: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
  items: z.array(z.unknown()).min(1).max(500),
});
const uuid = z.uuid();

function readUuid(value: unknown, field: string): string {
  const valid = uuid.safeParse(value);
  if (!valid.success) throw new BadRequestException(field + ' must be a UUID');
  return valid.data.toLowerCase();
}

function readItems(items: unknown[]): SubmittedItems {
  const pending = items.map((value) => ({ value, level: 1 }));
  while (pending.length > 0) {
    const entry = pending.pop();
    if (!entry) break;
    const { value, level } = entry;
    if (level > 20) throw new BadRequestException('Items may not exceed 20 levels of nesting');
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new BadRequestException('Items must contain finite JSON numbers');
    }
    if (value !== null && typeof value === 'object') {
      for (const child of Object.values(value)) pending.push({ value: child, level: level + 1 });
    }
  }
  // Express parsed the body as JSON; this pass rules out non-finite numbers and excessive depth.
  return items as SubmittedItems;
}

@Controller('imports')
@UseGuards(ActorGuard)
export class ImportsController {
  constructor(
    private readonly submit: SubmitImport,
    private readonly current: ReadImport,
    private readonly report: ReadReport,
  ) {}

  @Post()
  @HttpCode(202)
  async register(
    @CurrentActor() actor: Actor,
    @Body() body: unknown,
    @Headers('idempotency-key') header: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const input = submission.safeParse(body);
    if (!input.success)
      throw new BadRequestException('Expected a supplier and an array containing 1–500 items');
    const key = readUuid(header, 'Idempotency-Key');
    const result = await this.submit.execute(
      actor,
      input.data.supplier,
      key,
      readItems(input.data.items),
    );
    res.location('/imports/' + result.id);
    return result;
  }

  @Get(':id')
  status(@CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.current.execute(readUuid(id, 'Import ID'), actor.supplier);
  }

  @Get(':id/report')
  details(@CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.report.execute(readUuid(id, 'Import ID'), actor.supplier);
  }
}

@Controller('health')
export class HealthController {
  @Get()
  status() {
    return { status: 'ok' };
  }
}
