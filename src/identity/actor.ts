export type Actor = {
  id: string;
  supplier: string;
  role: 'operator' | 'reviewer';
};

export interface ActorDirectory {
  authenticate(key: string): Promise<Actor | null>;
}

export class RoleNotPermitted extends Error {}

export function requireRole(actor: Actor, role: Actor['role']): void {
  if (actor.role !== role) throw new RoleNotPermitted();
}
