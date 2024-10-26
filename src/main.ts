import 'websocket-polyfill'
import 'dotenv/config'
import { nip19, getPublicKey, generateSecretKey } from 'nostr-tools'
import { Mostro } from './mostro'
import { Action, MostroMessage, NewOrder, Order, OrderStatus, OrderType } from './types'
import { getInvoice, payInvoice } from './lightning'
import * as fs from 'fs'

const time = console.time
const timeEnd = console.timeEnd

// const MOSTRO_NPUB = 'npub19m9laul6k463czdacwx5ta4ap43nlf3lr0p99mqugnz8mdz7wtvskkm5wg'
const MOSTRO_NPUB = 'npub1dnsaeuyhwp2mtlttaqu6ulxuqg8gcpc2tdhu5qv9wfxjh5al0cfqqd59x3'
// const RELAYS = 'wss://nostr.roundrockbitcoiners.com,wss://relay.mostro.network,wss://relay.nostr.net,wss://nostr.mutinywallet.com,wss://relay.piazza.today,wss://nostr.lu.ke'
// const RELAYS = 'wss://relay.mostro.network,wss://algo.bilthon.dev'
const RELAYS = 'wss://nostr.roundrockbitcoiners.com,wss://relay.mostro.network,wss://nostr.bilthon.dev'
const CSV_FILE = './output/mostro-rtt.csv'

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

async function runIteration(): Promise<{ [key: string]: number } | undefined> {
  const measurements: { [key: string]: number } = {
    submit_order: 0,
    take_sell: 0,
    add_invoice: 0,
    fiatsent: 0,
    release: 0
  }

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
    min_amount: 10,
    max_amount: 25,
    payment_method: 'cashapp',
    premium: 5,
    created_at: Date.now(),
    status: OrderStatus.PENDING,
  }

  let response: MostroMessage

  // Measure submit_order
  const submitOrderStart = Date.now()
  response = await sellerMostro.submitOrder(testOrder)
  measurements.submit_order = Date.now() - submitOrderStart

  if (response.order.content && response.order.content.order) {
    order = response.order.content.order
  } else {
    console.warn('Got an unexpected response: ', response)
    return
  }

  // Measure take_sell
  const takeSellStart = Date.now()
  response = await buyerMostro.takeSell(order, 15)
  measurements.take_sell = Date.now() - takeSellStart

  let sats: number | undefined
  if (response.order.content && response.order.content.order) {
    sats = response.order.content.order.amount
  } else {
    console.warn('Got an unexpected response: ', response)
    return
  }
  // Fetching invoice
  let invoice: string | undefined
  if (sats) {
    const invoiceResult = await getInvoice(sats)
    invoice = invoiceResult.request
  } else {
    console.warn('No sats to fetch invoice')
    return
  }

  // Add invoice
  const addInvoiceStart = Date.now()
  buyerMostro.addInvoice(order, invoice, sats)
    .then(res => {
      measurements.add_invoice = Date.now() - addInvoiceStart
    })
    .catch(err => {
      console.error('Error adding invoice:', err)
      return
    })
  
  // Wait for PayInvoice action from Mostro
  let invoiceToPay: string | undefined
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

  // Pay hodl invoice
  payInvoice(invoiceToPay).then(res => {
    // console.log('Payment settled!')
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
    const fiatsentStart = Date.now()
    await buyerMostro.fiatSent(order)
    measurements.fiatsent = Date.now() - fiatsentStart
  } catch (error) {
    console.error('Error sending fiatsent:', error)
    return
  }

  // Send release
  try {
    const releaseStart = Date.now()
    await sellerMostro.release(order)
    measurements.release = Date.now() - releaseStart
  } catch (error) {
    console.error('Error sending release:', error)
    return
  }

  return measurements
}

async function main() {
  const iterations = 10 // Number of iterations to run
  const results: { [key: string]: number }[] = []

  // Create CSV header
  const csvHeader = 'submit_order,take_sell,add_invoice,fiatsent,release\n'
  fs.writeFileSync(CSV_FILE, csvHeader)

  for (let i = 0; i < iterations; i++) {
    const measurement = await runIteration()
    if (measurement) {
      results.push(measurement)

      // Append result to CSV file
      const csvLine = `${measurement.submit_order},${measurement.take_sell},${measurement.add_invoice},${measurement.fiatsent},${measurement.release}\n`
      fs.appendFileSync(CSV_FILE, csvLine)

      console.log(`Iteration ${i + 1} completed`)
    } else {
      console.error(`Iteration ${i + 1} failed`)
    }

    // Wait for a short time between iterations
    await waitSeconds(5)
  }
  console.log(`All iterations completed. Results saved to ${CSV_FILE}`)
}

main().catch(console.error)
