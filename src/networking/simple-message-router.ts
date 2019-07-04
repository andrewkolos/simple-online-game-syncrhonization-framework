import { ValueOf } from '../util';
import { MessageBuffer } from './message-buffer';
import { MessageRouter, RouterTypeMap } from './message-router';

/**
 * A simple implementation of `MessageRouter`. Any filtered message buffer generated from the router will receive all messages
 * available in the underlying `MessageBuffer` when queried for a message (or the presence of one). These messages will be filtered
 * into array buffers by type, which `MessageBuffers` generated by the `MessageRouter` will query for messages.
 * @template ReceiveTypeMap @inheritdoc
 * @template SendTypeMap @inheritdoc
 */
export class SimpleMessageRouter<MessageTypeKey extends string, ReceiveTypeMap extends RouterTypeMap<MessageTypeKey>, SendTypeMap extends RouterTypeMap<MessageTypeKey>> 
                                implements MessageRouter<MessageTypeKey, ReceiveTypeMap, SendTypeMap> {
                                                          
  private readonly collections: Record<keyof ReceiveTypeMap, ValueOf<ReceiveTypeMap>[]>;
  
  public constructor(private readonly buffer: MessageBuffer<ValueOf<ReceiveTypeMap>, ValueOf<SendTypeMap>>) {}
  
  public getFilteredMessageBuffer<R extends keyof ReceiveTypeMap, S extends keyof SendTypeMap>(bufferType: MessageTypeKey): MessageBuffer<ReceiveTypeMap[R], SendTypeMap[S]> {
    return {
      send: (message: SendTypeMap[S]) => {
        this.buffer.send(message);
      },
      hasNext: () => {
        this.receiveAndOrganizeAllMessages();

        return this.collections[bufferType] != null && this.collections[bufferType].length > 0;
      },
      receive: () => {
        this.receiveAndOrganizeAllMessages();

        const collection = this.collections[bufferType];
        if (collection == null || collection.length === 0) {
          throw Error(`There are no messages belonging to the ${bufferType} buffer available.`);
        }

        return collection.splice(0,1)[0] as ReceiveTypeMap[R];
      }

    }  
  }

  private receiveAndOrganizeAllMessages(): void {
    while (this.buffer.hasNext()) {
      const message = this.buffer.receive();

      const kind = message.kind as keyof ReceiveTypeMap;

      if (this.collections[kind] == null) {
        this.collections[kind] = [];
      }

      this.collections[kind].push(message);
    }
  }
  
}