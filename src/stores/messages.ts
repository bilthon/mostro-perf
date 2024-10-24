import { EventEmitter } from 'events'
import { IMessageStore } from '../interfaces'
import { PeerMessage } from '../types'
import { MostroEvent } from '../mostro'

export class MessageStore extends EventEmitter implements IMessageStore {
  messages: PeerMessage[] = []

  constructor() {
    super()
  }

  addPeerMessage(message: PeerMessage): void {
    this.messages.push(message)
    this.emit('peerMessageAdded', message)
  }

  addMostroMessage(mostroMessage: { message: any, event: MostroEvent }): void {
    const { message, event } = mostroMessage
    // this.messages.push(peerMessage)
    // this.emit('mostroMessageAdded', peerMessage, event)
  }

  getMessages(): PeerMessage[] {
    return this.messages
  }

  getMessageById(id: string): PeerMessage | undefined {
    return this.messages.find(message => message.id === id)
  }

  // Additional methods that might be useful
  removeMessage(id: string): void {
    const index = this.messages.findIndex(message => message.id === id)
    if (index !== -1) {
      this.messages.splice(index, 1)
      this.emit('messageRemoved', id)
    }
  }

  clearMessages(): void {
    this.messages = []
    this.emit('messagesCleared')
  }
}

export function useMessages() {
  return new MessageStore()
}