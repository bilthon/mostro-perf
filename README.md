# Mostro RTT (Round Trip Time) Tester

A testing utility for measuring the round-trip time of various operations in the Mostro protocol, a decentralized peer-to-peer Bitcoin exchange system built on Nostr.

## Overview

This tool measures the performance of key operations in both buyer-initiated and seller-initiated trades on the Mostro network. It simulates complete trade flows and records timing data for critical operations.

## Measured Operations

For each trade flow (both buyer and seller as maker), the following operations are timed:

- `submit-order`: Time to submit a new order to the network
- `take-sell`/`take-buy`: Time to accept an existing order
- `add-invoice`: Time to add a Lightning invoice
- `fiatsent`: Time to mark fiat as sent
- `release`: Time to release funds

## Prerequisites

- Node.js
- A Lightning node (LND) with API access
- Access to Mostro relays

## Setup

1. Create an `lnd` directory in your project root:

## Configuration

The tool uses the following configuration:

- Default Mostro relay: `wss://relay.mostro.network`
- Secondary relay: `wss://nostr.bilthon.dev`
- Output file: `./output/mostro-rtt.csv`

## Environment Variables

Create a `.env` file with your Lightning node configuration:

LND_GRPC_HOST=your-lnd-host