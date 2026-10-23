const express = require("express");
const { PesaJet } = require("@pesajet/sdk");
const { createClient } = require("@supabase/supabase-js");
const crypto = require("node:crypto");

const app = express();
app.set("trust proxy", 1);

const requiredEnv = ["PESAJET_API_KEY", "PESAJET_WEBHOOK_SIGNING_SECRET", "SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"];
const missing = requiredEnv.filter((key) => !process.env[key]);
if (missing.length) {
  console.error("Missing required environment variables:", missing.join(", "));
  process.exit(1);
}

const pesajet = new PesaJet({
  apiKey: process.env.PESAJET_API_KEY,
  webhookSecret: process.env.PESAJET_WEBHOOK_SIGNING_SECRET
});
const supabaseAuth = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});
const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

const PREMIUM_AMOUNT_UGX = 10000;
const PREMIUM_MONTHS = 2;
const allowedProviders = new Set(["mtn", "airtel"]);
app.use(express.json({ limit: "100kb" }));

app.get("/", (_req, res) => res.json({ ok: true, service: "DJ WHISTER 256 PesaJet Payments", status: "ready" }));
app.get("/health", (_req, res) => res.json({ ok: true }));

async function requireUser(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return res.status(401).json({ error: "Sign in first." });
  const { data, error } = await supabaseAuth.auth.getUser(token);
  if (error || !data?.user) return res.status(401).json({ error: "Invalid or expired sign-in session." });
  req.user = data.user;
  next();
}

app.post("/api/payments/create", requireUser, async (req, res) => {
  try {
    const phoneNumber = String(req.body.phoneNumber || "").trim();
    const provider = String(req.body.provider || "").toLowerCase();
    if (!/^\+256\d{9}$/.test(phoneNumber)) {
      return res.status(400).json({ error: "Enter a Ugandan phone number in +256XXXXXXXXX format." });
    }
    if (!allowedProviders.has(provider)) return res.status(400).json({ error: "Choose mtn or airtel." });

    const reference = "DWW256-" + crypto.randomUUID();
    const { data: order, error: insertError } = await supabaseAdmin.from("whister_payment_orders").insert({
      user_id: req.user.id, reference, product: "premium_2_months", amount: PREMIUM_AMOUNT_UGX,
      currency: "UGX", phone_number: phoneNumber, provider, status: "pending"
    }).select("id, reference, amount, currency, status").single();
    if (insertError) throw insertError;

    const payment = await pesajet.payments.create({
      amount: PREMIUM_AMOUNT_UGX, currency: "UGX", phoneNumber, provider, reference,
      description: "DJ WHISTER 256 Premium - 2 months"
    });
    const { error: updateError } = await supabaseAdmin.from("whister_payment_orders")
      .update({ transaction_id: payment.transactionId || null }).eq("id", order.id);
    if (updateError) console.error("Could not save transaction ID:", updateError.message);

    return res.json({ ok: true, orderId: order.id, reference, transactionId: payment.transactionId || null,
      status: payment.status || "PENDING", amount: PREMIUM_AMOUNT_UGX, currency: "UGX",
      message: "Approve the mobile-money prompt. Premium access is granted only after a verified successful payment." });
  } catch (error) {
    console.error("Payment creation failed:", error?.message || error);
    return res.status(502).json({ error: "Could not start payment. Check backend logs and PesaJet account configuration." });
  }
});

// Configure this URL in PesaJet after deployment: https://YOUR-RENDER-HOST/webhooks/pesajet
app.post("/webhooks/pesajet", async (req, res) => {
  try {
    const signature = req.headers["x-webhook-signature"];
    const valid = signature && pesajet.webhooks.verify(req.body, signature);
    if (!valid) return res.status(401).json({ error: "Invalid webhook signature." });

    const event = req.body || {};
    if (event.event !== "payment.completed") return res.status(200).json({ received: true, ignored: true });
    const reference = String(event.reference || "");
    const transactionId = String(event.transactionId || "");
    const amount = Number(event.amount);
    if (!reference || !transactionId || !Number.isFinite(amount)) {
      return res.status(400).json({ error: "Missing reference, transaction ID, or amount." });
    }

    const { data: order, error: findError } = await supabaseAdmin.from("whister_payment_orders")
      .select("*").eq("reference", reference).maybeSingle();
    if (findError) throw findError;
    if (!order) return res.status(404).json({ error: "Payment reference not found." });
    if (Number(order.amount) !== amount || order.currency !== "UGX") return res.status(400).json({ error: "Payment amount mismatch." });
    if (order.status === "paid") return res.status(200).json({ received: true, duplicate: true });

    const { error: paidError } = await supabaseAdmin.from("whister_payment_orders")
      .update({ status: "paid", transaction_id: transactionId, paid_at: new Date().toISOString() })
      .eq("id", order.id).neq("status", "paid");
    if (paidError) throw paidError;

    const { data: existing, error: accessReadError } = await supabaseAdmin.from("whister_premium_access")
      .select("access_until").eq("user_id", order.user_id).maybeSingle();
    if (accessReadError) throw accessReadError;
    const now = new Date();
    const oldExpiry = existing?.access_until ? new Date(existing.access_until) : now;
    const expiry = new Date(oldExpiry > now ? oldExpiry : now);
    expiry.setMonth(expiry.getMonth() + PREMIUM_MONTHS);
    const { error: accessError } = await supabaseAdmin.from("whister_premium_access").upsert({
      user_id: order.user_id, access_until: expiry.toISOString(), last_payment_reference: reference,
      updated_at: now.toISOString()
    }, { onConflict: "user_id" });
    if (accessError) throw accessError;
    return res.json({ received: true, premiumAccessGranted: true });
  } catch (error) {
    console.error("Webhook processing failed:", error?.message || error);
    return res.status(500).json({ error: "Webhook processing failed." });
  }
});

const port = Number(process.env.PORT || 10000);
app.listen(port, "0.0.0.0", () => console.log("PesaJet backend listening on", port));
