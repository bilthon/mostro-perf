import { NDKEvent, NDKUser } from '@nostr-dev-kit/ndk'
import { NostrEvent, UnsignedEvent } from 'nostr-tools'
import { Order, PeerMessage } from './types'
import { MostroEvent } from './mostro'
import { MostroInfo } from './types'

// Define basic types if they're not already defined elsewhere
// type Order = any  // Replace 'any' with the actual Order type
// type MostroEvent = any  // Replace 'any' with the actual MostroEvent type
// type PeerMessage = any  // Replace 'any' with the actual PeerMessage type
// type MostroInfo = any  // Replace 'any' with the actual MostroInfo type

export interface IAuthStore {
  pubKey: string | null;
  privKey: string | null;
  setPrivKey(key: string | null): void;
  setPubKey(key: string | null): void;
  getPubKey(): string | null;
  getPrivKey(): string | null;
}

export interface IOrderStore {
  orders: Order[];
  updateOrder(order: Order, isPublic: boolean): void;
  addOrder(order: { order: Order, event: MostroEvent }): void;
  getOrders(): Order[];
  getOrderById(id: string): Order | undefined;
}

export interface IMessageStore {
  messages: PeerMessage[];
  addPeerMessage(message: PeerMessage): void;
  addMostroMessage(message: { message: any, event: MostroEvent }): void;
  getMessages(): PeerMessage[];
  getMessageById(id: string): PeerMessage | undefined;
}

export interface IMostroStore {
  mostroInfo: MostroInfo | null;
  addMostroInfo(info: MostroInfo): void;
  getMostroInfo(): MostroInfo | null;
}

export interface IAlertStore {
  alerts: string[];
  addAlert(message: string): void;
  removeAlert(index: number): void;
  clearAlerts(): void;
}

export interface IDisputeStore {
  disputes: any[];  // Replace 'any' with the actual Dispute type
  addDispute(dispute: any): void;  // Replace 'any' with the actual Dispute type
  updateDispute(id: string, updates: Partial<any>): void;  // Replace 'any' with the actual Dispute type
  getDisputes(): any[];  // Replace 'any' with the actual Dispute type
}

export interface NostrOptions {
  relays: string;
  mostroPubKey: string;
}

export interface NIP04Parties {
  sender: NDKUser;
  recipient: NDKUser;
}

export type Rumor = UnsignedEvent & {id: string};
export type Seal = NostrEvent;

export type EventCallback = (event: NDKEvent) => Promise<void>;
export type GiftWrapCallback = (rumor: Rumor, seal: NostrEvent) => Promise<void>;
