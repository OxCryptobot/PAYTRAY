# PayTray Phase 1 Client Surface

This package is the smallest validating client surface for the PayTray product loop: discover an expert, carry match context into an engagement preview, and request a durable payment intent without treating the request as chain settlement.

## Run locally

From the repository root, serve this directory with any static HTTP server:

```bash
python3 -m http.server 4173 --directory packages/client
```

Then open `http://localhost:4173`.

The client expects the backend v2 API at `http://localhost:3001` by default. To point it at another backend before loading the page, set `window.PAYTRAY_API_BASE` in the browser context. A wallet provider is required for the testnet payment-intent action. The client does not contain a private key, does not sign a transaction itself, and does not display a payment as settled merely because an intent exists.

## Current scope

The surface intentionally uses curated Phase 1 discovery fixtures while the backend discovery index is being normalized. Its expert cards expose match quality, fit context, availability, and trust labels. The engagement panel separates collaboration handoff from payment intent creation and labels the payment state as `unverified` until the verifier-backed chain path is connected.
