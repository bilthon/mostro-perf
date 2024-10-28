import { EventEmitter } from 'tseep'
import { NDKEvent, NDKKind, NDKUser } from '@nostr-dev-kit/ndk'
import { nip19 } from 'nostr-tools'
import { Nostr } from './nostr'
import { Action, NewOrder, Order, OrderStatus, OrderType, MostroInfo, MostroMessage } from './types'

const REQUEST_TIMEOUT = 30000 // 30 seconds timeout

interface PendingRequest {
  resolve: (value: MostroMessage) => void
  reject: (reason: any) => void
  timer: NodeJS.Timeout
}

export type MostroEvent = NDKEvent

type MostroOptions = {
  mostroPubKey: string,
  relays: string,
  // nostr: Nostr
}

type PublicKeyCache = {
  npub: null | string,
  hex: null | string
}

export enum PublicKeyType {
  HEX = 'hex',
  NPUB = 'npub'
}

export class Mostro extends EventEmitter<{
  'mostro-message': (mostroMessage: MostroMessage, ev: NDKEvent) => void,
  'order-update': (order: Order, ev: NDKEvent) => void,
  'info-update': (info: MostroInfo) => void
}> {
  mostro: string
  nostr: Nostr
  orderMap = new Map<string, string>() // Maps order id -> event id
  pubkeyCache: PublicKeyCache = { npub: null, hex: null }

  private readyResolve!: () => void
  private readyPromise: Promise<void>

  private pendingRequests: Map<number, PendingRequest> = new Map()
  private nextRequestId: number = 1

  constructor(opts: MostroOptions) {
    super()
    this.mostro = opts.mostroPubKey

    this.nostr = new Nostr({ relays: opts.relays, mostroPubKey: opts.mostroPubKey })

    // Register Mostro-specific event handlers
    this.nostr.registerToPublicMessage(this.handlePublicMessage.bind(this))
    this.nostr.registerToMostroMessage(this.handleMostroMessage.bind(this))

    this.readyPromise = new Promise(resolve => this.readyResolve = resolve)

    // Wait for Nostr to be ready
    this.nostr.on('ready', this.onNostrReady.bind(this))
  }

  async waitForAction(action: Action, orderId: string, timeout: number = 60000): Promise<MostroMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeListener('mostro-message', handler);
        reject(new Error(`Timeout waiting for action ${action} for order ${orderId}`));
      }, timeout);

      const handler = (mostroMessage: MostroMessage, _ev: NDKEvent) => {
        if (mostroMessage.order && 
            mostroMessage.order.action === action && 
            mostroMessage.order.id === orderId) {
          clearTimeout(timer);
          this.removeListener('mostro-message', handler);
          resolve(mostroMessage);
        } else {
          console.warn(`Received unexpected action ${mostroMessage.order?.action} for order ${mostroMessage.order?.id}`)
        }
      };

      this.on('mostro-message', handler);
    });
  }

  private getNextRequestId(): number {
    return this.nextRequestId++
  }

  private createPendingRequest(): [number, Promise<MostroMessage>] {
    const requestId = this.getNextRequestId()
    let resolver: ((value: MostroMessage) => void) | undefined
    let rejecter: ((reason: any) => void) | undefined

    const promise = new Promise<MostroMessage>((resolve, reject) => {
      resolver = resolve
      rejecter = reject
    })

    const timer = setTimeout(() => {
      this.pendingRequests.delete(requestId)
      rejecter!(new Error('Request timed out'))
    }, REQUEST_TIMEOUT)

    this.pendingRequests.set(requestId, {
      resolve: resolver!,
      reject: rejecter!,
      timer
    })

    return [requestId, promise]
  }

  async connect() {
    try {
      await this.nostr.connect()
      return this.readyPromise
    } catch (error) {
      console.error('Mostro. Failed to connect to relays:', error)
    }
  }

  onNostrReady() {
    console.log('Mostro. Nostr is ready')
    // Subscribe to orders
    this.nostr.subscribeOrders()

    // Add Mostro user
    this.nostr.addUser(new NDKUser({ npub: this.mostro }))

    this.readyResolve()
  }

  extractOrderFromEvent(ev: NDKEvent): Order {
    let id: string | undefined
    let kind: OrderType | null = null
    let status: OrderStatus | null = null
    let fiat_code: string | undefined = undefined
    let fiat_amount = 0
    let min_amount: number | null = null
    let max_amount: number | null = null
    let payment_method = ''
    let premium: number | undefined = undefined
    let amount = 0
    ev.tags.forEach((tag: string[]) => {
      switch(tag[0]) {
        case 'd':
          id = tag[1] as string
          break
        case 'k':
          kind = tag[1] as OrderType
          break
        case 'f':
          fiat_code = tag[1] as string
          break
        case 's':
          status = tag[1] as OrderStatus
          break
        case 'amt':
          amount = Number(tag[1])
          break
        case 'fa':
          fiat_amount = Number(tag[1])
          min_amount = tag[2] ? Number(tag[1]) : null
          max_amount = tag[2] ? Number(tag[2]) : null
          break
        case 'pm':
          payment_method = tag[1] as string
          break
        case 'premium':
          premium = Number(tag[1])
          break
      }
    })

    if (!id || !kind || !status || !payment_method || premium === undefined || !fiat_code) {
      console.error('Missing required tags in event to extract order. ev.tags: ', ev.tags)
      throw Error('Missing required tags in event to extract order')
    }

    const created_at = ev.created_at || 0
    const mostro_id = ev.author.pubkey

    return new Order(
      id,
      kind,
      status,
      fiat_code,
      min_amount,
      max_amount,
      fiat_amount,
      payment_method,
      premium,
      created_at,
      amount,
      mostro_id
    )
  }

  extractInfoFromEvent(ev: NDKEvent): MostroInfo {
    const tags = new Map<string, string>(ev.tags as [string, string][])
    const mostro_pubkey = tags.get('mostro_pubkey') as string
    const mostro_version = tags.get('mostro_version') as string
    const mostro_commit_id = tags.get('mostro_commit_id') as string
    const max_order_amount = Number(tags.get('max_order_amount') as string)
    const min_order_amount = Number(tags.get('min_order_amount') as string)
    const expiration_hours = Number(tags.get('expiration_hours') as string)
    const expiration_seconds = Number(tags.get('expiration_seconds') as string)
    const fee = Number(tags.get('fee') as string)
    const hold_invoice_expiration_window = Number(tags.get('hold_invoice_expiration_window') as string)
    const invoice_expiration_window = Number(tags.get('invoice_expiration_window') as string)
    return {
      mostro_pubkey,
      mostro_version,
      mostro_commit_id,
      max_order_amount,
      min_order_amount,
      expiration_hours,
      expiration_seconds,
      fee,
      hold_invoice_expiration_window,
      invoice_expiration_window
    }
  }

  async handlePublicMessage(ev: NDKEvent) {
    const nEvent = await ev.toNostrEvent()
    // Create a map from the tags array for easy access
    const tags = new Map<string, string | number[]>(ev.tags as [string, string | number[]][])

    const z = tags.get('z')
    if (z === 'order') {
      // Order
      const order = this.extractOrderFromEvent(ev);
      // console.info('< [🧌 -> 📢]', JSON.stringify(order), ', ev: ', nEvent)
      if (this.orderMap.has(order.id)) {
        // Updates existing order
        this.emit('order-update', order, ev)
        // this.orderStore.updateOrder(order, true)
      } else {
        // Adds new order
        // this.orderStore.addOrder({ order: order, event: ev as MostroEvent })
        this.orderMap.set(order.id, ev.id)
        this.emit('order-update', order, ev)
      }
    } else if (z === 'info') {
      // Info
      const info = this.extractInfoFromEvent(ev)
      // this.mostroStore.addMostroInfo(info)
      this.emit('info-update', info)
      // console.info('< [🧌 -> 📢]', JSON.stringify(info), ', ev: ', nEvent)
    } else if (z === 'dispute') {
      console.info('< [🧌 -> 📢]', 'dispute', ', ev: ', nEvent)
      // const dispute = this.extractDisputeFromEvent(ev)
      // this.orderStore.addDispute({ dispute: dispute, event: ev as MostroEvent })
    } else {
      // TODO: Extract other kinds of events data: Disputes & Ratings
    }
  }

  isJsonObject(str: string): boolean {
    try {
      const parsed = JSON.parse(str);
      return typeof parsed === 'object' && parsed !== null;
    } catch {
      return false;
    }
  }

  /**
   * Handle messages from Mostro
   * @param message - The message content
   */
  async handleMostroMessage(message: string, ev: MostroEvent) {
    const mostroMessage = JSON.parse(message) as MostroMessage
    const date = (new Date(ev.created_at as number * 1E3)).getTime()
    const now = new Date().getTime()
    console.info(`[🎁][🧌 -> me] [d: ${now - date}]: `, mostroMessage, ', ev: ', ev)
    this.emit('mostro-message', mostroMessage, ev)

    // Check if this message is a response to a pending request
    const requestId = mostroMessage.order?.request_id
    if (requestId && this.pendingRequests.has(requestId)) {
      const { resolve, timer } = this.pendingRequests.get(requestId)!
      clearTimeout(timer)
      this.pendingRequests.delete(requestId)
      resolve(mostroMessage)
    }
  }

  private async sendMostroRequest(action: Action, payload: any): Promise<MostroMessage> {
    const [requestId, promise] = this.createPendingRequest()
    const fullPayload = {
      order: {
        version: 1,
        request_id: requestId,
        action,
        ...payload
      }
    }
    await this.nostr.createAndPublishMostroEvent(fullPayload, this.getMostroPublicKey(PublicKeyType.HEX))
    return promise
  }

  async submitOrder(order: NewOrder) {
    return this.sendMostroRequest(Action.NewOrder, {
      content: { order }
    })
  }

  async takeSell(order: Order, amount?: number | undefined) {
    return this.sendMostroRequest(Action.TakeSell, {
      id: order.id,
      content: amount ? { amount } : null
    })
  }

  async takeBuy(order: Order, amount?: number | undefined) {
    return this.sendMostroRequest(Action.TakeBuy, {
      id: order.id,
      content: amount ? { amount } : null
    })  }

  async addInvoice(order: Order, invoice: string, amount: number | null = null) {
    return this.sendMostroRequest(Action.AddInvoice, {
      id: order.id,
      content: {
        payment_request: [null, invoice, amount]
      }
    })  }

  async release(order: Order) {
    return this.sendMostroRequest(Action.Release, {
      id: order.id,
      content: null
    })  }

  async fiatSent(order: Order) {
    return this.sendMostroRequest(Action.FiatSent, {
      id: order.id
    })
  }

  async rateUser(order: Order, rating: number) {
    return this.sendMostroRequest(Action.RateUser, {
      id: order.id,
      content: { rating_user: rating }
    })
  }

  async dispute(order: Order) {
    return this.sendMostroRequest(Action.Dispute, {
      id: order.id,
      content: null
    })
  }

  async cancel(order: Order) {
    return this.sendMostroRequest(Action.Cancel, {
      id: order.id,
      content: null
    })
  }

  async submitDirectMessage(message: string, npub: string): Promise<void> {
    await this.nostr.sendDirectMessage(message, npub)
  }

  getMostroPublicKey(type?: PublicKeyType): string {
    switch (type) {
      case PublicKeyType.HEX:
        return nip19.decode(this.mostro).data as string
      case PublicKeyType.NPUB:
        return this.mostro
      default:
        return this.mostro
    }
  }

  updatePrivKey(privKey: string) {
    this.nostr.updatePrivKey(privKey)
  }
}
