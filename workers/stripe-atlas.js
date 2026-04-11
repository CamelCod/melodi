/**
 * STRIPE ATLAS PAYMENT — Melodi
 * Disposable per-order charges. $15 auth → capture on approval.
 * Atlas is Stripe's no-commitment payment method.
 *
 * Flow:
 * 1. Create PaymentIntent (auth only, no capture) when preview is ready
 * 2. User approves → capture via webhook or manual trigger
 * 3. Auto-void after 7 days if no capture
 */

const STRIPE_API_BASE = "https://api.stripe.com";

/**
 * Create a $15 PaymentIntent for an order (auth hold only)
 */
export async function createPaymentIntent(orderRef, customerEmail, env) {
  const response = await fetch(`${STRIPE_API_BASE}/v1/payment_intents`, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${btoa(env.STRIPE_SECRET_KEY)}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      amount: "1500", // $15.00 in cents
      currency: "usd",
      "payment_method_types[]": "card",
      capture_method: "manual", // Auth only — capture later
      description: `Melodi Song — ${orderRef}`,
      metadata: {
        order_ref: orderRef,
        product: "melodi_full_song"
      },
      ...(customerEmail ? { receipt_email: customerEmail } : {})
    })
  });

  if (!response.ok) {
    const err = await response.json();
    throw new Error(`Stripe error: ${err.error?.message || response.status}`);
  }

  return await response.json(); // { id, client_secret, status }
}

/**
 * Capture a PaymentIntent after user approves
 */
export async function capturePaymentIntent(paymentIntentId, env) {
  const response = await fetch(`${STRIPE_API_BASE}/v1/payment_intents/${paymentIntentId}/capture`, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${btoa(env.STRIPE_SECRET_KEY)}`,
      "Content-Type": "application/x-www-form-urlencoded"
    }
  });

  if (!response.ok) {
    const err = await response.json();
    throw new Error(`Stripe capture error: ${err.error?.message || response.status}`);
  }

  return await response.json();
}

/**
 * Cancel/void a PaymentIntent (auto-void after 7 days or user rejects)
 */
export async function cancelPaymentIntent(paymentIntentId, env) {
  const response = await fetch(`${STRIPE_API_BASE}/v1/payment_intents/${paymentIntentId}/cancel`, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${btoa(env.STRIPE_SECRET_KEY)}`,
      "Content-Type": "application/x-www-form-urlencoded"
    }
  });

  if (!response.ok) {
    const err = await response.json();
    throw new Error(`Stripe cancel error: ${err.error?.message || response.status}`);
  }

  return await response.json();
}

/**
 * Void all PaymentIntents older than 7 days (cron job)
 */
export async function autoVoidStalePayments(env) {
  const sevenDaysAgo = Math.floor((Date.now() - 7 * 24 * 60 * 60 * 1000) / 1000);

  // Find unpaid auth holds
  const response = await fetch(
    `${STRIPE_API_BASE}/v1/payment_intents?status=requires_capture&created[lt]=${sevenDaysAgo}`,
    {
      headers: {
        "Authorization": `Basic ${btoa(env.STRIPE_SECRET_KEY)}`,
        "Content-Type": "application/x-www-form-urlencoded"
      }
    }
  );

  const data = await response.json();
  const results = [];

  for (const intent of data.data || []) {
    if (intent.metadata?.product === "melodi_full_song") {
      try {
        await cancelPaymentIntent(intent.id, env);
        results.push({ id: intent.id, status: "voided" });
      } catch (e) {
        results.push({ id: intent.id, status: "error", error: e.message });
      }
    }
  }

  return results;
}

/**
 * List all PaymentIntents for an order ref
 */
export async function getPaymentsByOrderRef(orderRef, env) {
  const response = await fetch(
    `${STRIPE_API_BASE}/v1/payment_intents?metadata[order_ref]=${orderRef}`,
    {
      headers: {
        "Authorization": `Basic ${btoa(env.STRIPE_SECRET_KEY)}`
      }
    }
  );

  const data = await response.json();
  return data.data || [];
}
