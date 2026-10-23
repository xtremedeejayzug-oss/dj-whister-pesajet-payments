# DJ WHISTER 256 — PesaJet payments backend

Node/Express backend for PesaJet MTN Mobile Money and Airtel Money collections. Current example product: UGX 10,000 for two months of Premium access.

## Deploy on Render
Create a Web Service from this repository. Build command: `npm install`; Start command: `npm start`; Node 20+.

Set these private environment variables in Render:
- `PESAJET_API_KEY` — PesaJet API key
- `PESAJET_WEBHOOK_SIGNING_SECRET` — PesaJet webhook signing secret
- `SUPABASE_URL` — `https://zoqzdwgyzcoapftjgobk.supabase.co`
- `SUPABASE_ANON_KEY` — Supabase publishable/anon key
- `SUPABASE_SERVICE_ROLE_KEY` — Supabase service-role key (never place in HTML or GitHub)

The PesaJet dashboard also shows an API Secret. Verify the current integration instructions for your account/API to confirm whether it is required separately; do not put it in source code.

## Supabase
Run `schema.sql` in Supabase SQL Editor before testing.

## Webhook
After deployment, set the PesaJet webhook notification endpoint to `https://YOUR-RENDER-SERVICE.onrender.com/webhooks/pesajet`, replacing the host with the real Render hostname.

## Routes
- `GET /` and `GET /health` — health check
- `POST /api/payments/create` — requires `Authorization: Bearer <Supabase access token>` and JSON `{"phoneNumber":"+2567XXXXXXXX","provider":"mtn"}` (or `airtel`)
- `POST /webhooks/pesajet` — signed PesaJet webhook

Premium access is granted only after a signature-verified `payment.completed` webhook with the expected amount. Test with PesaJet test credentials if available before taking live payments. The frontend must be connected to these endpoints and must check access expiry securely; this backend alone does not modify your website UI.
