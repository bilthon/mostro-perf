import { EventEmitter } from 'tseep'
import { NDKEvent, NDKUser } from '@nostr-dev-kit/ndk'
import { nip19 } from 'nostr-tools'
import { Nostr, NOSTR_ENCRYPTED_DM_KIND, NOSTR_REPLACEABLE_EVENT_KIND } from './nostr'
import { useOrders } from './stores/orders'
import { useMessages } from './stores/messages'
import { useMostroStore } from './stores/mostro'
import { Action, NewOrder, Order, OrderStatus, OrderType, MostroInfo, MostroMessage } from './types'

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
  'mostro-message': (mostroMessage: MostroMessage, ev: NDKEvent) => void
}> {
  mostro: string
  nostr: Nostr
  orderMap = new Map<string, string>() // Maps order id -> event id
  pubkeyCache: PublicKeyCache = { npub: null, hex: null }
  orderStore: ReturnType<typeof useOrders>
  messageStore: ReturnType<typeof useMessages>
  mostroStore = useMostroStore()

  private readyResolve!: () => void
  private readyPromise: Promise<void>

  constructor(opts: MostroOptions) {
    super()
    this.mostro = opts.mostroPubKey
    this.orderStore = useOrders()
    this.messageStore = useMessages()

    this.nostr = new Nostr({ relays: opts.relays, mostroPubKey: opts.mostroPubKey })

    // Register Mostro-specific event handlers
    this.nostr.registerEventHandler(NOSTR_REPLACEABLE_EVENT_KIND, this.handlePublicEvent.bind(this));
    this.nostr.registerEventHandler(NOSTR_ENCRYPTED_DM_KIND, this.handlePrivateEvent.bind(this));
    this.nostr.registerToMostroMessage(this.handleMostroMessage.bind(this));

    this.readyPromise = new Promise(resolve => this.readyResolve = resolve)

    // Wait for Nostr to be ready
    this.nostr.on('ready', this.onNostrReady.bind(this))
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

  async handlePublicEvent(ev: NDKEvent) {
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
        this.orderStore.updateOrder(order, true)
      } else {
        // Adds new order
        this.orderStore.addOrder({ order: order, event: ev as MostroEvent })
        this.orderMap.set(order.id, ev.id)
      }
    } else if (z === 'info') {
      // Info
      const info = this.extractInfoFromEvent(ev)
      this.mostroStore.addMostroInfo(info)
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

  async handlePrivateEvent(ev: NDKEvent) {
    // Handle Mostro-specific private events (direct messages)
    const plaintext = await this.nostr.decryptMessage(ev);
    // console.log(`>>>> handlePrivateEvent, created at: ${new Date(ev.created_at as number * 1E3)}, ev: ${ev.id}`)
    const myPubKey = this.pubkeyCache.hex
    const nEvent = await ev.toNostrEvent()
    const mostroPubKey = nip19.decode(this.mostro).data
    const { sender, recipient } = this.nostr.obtainParties(ev)
    if (sender.pubkey === myPubKey) {
      // DMs I created
      try {
        const [[, recipientPubKey]] = ev.tags
        if (recipientPubKey === mostroPubKey)
          console.log('< [me -> 🧌]: ', plaintext, ', ev: ', nEvent)
        else
          console.log('< [me -> 🍐]: ', plaintext, ', ev: ', nEvent)
        const peerNpub = nip19.npubEncode(recipientPubKey)
        this.messageStore.addPeerMessage({
          id: ev.id,
          text: plaintext,
          peerNpub: peerNpub,
          sender: 'me',
          created_at: ev.created_at || 0
        })
      } catch (err) {
        console.error('Error while decrypting message: ', err)
      }
    } else if (recipient.pubkey === myPubKey) {
      // DMs I received
      try {
        if (ev.pubkey === mostroPubKey && this.isJsonObject(plaintext)) {
          if (plaintext.includes('dispute')) {
            // console.info(`<<<< [🧌 -> me] created at: ${new Date(ev.created_at as number * 1E3)},[${ev.id}] msg: ${plaintext}`)
          }
          console.info('< [🧌 -> me]: ', plaintext, ', ev: ', nEvent)
          const msg = { ...JSON.parse(plaintext), created_at: ev.created_at }
          this.messageStore.addMostroMessage({ message: msg, event: ev as MostroEvent})
        } else {
          console.info('< [🍐 -> me]: ', plaintext, ', ev: ', nEvent)
          // Peer DMs
          const peerNpub = nip19.npubEncode(ev.pubkey)
          this.messageStore.addPeerMessage({
            id: ev.id,
            text: plaintext,
            peerNpub: peerNpub,
            sender: 'other',
            created_at: ev.created_at || 0
          })
        }
      } catch (err) {
        console.error('Error while trying to decode DM: ', err)
      }
    } else {
      console.warn(`<< Ignoring DM for key: ${recipient.pubkey}, my pubkey is ${myPubKey}`)
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
    this.messageStore.addMostroMessage({ message: mostroMessage, event: ev })
    this.emit('mostro-message', mostroMessage, ev)
  }

  async submitOrder(order: NewOrder) {
    const payload = {
      order: {
        version: 1,
        action: Action.NewOrder,
        content: {
          order: order
        }
      }
    }
    await this.nostr.createAndPublishMostroEvent(payload, this.getMostroPublicKey(PublicKeyType.HEX))
  }

  async takeSell(order: Order, amount?: number | undefined) {
    const payload = {
      order: {
        version: 1,
        id: order.id,
        action: Action.TakeSell,
        content: amount ? {
            amount: amount
          } : null
      }
    }
    await this.nostr.createAndPublishMostroEvent(payload, this.getMostroPublicKey(PublicKeyType.HEX))
  }

  async takeBuy(order: Order, amount?: number | undefined) {
    const payload = {
      order: {
        version: 1,
        id: order.id,
        action: Action.TakeBuy,
        content: amount ? {
          amount: amount
        } : null
      }
    }
    await this.nostr.createAndPublishMostroEvent(payload, this.getMostroPublicKey(PublicKeyType.HEX))
  }

  async addInvoice(order: Order, invoice: string, amount: number | null = null) {
    const payload = {
      order: {
        version: 1,
        id: order.id,
        action: Action.AddInvoice,
        content: {
          payment_request: [
            null,
            invoice,
            amount
          ]
        }
      }
    }
    await this.nostr.createAndPublishMostroEvent(payload, this.getMostroPublicKey(PublicKeyType.HEX))
  }

  async release(order: Order) {
    const payload = {
      order: {
        version: 1,
        id: order.id,
        action: Action.Release,
        content: null,
      }
    }
    await this.nostr.createAndPublishMostroEvent(payload, this.getMostroPublicKey(PublicKeyType.HEX))
  }

  async fiatSent(order: Order) {
    const payload = {
      order: {
        version: 1,
        action: Action.FiatSent,
        id: order.id
      }
    }
    await this.nostr.createAndPublishMostroEvent(payload, this.getMostroPublicKey(PublicKeyType.HEX))
  }

  async rateUser(order: Order, rating: number) {
    const payload = {
      order: {
        version: 1,
        id: order.id,
        action: Action.RateUser,
        content: {
          rating_user: rating
        }
      }
    }
    await this.nostr.createAndPublishMostroEvent(payload, this.getMostroPublicKey(PublicKeyType.HEX))
  }

  async dispute(order: Order) {
    const payload = {
      order: {
        version: 1,
        action: Action.Dispute,
        id: order.id,
        content: null,
      }
    }
    await this.nostr.createAndPublishMostroEvent(payload, this.getMostroPublicKey(PublicKeyType.HEX))
  }

  async cancel(order: Order) {
    const payload = {
      order: {
        version: 1,
        action: Action.Cancel,
        id: order.id,
        content: null,
      }
    }
    await this.nostr.createAndPublishMostroEvent(payload, this.getMostroPublicKey(PublicKeyType.HEX))
  }

  async submitDirectMessage(message: string, npub: string, replyTo: string | undefined): Promise<void> {
    await this.nostr.submitDirectMessage(message, npub, replyTo)
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
