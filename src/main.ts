import 'websocket-polyfill'
import 'dotenv/config'
import { nip19, getPublicKey, generateSecretKey } from 'nostr-tools'
import { Mostro } from './mostro'
import { Action, MostroMessage, NewOrder, Order, OrderStatus, OrderType } from './types'
import { getInvoice, payInvoice } from './lightning'
import * as fs from 'fs'
import { PayViaPaymentRequestResult } from 'lightning'
import pc from 'picocolors'

const MOSTRO_NPUB = 'npub178am9sl8hjcz90xvag4urz8fdn2wnw9lyeeez29gjrqczp932hxqcejd4y'
const RELAYS = 'wss://relay.mostro.network,wss://nostr.bilthon.dev'
const CSV_FILE = './output/mostro-rtt.csv'

const printKeys = (buyerPrivateKey: string, sellerPrivateKey: string, mostroPubKey: string) => {
  console.log(pc.bold('\n🔑 Keys Information:'))
  console.log(pc.cyan('┌───────────────────────────────────────────────────────────────────────────────────┐'))
  console.log(pc.cyan('│') + ` Mostro Pubkey:  ${pc.yellow(nip19.decode(mostroPubKey).data as string)}`);
  console.log(pc.cyan('│') + ` npub:          ${pc.gray(mostroPubKey)}`);
  console.log(pc.cyan('│'))
  console.log(pc.cyan('│') + ` Buyer Keys:`);
  console.log(pc.cyan('│') + `   Private:     ${pc.yellow(buyerPrivateKey)}`);
  console.log(pc.cyan('│') + `   Public:      ${pc.gray(getPublicKey(Buffer.from(buyerPrivateKey, 'hex')))}`);
  console.log(pc.cyan('│'))
  console.log(pc.cyan('│') + ` Seller Keys:`);
  console.log(pc.cyan('│') + `   Private:     ${pc.yellow(sellerPrivateKey)}`);
  console.log(pc.cyan('│') + `   Public:      ${pc.gray(getPublicKey(Buffer.from(sellerPrivateKey, 'hex')))}`);
  console.log(pc.cyan('└───────────────────────────────────────────────────────────────────────────────────┘'))
}

async function runSellerAsMaker(): Promise<{ [key: string]: number } | undefined> {
  // Private keys
  const buyerPrivateKey = Buffer.from(generateSecretKey()).toString('hex')
  const sellerPrivateKey = Buffer.from(generateSecretKey()).toString('hex')

  const measurements: { [key: string]: number } = {
    submit_order: 0,
    take_sell: 0,
    add_invoice: 0,
    fiatsent: 0,
    release: 0
  }

  printKeys(buyerPrivateKey, sellerPrivateKey, MOSTRO_NPUB)

  let order: Order | undefined

  // Initialize Buyer side
  const buyerMostro = new Mostro({
    mostroPubKey: MOSTRO_NPUB,
    relays: RELAYS,
    debug: false,
    baseRequestId: 1000000,
    name: 'buyer'
  })
  await buyerMostro.connect()
  buyerMostro.updatePrivKey(buyerPrivateKey)
  await new Promise(resolve => {
    buyerMostro.on('ready', () => {
      resolve(0)
    })
  })

  // Initialize Seller side
  const sellerMostro = new Mostro({
    mostroPubKey: MOSTRO_NPUB,
    relays: RELAYS,
    debug: false,
    baseRequestId: 10,
    name: 'seller'
  })
  await sellerMostro.connect()
  sellerMostro.updatePrivKey(sellerPrivateKey)

  // Override logging functions with colored versions
  buyerMostro.logIncoming = (requestId: number, msg: string) => 
    console.log(pc.bold(pc.green(`<< [${buyerMostro.name}] [${requestId}], ${msg}`)))
  buyerMostro.logOutgoing = (requestId: number, msg: string) => 
    console.log(pc.bold(pc.red(`>> [${buyerMostro.name}] [${requestId}], ${msg}`)))

  sellerMostro.logIncoming = (requestId: number, msg: string) => 
    console.log(pc.bold(pc.green(`<< [${sellerMostro.name}] [${requestId}], ${msg}`)))
  sellerMostro.logOutgoing = (requestId: number, msg: string) => 
    console.log(pc.bold(pc.red(`>> [${sellerMostro.name}] [${requestId}], ${msg}`)))

  await new Promise(resolve => {
    sellerMostro.on('ready', () => {
      resolve(0)
    })
  })

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

async function runBuyerAsMaker(): Promise<{ [key: string]: number } | undefined> {

  // Private keys
  const buyerPrivateKey = Buffer.from(generateSecretKey()).toString('hex')
  const sellerPrivateKey = Buffer.from(generateSecretKey()).toString('hex')

  const measurements: { [key: string]: number } = {
    submit_order: 0,
    take_buy: 0,
    add_invoice: 0,
    fiatsent: 0,
    release: 0
  }

  printKeys(buyerPrivateKey, sellerPrivateKey, MOSTRO_NPUB)

  let order: Order | undefined

  // Initialize Buyer side
  const buyerMostro = new Mostro({
    mostroPubKey: MOSTRO_NPUB,
    relays: RELAYS,
    baseRequestId: 500,
    debug: false,
    name: 'buyer'
  })
  await buyerMostro.connect()
  buyerMostro.updatePrivKey(buyerPrivateKey)

  // Initialize Seller side
  const sellerMostro = new Mostro({
    mostroPubKey: MOSTRO_NPUB,
    relays: RELAYS,
    baseRequestId: 200,
    debug: false,
    name: 'seller'
  })
  await sellerMostro.connect()
  sellerMostro.updatePrivKey(sellerPrivateKey)

  // Override logging functions with colored versions
  buyerMostro.logIncoming = (requestId: number, msg: string) => 
    console.log(pc.bold(pc.green(`<< [${buyerMostro.name}] [${requestId}], ${msg}`)))
  buyerMostro.logOutgoing = (requestId: number, msg: string) => 
    console.log(pc.bold(pc.red(`>> [${buyerMostro.name}] [${requestId}], ${msg}`)))

  sellerMostro.logIncoming = (requestId: number, msg: string) => 
    console.log(pc.bold(pc.green(`<< [${sellerMostro.name}] [${requestId}], ${msg}`)))
  sellerMostro.logOutgoing = (requestId: number, msg: string) => 
    console.log(pc.bold(pc.red(`>> [${sellerMostro.name}] [${requestId}], ${msg}`)))

  // Create a buy order
  const testOrder: NewOrder = {
    kind: OrderType.BUY,
    fiat_code: 'USD',
    amount: 0,
    fiat_amount: 0,
    min_amount: 5,
    max_amount: 20,
    payment_method: 'cashapp',
    premium: 3,
    created_at: Date.now(),
    status: OrderStatus.PENDING,
  }

  let response: MostroMessage

  // Measure submit_order
  const submitOrderStart = Date.now()
  response = await buyerMostro.submitOrder(testOrder)
  measurements.submit_order = Date.now() - submitOrderStart

  if (response.order.content && response.order.content.order) {
    order = response.order.content.order
  } else {
    console.warn('Got an unexpected response: ', response)
    return
  }

  try {
    // Measure take_buy
    const takeBuyStart = Date.now()
    response = await sellerMostro.takeBuy(order, 15)
    measurements.take_buy = Date.now() - takeBuyStart
  } catch (err) {
    console.error('Error taking buy:', err)
  }

  await buyerMostro.waitForAction(Action.WaitingSellerToPay, order.id, 15000)

  let hodlInvoicePromise: Promise<PayViaPaymentRequestResult> | undefined
  if (response.order.action === 'pay-invoice' && response.order.content.payment_request) {
    hodlInvoicePromise = payInvoice(response.order.content.payment_request[1] as string)
    hodlInvoicePromise.then(res => console.log(`Payment from seller to mostro settled!`)).catch(console.error)
  } else {
    console.warn('Was expecting a pay-invoice action, but got: ', response)
    return
  }

  const addInvoiceMsg = await buyerMostro.waitForAction(Action.AddInvoice, order.id, 60000)

  let invoice: string | undefined
  const sats = addInvoiceMsg.order?.content?.order?.amount
  if (sats) {
    const invoiceResult = await getInvoice(sats)
    invoice = invoiceResult.request
  } else {
    console.warn('No sats to fetch invoice')
    return
  }

  // Buyer adds invoice
  const addInvoiceStart = Date.now()
  await buyerMostro.addInvoice(order, invoice, sats)
  measurements.add_invoice = Date.now() - addInvoiceStart

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
  const iterations = 1 // Number of iterations to run
  const results: { [key: string]: number }[] = []

  // Create CSV header with combined columns for both flows
  const csvHeader = 'seller_submit_order,buyer_take_sell,seller_add_invoice,buyer_fiatsent,seller_release,' +
                   'buyer_submit_order,seller_take_buy,buyer_add_invoice,buyer_fiatsent,seller_release\n'
  fs.writeFileSync(CSV_FILE, csvHeader)

  let counter = 0
  while (counter < iterations) {
    try {
      console.log(`///////////// Running seller as maker ///////////// ${counter + 1}`)
      const sellMeasurement = await runSellerAsMaker()
      console.log(`///////////// Running buyer as maker ///////////// ${counter + 1}`)
      const buyMeasurement = await runBuyerAsMaker()

      if (sellMeasurement && buyMeasurement) {
        results.push({ ...sellMeasurement, ...buyMeasurement })

        // Combine both measurements into a single CSV line
        const csvLine = `${sellMeasurement.submit_order},${sellMeasurement.take_sell},${sellMeasurement.add_invoice},${sellMeasurement.fiatsent},${sellMeasurement.release},` +
                       `${buyMeasurement.submit_order},${buyMeasurement.take_buy},${buyMeasurement.add_invoice},${buyMeasurement.fiatsent},${buyMeasurement.release}\n`
        fs.appendFileSync(CSV_FILE, csvLine)

        console.log(`Iteration ${counter + 1} completed (both flows)`)
      } else {
        console.error(`Iteration ${counter + 1} failed`)
        if (!sellMeasurement) console.error('Seller as maker flow failed')
        if (!buyMeasurement) console.error('Buyer as maker flow failed')
      }

      counter++
    } catch (err) {
      console.error(`Error running iteration: ${counter + 1}`, err)
    }
  }
  console.log(`All iterations completed. Results saved to ${CSV_FILE}`)
}

main().catch(console.error)
