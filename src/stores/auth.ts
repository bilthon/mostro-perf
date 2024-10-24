import { EventEmitter } from 'events'
import { IAuthStore } from '../interfaces'

export class AuthStore extends EventEmitter implements IAuthStore {
  private _pubKey: string | null = null
  private _privKey: string | null = null

  constructor() {
    super()
  }

  get pubKey(): string | null {
    return this._pubKey
  }

  get privKey(): string | null {
    return this._privKey
  }

  setPrivKey(key: string | null): void {
    this._privKey = key
    this.emit('privKeyChanged', key)
  }

  setPubKey(key: string | null): void {
    this._pubKey = key
    this.emit('pubKeyChanged', key)
  }

  getPubKey(): string | null {
    return this._pubKey
  }

  getPrivKey(): string | null {
    return this._privKey
  }

  // Additional methods that might be useful
  clearKeys(): void {
    this._pubKey = null
    this._privKey = null
    this.emit('keysCleared')
  }

  isAuthenticated(): boolean {
    return this._pubKey !== null && this._privKey !== null
  }
}

export function useAuth() {
  return new AuthStore()
}