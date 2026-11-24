import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import type { Actor } from '../../identity/actor';
import { ActorGuard, CurrentActor } from '../../identity/actor-guard';
import { CatalogReview } from '../application/catalog-review';

const approval = z.strictObject({ expectedVersion: z.int().min(0).max(2147483646) });

@Controller('imports/:id')
@UseGuards(ActorGuard)
export class ReviewsController {
  constructor(private readonly reviews: CatalogReview) {}

  @Get('preview')
  preview(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.reviews.preview(actor, id.toLowerCase());
  }

  @Post('publish')
  publish(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const parsed = approval.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Expected an integer expectedVersion');
    return this.reviews.publish(actor, id.toLowerCase(), parsed.data.expectedVersion);
  }

  @Get('release')
  release(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.reviews.release(actor, id.toLowerCase());
  }
}
