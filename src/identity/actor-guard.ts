import {
  Injectable,
  UnauthorizedException,
  createParamDecorator,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';
import type { Actor } from './actor';
import { PostgresActors } from './postgres-actors';

type AuthenticatedRequest = Request & { actor?: Actor };

@Injectable()
export class ActorGuard {
  constructor(private readonly actors: PostgresActors) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const key = /^Bearer ([0-9a-f]{64})$/i.exec(request.headers.authorization ?? '')?.[1];
    if (!key) throw new UnauthorizedException();
    const actor = await this.actors.authenticate(key);
    if (!actor) throw new UnauthorizedException();
    request.actor = actor;
    return true;
  }
}

export const CurrentActor = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Actor => {
    const actor = context.switchToHttp().getRequest<AuthenticatedRequest>().actor;
    if (!actor) throw new UnauthorizedException();
    return actor;
  },
);
