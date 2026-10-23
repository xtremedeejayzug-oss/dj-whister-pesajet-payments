const express = require("express");
const { PesaJet } = require("@pesajet/sdk");
const { createClient } = require("@supabase/supabase-js");
const crypto = require("node:crypto");

const app = express();
app.set("trust proxy", 1);

// CORS
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Webhook-Signature"
  );

  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: "100kb" }));

// Required environment variables
const requiredEnv = [
  "PESAJET_API_KEY",
  "PESAJET_WEBHOOK_SIGNING_SECRET",
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY"
];

const missing = requiredEnv.filter((key) => !process.env[key]);

if (missing.length) {
  console.error("Missing environment variables:", missing.join(", "));
  process.exit(1);
}

// Payment and database clients
const pesajet = new PesaJet({
  apiKey: process.env.PESAJET_API_KEY,
  webhookSecret: process.env.PESAJET_WEBHOOK_SIGNING_SECRET
});

const supabaseAuth = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

const allowedProviders = new Set(["mtn", "airtel"]);

// Product prices are fixed on the backend.
// Never accept the price supplied by the browser.
const PRODUCTS = {
  wigman_dj_drops: {
    name: "Wigman DJ Drops",
    amount: 10000,
    type: "one_time"
  },

  tagline: {
    name: "Tagline",
    amount: 8000,
    type: "one_time"
  },

  dj_intro: {
    name: "DJ Intro",
    amount: 15000,
    type: "one_time"
  },

  vinyl_skins: {
    name: "Vinyl Skins",
    amount: 180000,
    type: "one_time"
  },

  creator_studio_premium: {
    name: "Creator Studio Premium",
    amount: 20000,
    type: "subscription",
    months: 1
  },

  premium_software_downloads: {
    name: "Premium Software Downloads",
    amount: 20000,
    type: "subscription",
    months: 2
  },

  xxx_premium: {
    name: "XXX Premium",
    amount: 10000,
    type: "subscription",
    months: 2
  },

  blue_tick: {
    name: "Blue Tick Verification",
    amount: 5000,
    type: "verification"
  }
};

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "DJ WHISTER 256 PesaJet Payments",
    status: "ready"
  });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// Require a valid signed-in Supabase user.
async function requireUser(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ")
      ? header.slice(7)
      : "";

    if (!token) {
      return res.status(401).json({
        error: "Sign in first."
      });
    }

    const { data, error } = await supabaseAuth.auth.getUser(token);

    if (error || !data?.user) {
      return res.status(401).json({
        error: "Invalid or expired sign-in session."
      });
    }

    req.user = data.user;
    next();
  } catch (error) {
    console.error("Authentication error:", error.message);
    return res.status(401).json({ error: "Authentication failed." });
  }
}

// CREATE PAYMENT
// The browser sends product, phoneNumber and provider.
// The backend decides the price.
app.post("/api/payments/create", requireUser, async (req, res) => {
  try {
    const productId = String(req.body.product || "").trim();
    const phoneNumber = String(req.body.phoneNumber || "").trim();
    const provider = String(req.body.provider || "").toLowerCase();

    const product = PRODUCTS[productId];

    if (!product) {
      return res.status(400).json({
        error: "Unknown product.",
        availableProducts: Object.keys(PRODUCTS)
      });
    }

    if (!/^\+256\d{9}$/.test(phoneNumber)) {
      return res.status(400).json({
        error: "Enter a Ugandan phone number in +256XXXXXXXXX format."
      });
    }

    if (!allowedProviders.has(provider)) {
      return res.status(400).json({
        error: "Choose mtn or airtel."
      });
    }

    const reference = "DWW256-" + crypto.randomUUID();

    // Save the pending order before requesting payment.
    const { data: order, error: insertError } =
      await supabaseAdmin
        .from("whister_payment_orders")
        .insert({
          user_id: req.user.id,
          reference,
          product: productId,
          amount: product.amount,
          currency: "UGX",
          phone_number: phoneNumber,
          provider,
          status: "pending"
        })
        .select("id, reference, amount, currency, status")
        .single();

    if (insertError) throw insertError;

    try {
      const payment = await pesajet.payments.create({
        amount: product.amount,
        currency: "UGX",
        phoneNumber,
        provider,
        reference,
        description: "DJ WHISTER 256 - " + product.name
      });

      const { error: updateError } = await supabaseAdmin
        .from("whister_payment_orders")
        .update({
          transaction_id: payment.transactionId || null
        })
        .eq("id", order.id);

      if (updateError) {
        console.error("Could not save transaction ID:", updateError.message);
      }

      return res.json({
        ok: true,
        orderId: order.id,
        reference,
        transactionId: payment.transactionId || null,
        status: payment.status || "PENDING",
        product: productId,
        productName: product.name,
        amount: product.amount,
        currency: "UGX",
        message: "Approve the mobile-money prompt. Access is granted after verified payment."
      });
    } catch (paymentError) {
      console.error("PesaJet payment request failed:", paymentError.message);

      await supabaseAdmin
        .from("whister_payment_orders")
        .update({ status: "failed" })
        .eq("id", order.id)
        .eq("status", "pending");

      throw paymentError;
    }
  } catch (error) {
    console.error("Payment creation failed:", error.message || error);

    return res.status(502).json({
      error: "Could not start payment. Check backend logs and PesaJet configuration."
    });
  }
});

// GRANT ACCESS AFTER VERIFIED PAYMENT
async function grantProductAccess(order, reference) {
  const productId = order.product;
  const product = PRODUCTS[productId];
  const now = new Date();

  if (!product) {
    throw new Error("Unknown product on payment order: " + productId);
  }

  if (product.type === "one_time") {
    const { error } = await supabaseAdmin
      .from("whister_product_purchases")
      .upsert({
        user_id: order.user_id,
        product: productId,
        payment_reference: reference,
        amount: product.amount,
        currency: "UGX"
      }, {
        onConflict: "payment_reference"
      });

    if (error) throw error;
  }

  if (product.type === "subscription") {
    const { data: existing, error: readError } =
      await supabaseAdmin
        .from("whister_product_access")
        .select("access_until")
        .eq("user_id", order.user_id)
        .eq("product", productId)
        .maybeSingle();

    if (readError) throw readError;

    const previousExpiry = existing?.access_until
      ? new Date(existing.access_until)
      : now;

    const expiry = new Date(
      previousExpiry > now ? previousExpiry : now
    );

    expiry.setMonth(expiry.getMonth() + product.months);

    const { error: accessError } = await supabaseAdmin
      .from("whister_product_access")
      .upsert({
        user_id: order.user_id,
        product: productId,
        access_until: expiry.toISOString(),
        last_payment_reference: reference,
        updated_at: now.toISOString()
      }, {
        onConflict: "user_id,product"
      });

    if (accessError) throw accessError;

    // Keep the existing legacy premium access table in sync for XXX.
    if (productId === "xxx_premium") {
      const { error: legacyError } = await supabaseAdmin
        .from("whister_premium_access")
        .upsert({
          user_id: order.user_id,
          access_until: expiry.toISOString(),
          last_payment_reference: reference,
          updated_at: now.toISOString()
        }, {
          onConflict: "user_id"
        });

      if (legacyError) throw legacyError;
    }
  }

  if (product.type === "verification") {
    const { error } = await supabaseAdmin
      .from("whister_blue_tick_verifications")
      .upsert({
        user_id: order.user_id,
        payment_reference: reference,
        amount: product.amount,
        status: "pending"
      }, {
        onConflict: "payment_reference"
      });

    if (error) throw error;
  }
}

// PESAJET WEBHOOK
// Configure this URL in PesaJet:
// https://dj-whister-pesajet-payments.onrender.com/webhooks/pesajet
app.post("/webhooks/pesajet", async (req, res) => {
  try {
    const signature = req.headers["x-webhook-signature"];

    const valid =
      signature &&
      pesajet.webhooks.verify(req.body, signature);

    if (!valid) {
      return res.status(401).json({
        error: "Invalid webhook signature."
      });
    }

    const event = req.body || {};

    if (event.event !== "payment.completed") {
      return res.status(200).json({
        received: true,
        ignored: true
      });
    }

    const reference = String(event.reference || "");
    const transactionId = String(event.transactionId || "");
    const amount = Number(event.amount);

    if (
      !reference ||
      !transactionId ||
      !Number.isFinite(amount)
    ) {
      return res.status(400).json({
        error: "Missing payment reference, transaction ID, or amount."
      });
    }

    const { data: order, error: findError } =
      await supabaseAdmin
        .from("whister_payment_orders")
        .select("*")
        .eq("reference", reference)
        .maybeSingle();

    if (findError) throw findError;

    if (!order) {
      return res.status(404).json({
        error: "Payment reference not found."
      });
    }

    // Validate the amount and currency against the stored order.
    if (
      Number(order.amount) !== amount ||
      order.currency !== "UGX"
    ) {
      return res.status(400).json({
        error: "Payment amount mismatch."
      });
    }

    if (order.status === "paid") {
      return res.status(200).json({
        received: true,
        duplicate: true
      });
    }

    // Ensure the order product is known and the stored amount is correct.
    const product = PRODUCTS[order.product];

    if (!product || product.amount !== Number(order.amount)) {
      return res.status(400).json({
        error: "Product or configured price mismatch."
      });
    }

    // Grant the matching product only.
    await grantProductAccess(order, reference);

    const { error: paidError } = await supabaseAdmin
      .from("whister_payment_orders")
      .update({
        status: "paid",
        transaction_id: transactionId,
        paid_at: new Date().toISOString()
      })
      .eq("id", order.id)
      .eq("status", "pending");

    if (paidError) throw paidError;

    return res.json({
      received: true,
      paymentVerified: true,
      product: order.product,
      accessGranted: true
    });
  } catch (error) {
    console.error("Webhook processing failed:", error.message || error);

    return res.status(500).json({
      error: "Webhook processing failed."
    });
  }
});

const port = Number(process.env.PORT || 10000);

app.listen(port, "0.0.0.0", () => {
  console.log("DJ WHISTER 256 PesaJet backend listening on", port);
});