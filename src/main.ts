import 'websocket-polyfill'
import 'dotenv/config'
import { nip19, getPublicKey, generateSecretKey } from 'nostr-tools'
import { Mostro } from './mostro'
import { Action, MostroMessage, NewOrder, Order, OrderStatus, OrderType } from './types'
import { getInvoice, payInvoice } from './lightning'

const time = console.time
const timeEnd = console.timeEnd

// const MOSTRO_NPUB = 'npub19m9laul6k463czdacwx5ta4ap43nlf3lr0p99mqugnz8mdz7wtvskkm5wg'
const MOSTRO_NPUB = 'npub12z33fmw0stukyz4gx97l7taenxyylsydcn62hretgzzd7z6zu4qsal6xsa'
// const RELAYS = 'wss://nostr.roundrockbitcoiners.com,wss://relay.mostro.network,wss://relay.nostr.net,wss://nostr.mutinywallet.com,wss://relay.piazza.today,wss://nostr.lu.ke'
// const RELAYS = 'wss://relay.mostro.network,wss://algo.bilthon.dev'
const RELAYS = 'wss://nostr.bilthon.dev'

// Private keys
const buyerPrivateKey = Buffer.from(generateSecretKey()).toString('hex')
const sellerPrivateKey = Buffer.from(generateSecretKey()).toString('hex')

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
    console.log(`🔑 mostro pubkey.... [${nip19.decode(MOSTRO_NPUB).data}]`)
    console.log(`🔑 buyer keys....... [private: ${buyerPrivateKey}, public: ${getPublicKey(Buffer.from(buyerPrivateKey, 'hex'))}]`)
    console.log(`🔑 seller keys...... [private: ${sellerPrivateKey}, public: ${getPublicKey(Buffer.from(sellerPrivateKey, 'hex'))}]`)
  
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
    await waitSeconds(5)
  
    // Create an order
    const testOrder: NewOrder = {
      kind: OrderType.SELL,
      fiat_code: 'PEN',
      amount: 0,
      fiat_amount: 0,
      min_amount: 5,
      max_amount: 22,
      payment_method: 'cashapp',
      premium: 5,
      created_at: Date.now(),
      status: OrderStatus.PENDING,
    }
  
    console.log('Submitting order...')
    let response: MostroMessage
    try {
      time('> submit_order')
      response = await sellerMostro.submitOrder(testOrder)
      timeEnd('> submit_order')
      // console.log('[🎁][🧌 -> me] :', response)
    } catch (error) {
      console.error('Error submitting order:', error)
      return
    }

    let sats: number | undefined
    if (response && response.order && response.order.content && response.order.content.order) {
      order = response.order.content.order
      console.log('Taking sell...')
      try {
        time('> take_sell')
        response = await buyerMostro.takeSell(order, 15)
        timeEnd('> take_sell')
        sats = response.order.content.order?.amount
        // console.log('[🎁][🧌 -> me] :', JSON.stringify(response))
      } catch (error) {
        console.error('Error taking sell:', error)
        return
      }
    } else {
      console.warn('Got an unexpected response: ', response)
      return
    }

    // Fetching invoice
    let invoice: string | undefined
    if (sats) {
      time('> fetch_invoice')
      const invoiceResult = await getInvoice(sats)
      timeEnd('> fetch_invoice')
      invoice = invoiceResult.request
    } else {
      console.warn('No sats to fetch invoice')
      return
    }

    // Add invoice
    time('> add_invoice')
    buyerMostro.addInvoice(order, invoice, sats)
      .then(res => {
        timeEnd('> add_invoice')
      })
      .catch(err => {
        console.error('Error adding invoice:', err)
        return
      })


    // Wait for PayInvoice action from Mostro
    let invoiceToPay: string | undefined
    time('wait_for_pay_invoice')
    try {
      const payInvoiceMessage = await sellerMostro.waitForAction(Action.PayInvoice, order.id, 120000)
      if (payInvoiceMessage.order.content && payInvoiceMessage.order.content.payment_request) {
        invoiceToPay = payInvoiceMessage.order.content.payment_request[1] as string
      } else {
        console.warn('Got an unexpected response: ', payInvoiceMessage)
        return
      }
    } catch (error) {
      console.error('Error waiting for PayInvoice action:', error)
      return
    }
    timeEnd('wait_for_pay_invoice')

    // Pay hodl invoice
    payInvoice(invoiceToPay).then(res => {
      console.log('Payment settled!')
    }).catch(err => {
      console.error('Error paying invoice:', err)
      return
    })

    // Waiting for seller confirmation
    const sellerConfirmationMsg = await sellerMostro.waitForAction(Action.BuyerTookOrder, order.id, 120000)
    // Waiting for buyer confirmation
    const buyerConfirmationMsg = await buyerMostro.waitForAction(Action.HoldInvoicePaymentAccepted, order.id, 120000)

    // Send fiatsent
    try {
      time('> fiatsent')
      await buyerMostro.fiatSent(order)
      timeEnd('> fiatsent')
    } catch (error) {
      console.error('Error sending fiatsent:', error)
      return
    }

    // Send release
    try {
      time('> release')
      await sellerMostro.release(order)
      timeEnd('> release')
    } catch (error) {
      console.error('Error sending release:', error)
      return
    }
  } catch (err) {
    console.error('Error:', err)
  }
}

main().catch(console.error)
