import { EventEmitter } from 'tseep'
import NDK, { NDKKind, NDKSubscription, NDKEvent, NDKRelay, type NDKUserProfile, NDKUser, NDKRelayList, getRelayListForUser, type NDKSigner } from '@nostr-dev-kit/ndk'
import NDKCacheAdapterDexie from '@nostr-dev-kit/ndk-cache-dexie'
import { generateSecretKey, getPublicKey, nip44, nip19, finalizeEvent, getEventHash, UnsignedEvent, NostrEvent, EventTemplate } from 'nostr-tools'
import { NDKPrivateKeySigner } from '@nostr-dev-kit/ndk'
import { MostroEvent } from './mostro'
import { useAuth } from './stores/auth'

/**
 * Maximum number of seconds to be returned in the initial query
 */
const EVENT_INTEREST_WINDOW = 60 * 60 * 24 * 14 // 14 days

/**
 * The amount of time that the gift wrap timestamp will randomly shifted every time
 */
const GIFT_WRAP_TIME_WINDOW = 2 * 24 * 60 * 60

interface GetUserParams {
  npub?: string
  pubkey?: string
}

// Message kinds
type ExtendedNDKKind = NDKKind | 38383
export const NOSTR_REPLACEABLE_EVENT_KIND: ExtendedNDKKind = 38383
export const NOSTR_ENCRYPTED_DM_KIND = NDKKind.EncryptedDirectMessage
export const NOSTR_SEAL_KIND = 13
export const NOSTR_GIFT_WRAP_KIND = 1059


interface NIP04Parties {
  sender: NDKUser
  recipient: NDKUser
}

type Rumor = UnsignedEvent & {id: string}
type Seal = NostrEvent

export type EventCallback = (event: NDKEvent) => Promise<void>
export type GiftWrapCallback = (rumor: Rumor, seal: NostrEvent) => Promise<void>

interface NostrOptions {
  relays: string
  mostroPubKey: string
  // Add any other runtime configurations you need
}

export class Nostr extends EventEmitter<{ ready: () => void }> {
  private ndk: NDK
  private users = new Map<string, NDKUser>()
  private subscriptions: Map<number, NDKSubscription> = new Map()
  private mostroMessageCallback: (message: string, ev: MostroEvent) => void = () => {}
  private publicMessageCallback: (ev: NDKEvent) => void = () => {}
  public mustKeepRelays: Set<string> = new Set()
  private _signer: NDKSigner | undefined

  // Queue for DMs in order to process past events in the chronological order
  private dmQueue: NDKEvent[] = []
  private dmEoseReceived: boolean = false

  // Queue for gift wraps in order to process past events in the chronological order
  private giftWrapQueue: NDKEvent[] = []
  private giftWrapEoseReceived: boolean = false

  // Queue for order messages
  private orderQueue: NDKEvent[] = []
  private orderEoseReceived: boolean = false

  private options: NostrOptions

  constructor(options: NostrOptions) {
    super()
    this.options = options

    let cacheAdapter = undefined

    // Check if we're in a browser environment
    if (typeof window !== 'undefined') {
      // Browser environment
      const dexieAdapter = new NDKCacheAdapterDexie({
        dbName: 'mostro-events-db',
        eventCacheSize: 10000,
        eventTagsCacheSize: 5000,
      })
      dexieAdapter.locking = true
      cacheAdapter = dexieAdapter
    }
    // this.ndk = new NDK()
    this.ndk = new NDK({
      enableOutboxModel: true,
      cacheAdapter: cacheAdapter,
      autoConnectUserRelays: true,
    })
    this.ndk.pool.on('connect', () => {
      console.log(`🎉 connected to all relays`)
      this.emit('ready')
    })
    this.ndk.pool.on('relay:connect', (relay: NDKRelay) => {
      console.debug(`🔌 connected to relay: ${relay.url}`)
    })
    this.ndk.pool.on('relay:connecting', (relay: NDKRelay) => {
      console.debug(`🔗 connecting to relay: ${relay.url}...`)
    })
    this.ndk.pool.on('relay:disconnect', (relay: NDKRelay) => {
      console.debug(`🚨 disconnected from relay: ${relay.url}`)
    })
    this.ndk.pool.on('relay:auth', (relay: NDKRelay, challenge: string) => {
      console.debug(`🔑 relay ${relay.url} requires auth. Challenge: ${challenge}`)
    })
    this.ndk.outboxPool?.on('relay:connect', (relay: NDKRelay) => {
      console.log(`🎉 connected to outbox relay: ${relay.url}`)
    })

    const { relays } = this.options
    for (const relay of relays.split(',')) {
      console.log(`➕ adding relay: "${relay}"`)
      if (relay.startsWith('ws://') || relay.startsWith('wss://')) {
        const ndkRelay = new NDKRelay(relay, undefined, this.ndk)
        this.ndk.pool.addRelay(ndkRelay, true)
      } else {
        console.warn(`🚨 invalid relay url: "${relay}"`)
      }
    }
  }

  async connect() {
    await this.ndk.connect(2000)
  }
  
  addUser(user: NDKUser) {
    if (!this.users.has(user.pubkey)) {
      this.users.set(user.pubkey, user)
      getRelayListForUser(user.pubkey, this.ndk).then((relayList: NDKRelayList | undefined) => {
        if (relayList) {
          console.log(`🌐 Relay list for [${user.pubkey}]: `, relayList.tags.map(r => r[1]), `, from event: ${relayList.id} - [${relayList.created_at}]`)
          for (const relayUrl of relayList.relays) {
            this.mustKeepRelays.add(relayUrl)
            const ndkRelay = new NDKRelay(relayUrl, undefined, this.ndk)
            this.ndk.pool.addRelay(ndkRelay, true)
            this.ndk.outboxPool?.addRelay(ndkRelay, true)
          }
        } else {
          console.warn(`🚨 No relay list for user [${user.pubkey}], adding default relay`)
          this.ndk.pool.addRelay(new NDKRelay('wss://relay.mostro.network', undefined, this.ndk), true)
        }
      })
    }
  }

  getUser(pubkey: string): NDKUser | undefined {
    return this.users.get(pubkey)
  }

  public set signer(signer: NDKSigner | undefined) {
    this._signer = signer
  }

  public get signer() : NDKSigner | undefined {
    return this._signer
  }

  registerToMostroMessage(callback: (message: string, ev: MostroEvent) => void) {
    this.mostroMessageCallback = callback
  }

  registerToPublicMessage(callback: (ev: NDKEvent) => void) {
    this.publicMessageCallback = callback
  }

  private async _handleEvent(event: NDKEvent, relay: NDKRelay | undefined, subscription: NDKSubscription) {
    this.publicMessageCallback(event)
  }

  private _handleDupEvent(
    eventId: string,
    _relay: NDKRelay | undefined,
    _timeSinceFirstSeen: number,
    _subscription: NDKSubscription
  ) {
    // console.debug(`🧑‍🤝‍🧑 duplicate event [${eventId}]`)
  }

  private _handleCloseSubscription(subscription: NDKSubscription) {
    console.warn('🔚 subscription closed: ', subscription)
    // Find the event kind associated with the closed subscription
    const eventKind = Array.from(this.subscriptions.entries()).find(([_, sub]) => sub === subscription)?.[0]
    if (eventKind !== undefined) {
      this.subscriptions.delete(eventKind)
    } else {
      console.warn('🚨 Subscription not found in the subscriptions map')
    }
  }

  private _queuePrivateEvent(event: NDKEvent) {
    this.dmQueue.push(event)
    if (this.dmEoseReceived) {
      this._processQueuedEvents()
    }
  }

  private async _queueGiftWrapEvent(event: NDKEvent) {
    // console.log('🎁 queueing gift wrap event')
    this.giftWrapQueue.push(event)
    if (this.giftWrapEoseReceived) {
      await this._processQueuedGiftWraps()
    }
  }

  private _queueOrderEvent(event: NDKEvent) {
    this.orderQueue.push(event)
    if (this.orderEoseReceived) {
      this._processQueuedOrders()
    }
  }

  private _handleDMEose() {
    console.warn('🔚 DM subscription eose')
    this.dmEoseReceived = true
    this._processQueuedEvents()
  }

  private _handleOrderEose() {
    console.warn('🔚 order subscription eose')
    this.orderEoseReceived = true
    this._processQueuedOrders()
  }

  private async _handleGiftWrapEose() {
    console.warn('🔚 gift wrap subscription eose')
    this.giftWrapEoseReceived = true
    await this._processQueuedGiftWraps()
  }

  private _processQueuedEvents() {
    this.dmQueue.sort((a, b) => (a.created_at || 0) - (b.created_at || 0))
    for (const event of this.dmQueue) {
      this._handleEvent(event, undefined, this.subscriptions.get(NOSTR_ENCRYPTED_DM_KIND)!)
    }
    this.dmQueue = []
  }

  private _processQueuedOrders() {
    this.orderQueue.sort((a, b) => (a.created_at || 0) - (b.created_at || 0))
    for (const event of this.orderQueue) {
      this._handleEvent(event, undefined, this.subscriptions.get(NOSTR_REPLACEABLE_EVENT_KIND)!)
    }
    this.orderQueue = []
  }

  private async _processQueuedGiftWraps() {
    const rumorQueue: Rumor[] = []
    for (const event of this.giftWrapQueue) {
      const { rumor } = await this.unwrapEvent(event)
      rumorQueue.push(rumor)
    }
    // Sorting rumors by 'created_at' fields. We can only do this after unwrapping
    rumorQueue.sort((a, b) => (a.created_at as number) - (b.created_at as number))
    for (const rumor of rumorQueue) {
      await this.handleGiftWrapEvent(rumor)
    }
    this.giftWrapQueue = []
  }

  subscribeOrders() {
    console.log('📣 subscribing to orders')
    const mostroNpub = this.options.mostroPubKey
    const mostroDecoded = nip19.decode(mostroNpub)
    const filters = {
      kinds: [NOSTR_REPLACEABLE_EVENT_KIND as NDKKind],
      since: Math.floor(Date.now() / 1e3) - EVENT_INTEREST_WINDOW,
      authors: [mostroDecoded.data as string]
    }
    if (!this.subscriptions.has(NOSTR_REPLACEABLE_EVENT_KIND)) {
      const subscription = this.ndk.subscribe(filters, { closeOnEose: false })
      subscription.on('event', this._queueOrderEvent.bind(this))
      subscription.on('event:dup', this._handleDupEvent.bind(this))
      subscription.on('eose', this._handleOrderEose.bind(this))
      subscription.on('close', this._handleCloseSubscription.bind(this))
      this.subscriptions.set(NOSTR_REPLACEABLE_EVENT_KIND, subscription)
    } else {
      console.warn('❌ Attempting to subcribe to orders when already subscribed')
    }
  }

  subscribeDMs(myPubkey: string) {
    console.log('📭 subscribing to DMs')
    const filters = {
      kinds: [NOSTR_ENCRYPTED_DM_KIND],
      '#p': [myPubkey],
      since: Math.floor(Date.now() / 1e3) - EVENT_INTEREST_WINDOW,
    }
    if (!this.subscriptions.has(NOSTR_ENCRYPTED_DM_KIND)) {
      const subscription = this.ndk.subscribe(filters, { closeOnEose: false })
      subscription.on('event', this._queuePrivateEvent.bind(this))
      subscription.on('event:dup', this._handleDupEvent.bind(this))
      subscription.on('eose', this._handleDMEose.bind(this))
      subscription.on('close', this._handleCloseSubscription.bind(this))
      this.subscriptions.set(NOSTR_ENCRYPTED_DM_KIND, subscription)
    } else {
      console.warn('❌ Attempting to subcribe to DMs when already subscribed')
    }
  }

  subscribeGiftWraps(myPubkey: string) {
    console.log('📣 subscribing to gift wraps')
    const filters = {
      kinds: [NOSTR_GIFT_WRAP_KIND],
      '#p': [myPubkey],
      since: Math.floor(Date.now() / 1e3) - EVENT_INTEREST_WINDOW,
    }
    if (!this.subscriptions.has(NOSTR_GIFT_WRAP_KIND)) {
      const subscription = this.ndk.subscribe(filters, { closeOnEose: false })
      subscription.on('event', this._queueGiftWrapEvent.bind(this))
      subscription.on('event:dup', this._handleDupEvent.bind(this))
      subscription.on('eose', this._handleGiftWrapEose.bind(this))
      subscription.on('close', this._handleCloseSubscription.bind(this))
      this.subscriptions.set(NOSTR_GIFT_WRAP_KIND, subscription)
      // this.registerEventHandler(NOSTR_GIFT_WRAP_KIND, this.handleGiftWrapEvent.bind(this))
    } else {
      console.warn('❌ Attempting to subcribe to gift wraps when already subscribed')
    }
  }

  async unwrapEvent(event: NDKEvent): Promise<{rumor: Rumor, seal: Seal}> {
    const nostrEvent = await event.toNostrEvent()
    const unwrappedSeal: Seal = this.nip44Decrypt(
      nostrEvent as NostrEvent,
      Buffer.from((this.signer as NDKPrivateKeySigner).privateKey?.toString() || '', 'hex')
    )
    const rumor = this.nip44Decrypt(
      unwrappedSeal,
      Buffer.from((this.signer as NDKPrivateKeySigner).privateKey?.toString() || '', 'hex')
    )
    return { rumor, seal: unwrappedSeal }
  }

  async handleGiftWrapEvent(rumor: Rumor) : Promise<void> {
    const mostroNpub = this.options.mostroPubKey
    const mostroHex = nip19.decode(mostroNpub).data as string
    if (rumor.pubkey === mostroHex) {
      this.mostroMessageCallback(rumor.content, rumor as MostroEvent)
    } else {
      // TODO: handle this
      console.warn('🚨 received gift wrap from unknown pubkey: ', rumor.pubkey)
    }
  }

  unsubscribeDMs() {
    console.log('🚫 unsubscribing to DMs')
    const subscription = this.subscriptions.get(NOSTR_ENCRYPTED_DM_KIND)
    if (subscription) {
      subscription.stop()
      this.subscriptions.delete(NOSTR_ENCRYPTED_DM_KIND)
    }
    this.dmQueue = []
    this.dmEoseReceived = false
  }

  async publishEvent(event: NDKEvent) {
    try {
      const poolSize = this.ndk.pool.size()
      const relays = await event.publish()
      // console.log(`📡 Event published to [${relays.size}/${poolSize}] relays`)
    } catch (err) {
      console.error('Error publishing event: ', err)
    }
  }

  async fetchProfile(params: GetUserParams) : Promise<NDKUserProfile | null> {
    const user = this.ndk.getUser(params)
    if (!user) return null
    return await user.fetchProfile()
  }

  async signEvent(event: NDKEvent): Promise<void> {
    if (this._signer) {
      await event.sign(this._signer)
    } else {
      throw new Error('No signer available to sign the event')
    }
  }

  async decryptMessage(ev: NDKEvent): Promise<string> {
    const authStore = useAuth()
    if (!this._signer) {
      throw new Error('No signer available to decrypt the message')
    }
    const { sender, recipient } = this.obtainParties(ev)

    if (sender.pubkey === authStore.pubKey) {
      // I was the sender
      return await this._signer.decrypt(recipient, ev.content)
    } else {
      // I was the recipient
      return await this._signer.decrypt(sender, ev.content)
    }
  }

  /**
   * Function used to extract the two participating parties in this communication.
   *
   * @param ev - The event from which to extract the parties
   * @returns The two parties
   */
  obtainParties(ev: NDKEvent) : NIP04Parties {
    if (ev.kind !== 4) {
      throw Error('Trying to obtain parties of a non NIP-04 message')
    }
    const parties = ev.tags
      .filter(([k, _v]) => k === 'p')
    const _recipient = parties.find(([k, v]) => k === 'p' && v !== ev.author.pubkey)
    if (!_recipient) {
      console.error(`No recipient found in event: `, ev.rawEvent())
      throw new Error(`No recipient found in event with id: ${ev.rawEvent().id}`)
    }
    const recipient = new NDKUser({
      hexpubkey: _recipient[1]
    })
    return {
      sender: ev.author,
      recipient
    }
  }

  nip44ConversationKey(privateKey: Uint8Array, publicKey: string) {
    return nip44.v2.utils.getConversationKey(Buffer.from(privateKey), publicKey)
  }

  nip44Encrypt(data: EventTemplate, privateKey: Uint8Array, publicKey: string) {
    return nip44.v2.encrypt(JSON.stringify(data), this.nip44ConversationKey(privateKey, publicKey))
  }

  nip44Decrypt(data: NostrEvent, privateKey: Uint8Array) {
    return JSON.parse(nip44.v2.decrypt(data.content, this.nip44ConversationKey(privateKey, data.pubkey)))
  }

  now() {
    return Math.round(Date.now() / 1000)
  }

  randomNow() {
    return Math.round(this.now() - (Math.random() * GIFT_WRAP_TIME_WINDOW))
  }

  createRumor(event: Partial<UnsignedEvent>, privateKey: Uint8Array) : Rumor {
    const rumor = {
      created_at: this.now(),
      content: "",
      tags: [],
      ...event,
      pubkey: getPublicKey(privateKey),
    } as any

    rumor.id = getEventHash(rumor)
    return rumor as Rumor
  }

  createSeal(rumor: Rumor, privateKey: Uint8Array, recipientPublicKey: string) : NostrEvent {
    return finalizeEvent(
      {
        kind: NOSTR_SEAL_KIND,
        content: this.nip44Encrypt(rumor, privateKey, recipientPublicKey),
        created_at: this.randomNow(),
        tags: [],
      },
      privateKey
    ) as NostrEvent
  }

  createWrap(event: NostrEvent, recipientPublicKey: string) : NostrEvent {
    const randomKey = generateSecretKey()
    return finalizeEvent(
      {
        kind: NOSTR_GIFT_WRAP_KIND,
        content: this.nip44Encrypt(event, randomKey, recipientPublicKey),
        created_at: this.randomNow(),
        tags: [["p", recipientPublicKey]],
      },
      randomKey
    ) as NostrEvent
  }

  updatePrivKey(newPrivKey: string | null) {
    if (newPrivKey) {
      try {
        const newPubKey = getPublicKey(Buffer.from(newPrivKey, 'hex'))
        this.signer = new NDKPrivateKeySigner(newPrivKey)
        this.updatePubKey(newPubKey)
      } catch (err) {
        console.error('Error while trying to decode nsec: ', err);
      }
    } else {
      console.warn('🔑 clearing priv key')
      this.signer = undefined;
    }
  }

  updatePubKey(newPubKey: string | null | undefined) {
    if (newPubKey) {
      this.subscribeDMs(newPubKey);
      this.subscribeGiftWraps(newPubKey);
    } else {
      this.unsubscribeDMs();
      // You might want to add an unsubscribeGiftWraps method if needed
    }
  }

  async submitDirectMessage(message: string, destination: string, replyTo?: string): Promise<void> {
    if (!this._signer) {
      console.error('❗ No signer found')
      return
    }
    const myPubkey = await this._signer.user().then(user => user.pubkey)
    if (!myPubkey) {
      console.error('❗ No pubkey found')
      return
    }
    const destinationPubKey = nip19.decode(destination).data as string
    const recipient = new NDKUser({ hexpubkey: destinationPubKey })
    const ciphertext = await this._signer.encrypt(recipient, message)
    const event = new NDKEvent(this.ndk)
    event.kind = NOSTR_ENCRYPTED_DM_KIND
    event.created_at = Math.floor(Date.now() / 1000)
    event.content = ciphertext
    event.pubkey = myPubkey
    event.tags = [
      ['p', destinationPubKey],
      ['p', myPubkey]
    ]
    if (replyTo) {
      event.tags.push(['e', replyTo, '', 'reply'])
    }
    await event.sign(this._signer)
    await this.publishEvent(event)
  }

  async signAndPublishEvent(event: NDKEvent): Promise<void> {
    if (this._signer instanceof NDKPrivateKeySigner) {
      const mostroNpub = this.options.mostroPubKey
      const mostroDecoded = nip19.decode(mostroNpub)
      const mostroPubKey = mostroDecoded.data as string

      if (!this._signer.privateKey) {
        console.error('❗ No private key found')
        return
      }
      const privateKeyBuffer = Buffer.from(this._signer.privateKey, 'hex')
      const rumor = this.createRumor(event.rawEvent(), privateKeyBuffer)
      const seal = this.createSeal(rumor, privateKeyBuffer, mostroPubKey)
      const giftWrappedEvent = this.createWrap(seal, mostroPubKey)
      return await this.publishEvent(new NDKEvent(this.ndk, giftWrappedEvent))
    } else {
      throw new Error('NDKNip07Signer is no longer supported. Please use NDKPrivateKeySigner.')
    }
  }

  async createAndPublishMostroEvent(payload: object, mostroPubKey: string): Promise<void> {
    const cleartext = JSON.stringify(payload)
    const myPubKey = await this._signer?.user().then(user => user.pubkey)
    if (!myPubKey) {
      console.error(`No pubkey found`)
      return
    }
    const event = new NDKEvent(this.ndk)
    event.kind = NDKKind.Text,
    event.created_at = Math.floor(Date.now() / 1000)
    event.content = cleartext
    event.pubkey = myPubKey
    event.tags = [['p', mostroPubKey]]
    // const nEvent = await event.toNostrEvent()
    // console.info('> [🎁][me -> 🧌]: ', cleartext, ', ev: ', nEvent)
    return await this.signAndPublishEvent(event)
  }
}
