import 'websocket-polyfill'
import 'dotenv/config'
import { nip19, getPublicKey } from 'nostr-tools'
import { Mostro, MostroEvent } from './mostro'
import { MostroMessage, NewOrder, Order, OrderStatus, OrderType } from './types'

const time = console.time
const timeEnd = console.timeEnd

// const MOSTRO_NPUB = 'npub19m9laul6k463czdacwx5ta4ap43nlf3lr0p99mqugnz8mdz7wtvskkm5wg'
const MOSTRO_NPUB = 'npub1pjzttkjtvtav98dck549ghut6wn72p8tylfptcmgfjkw47ay2fzszwkfyt'
// const RELAYS = 'wss://nostr.roundrockbitcoiners.com,wss://relay.mostro.network,wss://relay.nostr.net,wss://nostr.mutinywallet.com,wss://relay.piazza.today,wss://nostr.lu.ke'
// const RELAYS = 'wss://relay.mostro.network,wss://algo.bilthon.dev'
const RELAYS = 'wss://rnostr.bilthon.dev'

// Private keys
const buyerPrivateKey = 'f3587ff35141123e17dfad04d1bdcc9acd2f5a25cf81ae6baf6c1557dd4cbbe9'
const sellerPrivateKey = '9c283f96cbfb051f22e9e87198002c226f3b72416e6cc0dd14c50455996dfea7'

const RESPONSE_TIMEOUT_MS = 120000 // 120 seconds

function createResponsePromise(mostro: Mostro, timeoutMs: number = RESPONSE_TIMEOUT_MS): Promise<MostroMessage> {
  return new Promise<MostroMessage>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      mostro.off('mostro-message', messageHandler)
      reject(new Error('Response timeout'))
    }, timeoutMs)

    const messageHandler = (mostroMessage: MostroMessage, ev: MostroEvent) => {
      clearTimeout(timeoutId)
      console.log('🚀 ~ Got response:', mostroMessage)
      mostro.off('mostro-message', messageHandler)
      resolve(mostroMessage)
    }

    mostro.on('mostro-message', messageHandler)
  })
}

async function waitSeconds(seconds: number) {
  let counter = 0
  console.log(`Waiting for ${counter} seconds...`)
  while (counter < seconds) {
    console.log(`${seconds - counter}`)
    counter++
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
}

async function main() {
  try {
    console.log(`🔑 mostro pubkey: ${nip19.decode(MOSTRO_NPUB).data}`)
    console.log(`🔑 buyer keys\nprivate: ${buyerPrivateKey},\npublic: ${getPublicKey(Buffer.from(buyerPrivateKey, 'hex'))}`)
    console.log(`🔑 seller keys\nprivate: ${sellerPrivateKey},\npublic: ${getPublicKey(Buffer.from(sellerPrivateKey, 'hex'))}`)
  
    let order: Order | undefined

    // Initialize Buyer side
    const buyerMostro = new Mostro({
      mostroPubKey: MOSTRO_NPUB,
      relays: RELAYS
    })
    await buyerMostro.connect()
    buyerMostro.updatePrivKey(buyerPrivateKey)
  
  
    // Initialize Seller side
    const sellerMostro = new Mostro({
      mostroPubKey: MOSTRO_NPUB,
      relays: RELAYS
    })
    await sellerMostro.connect()
    sellerMostro.updatePrivKey(sellerPrivateKey)

    console.log('Waiting for 5 seconds before creating order...')
    await new Promise(resolve => setTimeout(resolve, 5000))
  
    // Create an order
    const testOrder: NewOrder = {
      kind: OrderType.SELL,
      fiat_code: 'USD',
      amount: 0,
      fiat_amount: 0,
      min_amount: 1,
      max_amount: 21,
      payment_method: 'cashapp',
      premium: 10,
      created_at: Date.now(),
      status: OrderStatus.PENDING,
    }
  
    console.log('Submitting order...')
    const submitOrderPromise = createResponsePromise(buyerMostro)
    await buyerMostro.submitOrder(testOrder)

    console.log('Waiting for the response after submitting order...')
    let response: MostroMessage
    try {
      response = await submitOrderPromise
    } catch (error) {
      console.error('Error waiting for submit order response:', error)
      return // or handle the error as appropriate
    }

    if (response && response.order && response.order.content && response.order.content.order) {
      order = response.order.content.order
      console.log('Taking sell...')
      const takeSellPromise = createResponsePromise(buyerMostro)
      time('take_sell')
      await buyerMostro.takeSell(response.order.content.order, 20)
      try {
        response = await takeSellPromise
      } catch (error) {
        console.error('Error waiting for take sell response:', error)
        return // or handle the error as appropriate
      }
      timeEnd('take_sell')
    } else {
      console.warn('Got an unexpected response: ', response)
    }
    timeEnd('submit_order')

    // const invoice = getInvoice()
    // await buyerMostro.addInvoice(order, invoice, null)
  } catch (err) {
    console.error('Error:', err)
  }
}

main().catch(console.error)
