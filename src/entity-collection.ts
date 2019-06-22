import { SyncableEntity } from './syncable-entity';

type EntityId = string;

/**
 * Contains entities, allowing retrieval by entity ID.
 */
export class EntityCollection {
  /** These compose the state of the game. */
  private entities: Map<EntityId, SyncableEntity<unknown, unknown>> = new Map();

  /**
   * Adds an entity to the game world.
   * @param entity The entity to add the the world.
   */
  public addEntity(entity: SyncableEntity<unknown, unknown>) {
    this.entities.set(entity.id, entity);
  }

  /**
   * Searches for an entity by ID.
   * @param id The ID of the entity to search for.
   * @returns The entity with the matching ID, if it exists.
   */
  public getEntityById(id: EntityId): SyncableEntity<unknown, unknown> | undefined {
    return this.entities.get(id);
  }

  /**
   * Gets all entities in the game.
   * @returns The entities in the game world.
   */
  public getEntities(): SyncableEntity<unknown, unknown>[] {
    return Array.from(this.entities.values());
  }
}
