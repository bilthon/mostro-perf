import "websocket-polyfill";
import NDK, { NDKRelay } from "@nostr-dev-kit/ndk";

// import chalk from "chalk";
import { verifyEvent } from "nostr-tools";
const log = console.log;
const time = console.time;
const timeEnd = console.timeEnd;
// const info = chalk.bold.white;
// const error = chalk.bold.red;
// const infoLog = (...args: string[]) => log(info(...args));

// infoLog(`Starting perftest`);

const main = async () => {
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
  
  // await fetchAndVerifyEvents("With verification", false);
  // await fetchAndVerifyEvents("With no verification", true);
  
  async function fetchAndVerifyEvents(label: string, skipVerification: boolean) {
      // infoLog(label);
      // time(info("fetchEvents"));
      const events = await ndk.fetchEvents({ limit: 2000 }, { groupable: false, skipVerification });
      // timeEnd(info("fetchEvents"));
      // infoLog(`Fetched ${events.size} events`);
  
      const eventObjects = Array.from(events.values()).map((e) => e.rawEvent());
  
      // time(info("verifySignature"));
      for (const event of eventObjects) {
          verifyEvent(event as any);
      }
      // timeEnd(info("verifySignature"));
  }
}
main()