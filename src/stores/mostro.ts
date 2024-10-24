import { EventEmitter } from 'events'
import { IMostroStore } from '../interfaces'
import { MostroInfo } from '../types'

export class MostroStore extends EventEmitter implements IMostroStore {
  mostroInfo: MostroInfo | null = null

  constructor() {
    super()
  }

  addMostroInfo(info: MostroInfo): void {
    this.mostroInfo = info
    this.emit('mostroInfoUpdated', info)
  }

  getMostroInfo(): MostroInfo | null {
    return this.mostroInfo
  }

  // Additional methods that might be useful
  clearMostroInfo(): void {
    this.mostroInfo = null
    this.emit('mostroInfoCleared')
  }

  updateMostroInfo(partialInfo: Partial<MostroInfo>): void {
    if (this.mostroInfo) {
      this.mostroInfo = { ...this.mostroInfo, ...partialInfo }
      this.emit('mostroInfoUpdated', this.mostroInfo)
    } else {
      console.warn('Attempting to update MostroInfo when it is null')
    }
  }
}

export function useMostroStore() {
  return new MostroStore()
}