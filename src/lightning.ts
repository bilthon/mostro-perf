import { existsSync, readFileSync } from 'fs'
import { authenticatedLndGrpc, createInvoice, CreateInvoiceResult } from 'lightning'
import * as path from 'path'

const certPath = path.resolve(__dirname, '../lnd/tls.cert')
const macaroonPath = path.resolve(__dirname, '../lnd/admin.macaroon')

const host = process.env.LND_HOST
if (!host) {
  throw new Error('LND_HOST is not configured')
}

if (!existsSync(certPath)) {
  throw Error(`Could not find TLS certificate at ${certPath}`)
}
if (!existsSync(macaroonPath)) {
  throw new Error(`Could not find macaroon at ${macaroonPath}`)
}

// Loading TLS certificate data, this is optional
const cert = readFileSync(certPath).toString('base64')
// Loading the macaroon data
const macaroon = readFileSync(macaroonPath).toString('base64')

// Use these credentials to connect to the LND node
const authenticatedLnd = authenticatedLndGrpc({
  cert,
  macaroon,
  socket: host,
})

const lnd = authenticatedLnd.lnd

export const getInvoice = async (tokens: number, expirySeconds: number = 3600, memo: string = '') => {
  const expiresAt = new Date(Date.now() + expirySeconds * 1000).toISOString()
  const invoice: CreateInvoiceResult = await createInvoice({
    lnd: lnd,
    tokens: tokens,
    description: memo,
    expires_at: expiresAt
  })
  return invoice
}
