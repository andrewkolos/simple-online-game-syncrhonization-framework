import { DeepReadonly, singleLineify } from "src/util";
import { AnyEntity, InterpolableEntity, PickInput, PickState, ReckonableEntity, SyncStrategy } from "../../entity";
import { EntityMessageKind, InputMessage, StateMessage } from "../../networking";
import { ClientEntityMessageBuffer } from "../../networking/message-buffer";
import { TypedEventEmitter } from "../../util/event-emitter";
import { Interval, IntervalRunner } from "../../util/interval-runner";
import { EntityCollection } from "../entity-collection";
import { EntityBoundInput } from "./entity-bound-input";
import { InputCollectionStrategy } from "./input-collection-strategy";
import { CheckedNewEntityHandler, NewEntityHandler, NonLocalEntityResponse } from "./new-entity-handler";

type Timestamp = number;
type EntityId = string;

export interface ClientEntitySynchronizerEvents<E extends AnyEntity> {
  synchronized(entityMap: Map<EntityId, DeepReadonly<E>>): void;
}

/**
 * Contains the information needed to construct a `ClientEntitySynchronizer`.
 */
export interface ClientEntitySynchronizerArgs<E extends AnyEntity> {
  /** A connection to the game server. */
  serverConnection: ClientEntityMessageBuffer<E>;
  /** How often the server will be sending out the world state. */
  serverUpdateRateInHz: number;
  /** A strategy to create local representations of new entities sent by the server. */
  newEntityHandler: NewEntityHandler<E>;
  /** A strategy to obtain inputs from the user that can be applied to entities in the game. */
  inputCollectionStrategy: InputCollectionStrategy<E>;
}

/**
 * Collects user inputs.
 * Translates inputs into intents specific to objects.
 * Sends intents to GameEngine on pre-tick, which will be applied on tick.
 */
export class ClientEntitySynchronizer<E extends AnyEntity> extends
 TypedEventEmitter<ClientEntitySynchronizerEvents<E>> {

  /**
   * Gets the number of inputs that this client has yet to receive an acknowledgement
   * for from the server.
   */
  public get numberOfPendingInputs() {
    return this.pendingInputs.length;
  }
  /** Contains game state and can accept inputs. */
  private readonly entities: EntityCollection<E>;

  private readonly interpolatableEntities: EntityCollection<InterpolableEntity<PickInput<E>, PickState<E>>>;
  private readonly reckonableEntities: EntityCollection<ReckonableEntity<PickInput<E>, PickState<E>>>;

  /** Provides state messages. */
  private readonly server: ClientEntityMessageBuffer<E>;
  /** Constructs representations of new entities given a state object. */
  private readonly newEntityHandler: NewEntityHandler<E>;
  private readonly serverUpdateRateInHz: number;
  /** Collects user inputs. */
  private readonly inputCollectionStrategy: InputCollectionStrategy<E>;
  /**
   * The number assigned to the next set of inputs that will be sent out by this
   * game client. Used for server reconciliation.
   */
  private currentInputSequenceNumber = 0;
  /**
   * Inputs with sequence numbers later than that of the last server message received.
   * These inputs will be reapplied when the client receives a new authoritative state
   * sent by the server.
   */
  private pendingInputs: Array<InputMessage<E>> = [];

  /** The time of the most recent input collection. */
  private lastInputCollectionTimestamp: number | undefined;

  /**
   * IDs of entities that are meant to be controlled by this client's player.
   */
  private readonly playerEntityIds: EntityId[] = [];

  private readonly entityStateBuffers = new Map<EntityId, Array<{ timestamp: Timestamp; state: PickState<E> }>>();

  private updateInterval?: IntervalRunner;

  /**
   * Creates an instance of game client.
   */
  constructor(args: ClientEntitySynchronizerArgs<E>) {
    super();

    this.entities = new EntityCollection();
    this.interpolatableEntities = new EntityCollection();
    this.reckonableEntities = new EntityCollection();

    this.server = args.serverConnection;
    this.newEntityHandler = new CheckedNewEntityHandler(args.newEntityHandler);
    this.serverUpdateRateInHz = args.serverUpdateRateInHz;
    this.inputCollectionStrategy = args.inputCollectionStrategy;
  }

  /**
   * Determines whether has received communication from the game server.
   * @returns `true` if connected, `false` otherwise.
   */
  public isConnected(): boolean {
    return this.entities.asArray().length > 0;
  }

  public start(updateRateHz: number) {
    this.stop();
    this.updateInterval = new IntervalRunner(() => this.update(), Interval.fromHz(updateRateHz));
    this.updateInterval.start();
  }

  public stop() {
    if (this.updateInterval != null && this.updateInterval.isRunning()) {
      this.updateInterval.stop();
    }
  }

  /**
   * Updates the state of the game, based on the game itself, messages regarding
   * the state of the world sent by the server, and inputs from the user.
   */
  private update() {
    this.processServerMessages();

    if (!this.isConnected()) { return; }

    this.processInputs();

    this.interpolateEntities();

    this.emit("synchronized", this.entities.asIdKeyedMap() as Map<EntityId, DeepReadonly<E>>);
  }

  /**
   * Process all new messages sent by the server.
   * Add new entities, update our player-controlled entities to have the state sent by the server, then reapply
   * pending inputs that have yet to be acknowledged by the server.
   */
  // tslint:disable-next-line: member-ordering
  private readonly processServerMessages = (() => {

    const isFirstTimeSeeingEntity = (entityId: string) => !this.entities.asArray().some((ge) => ge.id === entityId);

    const handleNewEntity = (stateMessage: StateMessage<E>) => {

      const entityBelongsToThisClient = stateMessage.entity.belongsToRecipientClient;
      if (entityBelongsToThisClient != null && entityBelongsToThisClient) {
        this.addNewLocalPlayerEntity(stateMessage);
      } else {
        this.addNewNonLocalPlayerEntity(stateMessage);
      }

    };

    const updateLocalPlayerState = (entity: E, stateMessage: StateMessage<E>) => {
      if (this.entityBelongsToLocalPlayer(stateMessage.entity.id)) {
        entity.state = stateMessage.entity.state; // Received authoritative position for our entity.

        this.reconcileLocalStateWithServerState(stateMessage);
      }
    };

    const reckonIfReckoningEntity = (stateMessage: StateMessage<E>) => {
      const reckonableEntity = this.reckonableEntities.get(stateMessage.entity.id);
      if (reckonableEntity != null) {
        reckonableEntity.reckon(new Date().getTime() - stateMessage.timestampMs);
      }
    };

    const appendStateOntoBufferIfInterpolatingEntity = (stateMessage: StateMessage<E>) => {
      const interpolableEntity = this.interpolatableEntities.get(stateMessage.entity.id);
      if (interpolableEntity != null) {
        this.appendStateOntoBuffer(interpolableEntity.id, stateMessage.entity.state);
      }
    };

    return () => {
      for (const stateMessage of this.server) {
        const stateMessageEntityId = stateMessage.entity.id;

        if (isFirstTimeSeeingEntity(stateMessageEntityId)) {
          handleNewEntity(stateMessage);
        }

        const entity = this.entities.get(stateMessageEntityId);
        if (entity == null) {
          throw Error(singleLineify`
            Received state message with entity ID '${stateMessageEntityId}',
            but no entity with that ID exists on this client.
          `);
        }

        updateLocalPlayerState(entity, stateMessage);
        reckonIfReckoningEntity(stateMessage);
        appendStateOntoBufferIfInterpolatingEntity(stateMessage);
      }
    };

  })();

  /**
   * Creates a representation of an entity (not controlled by the client) on the client.
   * @param stateMessage The state message to create the entity from.
   */
  private addNewNonLocalPlayerEntity(stateMessage: StateMessage<E>) {
    const stateMessageEntityId = stateMessage.entity.id;

    const newEntityInfo: NonLocalEntityResponse<E> = this.newEntityHandler
      .createNonLocalEntityFromStateMessage(stateMessage);

    this.entities.add(newEntityInfo.entity as E);

    // Set up new state buffer for this entity, to be used for server reconciliation.
    this.entityStateBuffers.set(stateMessageEntityId, []);

    switch (newEntityInfo.syncStrategy) {
      case SyncStrategy.DeadReckoning:
        this.reckonableEntities.add(newEntityInfo.entity);
        break;
      case SyncStrategy.Interpolation:
        this.interpolatableEntities.add(newEntityInfo.entity);
        break;
      case SyncStrategy.Raw:
        break;
      default:
        throw Error(`Unexpected synchronization strategy '${(newEntityInfo as any).syncStrategy}'.`);
    }
  }

  /**
   * Determines if an entity is to be controlled by this client.
   * @param entityId The ID of the entity.
   */
  private entityBelongsToLocalPlayer(entityId: string) {
    return this.playerEntityIds.includes(entityId);
  }

  /**
   * Adds the state of an entity sent by the server onto its state buffer, recording the time at which the state
   * was received. This can be used for server reconciliation.
   * @param stateMessage The state message from the server containing the new state.
   */
  private appendStateOntoBuffer(entityId: EntityId, state: PickState<E>) {

    const timestamp = new Date().getTime();
    const stateBuffer = this.entityStateBuffers.get(entityId);
    if (stateBuffer == null) {
      throw Error(`Did not find state buffer for entity with id ${entityId}.`);
    }
    stateBuffer.push({ timestamp, state });
  }

  /**
   * Perform server reconciliation. When the client receives an update about its entities
   * from the server, apply them, and then reapply all local pending inputs (have timestamps
   * later than the timestamp sent by the server).
   */
  private reconcileLocalStateWithServerState(stateMessage: StateMessage<E>) {

    this.pendingInputs = this.pendingInputs.filter((input: InputMessage<E>) => {
      return input.inputSequenceNumber > stateMessage.lastProcessedInputSequenceNumber;
    });
    this.pendingInputs.forEach((inputMessage: InputMessage<E>) => {
      const entity = this.entities.get(inputMessage.entityId);
      if (entity == null) {
        throw Error("Did not find entity corresponding to a pending input.");
      }
      entity.applyInput(inputMessage.input);
    });
  }

  private addNewLocalPlayerEntity(stateMessage: StateMessage<E>) {
    const entity = this.newEntityHandler.createLocalEntityFromStateMessage(stateMessage);

    this.playerEntityIds.push(entity.id);

    this.entities.add(entity);
  }

  /**
   * Collects inputs from player (or AI), stamps them with a timestamp and sequence number,
   * sends them to the server, and applies them locally.
   */
  private processInputs(): void {

    const now = new Date().getTime();

    const getInputs = (): Array<EntityBoundInput<E>> => {

      const lastInputCollectionTime = this.lastInputCollectionTimestamp != null
        ? this.lastInputCollectionTimestamp : now;

      const timeSinceLastInputCollection = now - lastInputCollectionTime;

      this.lastInputCollectionTimestamp = now;

      return this.inputCollectionStrategy.getInputs(timeSinceLastInputCollection);
    };

    const entityBoundInputs = getInputs();

    entityBoundInputs.forEach((input) => {

      const inputMessage: InputMessage<E> = {
        entityId: input.entityId,
        input: input.input,
        inputSequenceNumber: this.currentInputSequenceNumber,
        messageKind: EntityMessageKind.Input,
      };

      this.server.send(inputMessage);

      const playerEntity = this.entities.get(input.entityId);

      if (playerEntity == undefined) { throw Error(`Received input for unknown entity ${input.entityId}.`); }

      playerEntity.applyInput(input.input); // Client-side prediction.

      this.pendingInputs.push(inputMessage); // Save for later reconciliation.
    });

    if (entityBoundInputs.length > 0) {
      this.currentInputSequenceNumber = this.currentInputSequenceNumber + 1;
    }
  }

  /**
   * Smooths out the state of entities controlled by other players.
   */
  private interpolateEntities(): void {
    const now = new Date().getTime();
    const renderTimestamp = now - (1000.0 / this.serverUpdateRateInHz);

    this.interpolatableEntities.asArray().forEach((entity: InterpolableEntity<PickInput<E>, PickState<E>>) => {
      if (this.playerEntityIds.includes(entity.id)) {
        // No point in interpolating an entity that belongs to this client.
        return;
      }

      // Find the two authoritative positions surrounding the timestamp.
      const buffer = this.entityStateBuffers.get(entity.id);
      if (buffer == undefined) { throw Error(`Could not find state buffer for entity ${entity.id}.`); }

      // Drop older positions.
      while (buffer.length >= 2 && buffer[1].timestamp <= renderTimestamp) {
        buffer.shift();
      }

      // Get the "average" (whatever the entity's interpolation scheme decides) of the two states in which
      // the current timestamp falls in-between.
      if (buffer.length >= 2 && buffer[0].timestamp <= renderTimestamp && renderTimestamp <= buffer[1].timestamp) {

        const timeRatio = (renderTimestamp - buffer[0].timestamp) / (buffer[1].timestamp - buffer[0].timestamp);
        entity.interpolate(buffer[0].state, buffer[1].state, timeRatio);
      }
    });
  }
}
