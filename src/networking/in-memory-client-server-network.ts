import { TypedEventEmitter } from '../event-emitter';
import { ClientEntityMessageBuffer, ServerEntityMessageBuffer } from './message-buffer';
import { InputMessage, StateMessage } from './messages';
import { AnySyncableEntity } from '../syncable-entity';

interface InMemoryClientServerNetworkEvents<E extends AnySyncableEntity> {
  stateMessageSent(message: StateMessage<E>): void;
  inputMessageSent(message: InputMessage<E>): void;
}

/**
 * An in-memory network that can be used to connect client and server entity synchronizers.
 */
export class InMemoryClientServerEntityNetwork<E extends AnySyncableEntity> {

  private readonly inputMessageQueues: InputMessage<E>[][] = [];
  private readonly stateMessageQueues: StateMessage<E>[][] = [];

  private readonly inputMessageReadyTimes: Map<InputMessage<E>, number> = new Map();
  private readonly stateMessageSendTimes: Map<StateMessage<E>, number> = new Map();
  private readonly stateMessageReferenceCounts: Map<StateMessage<E>, number> = new Map();

  private readonly eventEmitter = new TypedEventEmitter<InMemoryClientServerNetworkEvents<E>>();

  // tslint:disable-next-line: member-ordering
  public on = this.eventEmitter.on.bind(this.eventEmitter);

  /**
   * Get a connection to the server.
   */
  public getNewServerConnection(lagMs: number): ClientEntityMessageBuffer<E> {
    const that = this;
    this.stateMessageQueues.push([]);
    const clientIndex = this.stateMessageQueues.length - 1;
    const stateMessageQueue = this.stateMessageQueues[clientIndex];

    return {
      send: (message: InputMessage<E>) => {
        const inputMessageQueue = this.inputMessageQueues[clientIndex];
        if (inputMessageQueue == null) {
          throw Error('Cannot send input to server before the client connection has been created.');
        }
        inputMessageQueue.push(message);
        this.inputMessageReadyTimes.set(message, new Date().getTime() + lagMs);
        this.eventEmitter.emit('inputMessageSent', message);
      },
      receive: function() {
        if (!this.hasNext()) throw Error('No message ready.');
        const message = stateMessageQueue[0];
        stateMessageQueue.splice(0, 1);
        decrementOrRemove(that.stateMessageReferenceCounts, message);

        return message;
      },
      hasNext: () => {
        if (stateMessageQueue.length < 1) return false;
        const nextMessage = stateMessageQueue[0];
        const nextMessageSentAt = this.stateMessageSendTimes.get(nextMessage)!.valueOf();
        
        return nextMessageSentAt + lagMs<= new Date().getTime();
      }
    };
  }

  /**
   * Get a connection to a client.
   */
  public getNewClientConnection(): ServerEntityMessageBuffer<E> {
    this.inputMessageQueues.push([]);
    const clientIndex = this.inputMessageQueues.length - 1;
    const imQueue = this.inputMessageQueues[clientIndex];

    return {
      send: (message: StateMessage<E>) => {
        this.stateMessageQueues[clientIndex].push(message);

        this.stateMessageSendTimes.set(message, new Date().getTime());
        increment(this.stateMessageReferenceCounts, message);
        this.eventEmitter.emit('stateMessageSent', message);
      },
      receive: function() {
        if (!this.hasNext()) throw Error('No input message is ready.');
        const message = imQueue[0];
        imQueue.splice(0,1);
        return message;
      },
      hasNext: () => {
        return (imQueue.length > 0 &&
          this.inputMessageReadyTimes.get(imQueue[0])!.valueOf() <= new Date().getTime());
      }
    };
  }

  public getInputMessageQueueLengths(): number[] {
    return this.inputMessageQueues.map(q => q.length);
  }

  public getStateMessageQueueLengths(): number[] {
    return this.stateMessageQueues.map(q => q.length);
  }
}

function decrementOrRemove<K>(map: Map<K, number>, key: K): void {
  const value = map.get(key);
  if (value == undefined) {
    throw Error('Tried to decrement map value that does not exist.');
  }
  if (value === 1) {
    map.delete(key);
  }
  
  map.set(key, value - 1);
}

function increment<K>(map: Map<K, number>, key: K): void {
  const value = map.get(key);
  if (value == undefined) {
    map.set(key, 1);
  } else {
    map.set(key, value + 1);
  }
}