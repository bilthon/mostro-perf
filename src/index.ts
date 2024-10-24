import "websocket-polyfill";
import NDK, { NDKRelay } from "@nostr-dev-kit/ndk";
import { Nostrito } from "./nostrito"

async function connect3() {
  const ndk = new NDK();
  const relays = [
    'wss://nostr.roundrockbitcoiners.com',
    'wss://relay.mostro.network',
    'wss://relay.nostr.net',
    'wss://nostr.mutinywallet.com',
    'wss://relay.piazza.today',
    'wss://nostr.lu.ke'
  ].map(url => new NDKRelay(url, undefined, ndk))
  
  ndk.pool.on("relay:connect", (r: NDKRelay) => {
      // infoLog(`Connected to relay ${r.url}`);
      console.log('Connected to relay', r.url)
  });
  ndk.pool.on('relay:connecting', (relay: NDKRelay) => {
    console.log(`Connecting to relay: ${relay.url}...`)
  })

  ndk.pool.on('connect', () => {
    console.log('🎉Connected to all relays')
  })
  for (const relay of relays) {
      // ndk.addExplicitRelay(relay, undefined, false);
      ndk.pool.addRelay(relay, true)
      // log(relay.url);
  }
  await ndk.connect(2000);
}

async function main() {
  // const nostrito = new Nostrito()
  // await nostrito.connect()
  // await nostrito.connect2()

  await connect3()
}

main().then(() => console.log('Done')).catch(console.error)