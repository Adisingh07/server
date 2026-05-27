import express from 'express';
import { adminDb } from './firebase-admin';

export const subscriptionRouter = express.Router();

/**
 * GET /api/subscriptions/:userId
 * 
 * Check if the user has an active app ad-free subscription.
 * Verifies if the 'adFreeActiveUntil' timestamp inside 'adfree_subscriptions'
 * collection is in the future.
 */
subscriptionRouter.get('/:userId', async (req: express.Request, res: express.Response) => {
  try {
    const { userId } = req.params;
    if (!userId) {
      return res.status(400).json({ error: 'User ID is required.' });
    }

    const docRef = adminDb.collection('adfree_subscriptions').doc(userId);
    const docSnap = await docRef.get();
    let localActive = false;
    let localExpiry = null;

    if (docSnap.exists) {
      const data = docSnap.data();
      localExpiry = data?.adFreeActiveUntil;

      if (localExpiry) {
        const expiryDate = new Date(localExpiry);
        localActive = expiryDate.getTime() > Date.now();
        
        // If local database confirms user is active, return immediately for speed
        if (localActive) {
          return res.status(200).json({ 
            active: true, 
            adFreeActiveUntil: localExpiry 
          });
        }
      }
    }

    // --- SELF-HEALING SYNC ---
    // If local Firestore says expired/inactive OR does not exist, we do a live check
    // with RevenueCat as a fail-safe backup (in case a webhook renewal failed to process).
    const secretKey = process.env.REVENUECAT_SECRET_KEY;
    if (secretKey) {
      console.log(`[SubscriptionAPI] Local DB says inactive/expired for ${userId}. Performing live self-healing sync with RevenueCat...`);
      try {
        const rcRes = await fetch(`https://api.revenuecat.com/v1/subscribers/${userId}`, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${secretKey}`,
            'Content-Type': 'application/json',
          }
        });

        if (rcRes.ok) {
          const rcData = await rcRes.json();
          const entitlement = rcData?.subscriber?.entitlements?.adfree_access;

          if (entitlement) {
            const expiresDate = entitlement.expires_date;
            if (expiresDate && new Date(expiresDate).getTime() > Date.now()) {
              // Self-heal: update Firestore with the verified active status
              await docRef.set({
                userId,
                adFreeActiveUntil: expiresDate,
                isActive: true,
                updatedAt: new Date().toISOString(),
                lastSyncEvent: 'SELF_HEALING_GET'
              }, { merge: true });

              console.log(`[SubscriptionAPI] Self-healing successful! Restored active status for user ${userId} until ${expiresDate}`);
              return res.status(200).json({ 
                active: true, 
                adFreeActiveUntil: expiresDate 
              });
            }
          }
        }
      } catch (err) {
        console.error('[SubscriptionAPI] Self-healing sync failed due to network error:', err);
      }
    }

    // If both local DB and RevenueCat confirm expired/inactive, return false
    return res.status(200).json({ active: false });
  } catch (error) {
    console.error('[SubscriptionAPI] Error fetching subscription:', error);
    return res.status(500).json({ error: 'Failed to fetch subscription status.' });
  }
});

/**
 * POST /api/subscriptions/activate
 * 
 * Securely verify and activate/renew the subscription for a user.
 * Contacts the RevenueCat API to confirm the user actually has the entitlement.
 */
subscriptionRouter.post('/activate', async (req: express.Request, res: express.Response) => {
  try {
    const { userId, packageId, transactionId } = req.body;

    if (!userId) {
      return res.status(400).json({ error: 'User ID is required.' });
    }

    const secretKey = process.env.REVENUECAT_SECRET_KEY;
    
    // In production, we always verify against the RevenueCat REST API
    if (secretKey) {
      console.log(`[SubscriptionAPI] Verifying entitlement for user ${userId} with RevenueCat API...`);
      const rcRes = await fetch(`https://api.revenuecat.com/v1/subscribers/${userId}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${secretKey}`,
          'Content-Type': 'application/json',
        }
      });

      if (rcRes.ok) {
        const rcData = await rcRes.json();
        const entitlement = rcData?.subscriber?.entitlements?.adfree_access;

        // Check if the entitlement exists and its expiration date is in the future
        if (entitlement) {
          const expiresDate = entitlement.expires_date;
          if (expiresDate && new Date(expiresDate).getTime() > Date.now()) {
            // Update Firestore with verified data
            await adminDb.collection('adfree_subscriptions').doc(userId).set({
              userId,
              adFreeActiveUntil: expiresDate,
              isActive: true,
              updatedAt: new Date().toISOString(),
              purchaseDetails: { packageId, transactionId }
            });

            console.log(`[SubscriptionAPI] Securely verified and activated subscription for ${userId} until ${expiresDate}`);
            return res.status(200).json({ success: true, adFreeActiveUntil: expiresDate });
          }
        }
        console.warn(`[SubscriptionAPI] Security alert: User ${userId} attempted activate API, but entitlement was missing or expired in RevenueCat.`);
        return res.status(403).json({ error: 'Purchase verification failed: active entitlement not found.' });
      } else {
        console.error(`[SubscriptionAPI] RevenueCat API responded with status ${rcRes.status}`);
      }
    } else {
      console.warn('[SubscriptionAPI] WARNING: REVENUECAT_SECRET_KEY not set in .env. Falling back to client-trusted calculation (DEV MODE ONLY).');
    }

    // --- Dev Mode Fallback (If Secret Key is not configured yet in .env) ---
    const thirtyDaysInMs = 30 * 24 * 60 * 60 * 1000;
    const expiryDateStr = new Date(Date.now() + thirtyDaysInMs).toISOString();

    await adminDb.collection('adfree_subscriptions').doc(userId).set({
      userId,
      adFreeActiveUntil: expiryDateStr,
      isActive: true,
      updatedAt: new Date().toISOString(),
      purchaseDetails: { packageId, transactionId }
    });

    return res.status(200).json({ 
      success: true, 
      adFreeActiveUntil: expiryDateStr 
    });
  } catch (error) {
    console.error('[SubscriptionAPI] Error activating subscription:', error);
    return res.status(500).json({ error: 'Failed to activate subscription.' });
  }
});

/**
 * POST /api/subscriptions/webhook
 * 
 * Secure Webhook endpoint for RevenueCat.
 * Receives real-time subscription lifecycle events (INITIAL_PURCHASE, RENEWAL, CANCELLATION, EXPIRATION, etc.).
 * Handles automatic renewals, refunds, and cancellations instantly in the database.
 */
subscriptionRouter.post('/webhook', async (req: express.Request, res: express.Response) => {
  try {
    const webhookToken = process.env.REVENUECAT_WEBHOOK_TOKEN;
    const authHeader = req.headers.authorization;

    // Validate webhook authenticity if a token is set in .env
    if (webhookToken && authHeader !== `Bearer ${webhookToken}`) {
      console.warn('[SubscriptionAPI Webhook] Unauthorized request received.');
      return res.status(401).json({ error: 'Unauthorized.' });
    }

    const { event } = req.body;
    if (!event) {
      return res.status(400).json({ error: 'Missing event payload.' });
    }

    const { type, app_user_id, entitlement_ids, expiration_at_ms } = event;
    
    // Ensure the event relates to our ad-free entitlement
    if (!entitlement_ids || !entitlement_ids.includes('adfree_access')) {
      return res.status(200).json({ received: true, message: 'Event not related to adfree_access' });
    }

    console.log(`[SubscriptionAPI Webhook] Event received: ${type} for user: ${app_user_id}`);

    const docRef = adminDb.collection('adfree_subscriptions').doc(app_user_id);

    switch (type) {
      case 'TRANSFER':
        // 1. Grant active premium status to the new user ID
        if (expiration_at_ms) {
          const expiryDateStr = new Date(expiration_at_ms).toISOString();
          await docRef.set({
            userId: app_user_id,
            adFreeActiveUntil: expiryDateStr,
            isActive: true,
            updatedAt: new Date().toISOString(),
            lastWebhookEvent: type
          }, { merge: true });
          console.log(`[SubscriptionAPI Webhook] Transferred premium active status to new user ${app_user_id} until ${expiryDateStr}`);
        }

        // 2. Revoke premium status instantly from the old user(s) (Account A)
        const transferredFrom = event.transferred_from;
        if (transferredFrom && Array.isArray(transferredFrom)) {
          for (const oldUserId of transferredFrom) {
            await adminDb.collection('adfree_subscriptions').doc(oldUserId).set({
              isActive: false,
              adFreeActiveUntil: null,
              updatedAt: new Date().toISOString(),
              lastWebhookEvent: 'REVOKED_BY_TRANSFER'
            }, { merge: true });
            console.log(`[SubscriptionAPI Webhook] Revoked premium access from transferred user ${oldUserId}`);
          }
        }
        break;

      case 'INITIAL_PURCHASE':
      case 'RENEWAL':
      case 'UNCANCELLATION': // User resumed their subscription before expiry
        if (expiration_at_ms) {
          const expiryDateStr = new Date(expiration_at_ms).toISOString();
          await docRef.set({
            userId: app_user_id,
            adFreeActiveUntil: expiryDateStr,
            isActive: true,
            updatedAt: new Date().toISOString(),
            lastWebhookEvent: type
          }, { merge: true });

          console.log(`[SubscriptionAPI Webhook] Updated user ${app_user_id} active status until ${expiryDateStr} (Reason: ${type})`);
        }
        break;

      case 'CANCELLATION':
      case 'EXPIRATION':
      case 'BILLING_ISSUE':
        // Mark as inactive or let expiry date naturally handle it. De-activating is the safest!
        if (expiration_at_ms) {
          const expiryDateStr = new Date(expiration_at_ms).toISOString();
          await docRef.set({
            adFreeActiveUntil: expiryDateStr,
            isActive: new Date(expiration_at_ms).getTime() > Date.now(),
            updatedAt: new Date().toISOString(),
            lastWebhookEvent: type
          }, { merge: true });
        } else {
          await docRef.set({
            isActive: false,
            updatedAt: new Date().toISOString(),
            lastWebhookEvent: type
          }, { merge: true });
        }
        console.log(`[SubscriptionAPI Webhook] Updated user ${app_user_id} cancellation/expiration status (Reason: ${type})`);
        break;

      default:
        // Other events (TRANSFER, PRODUCT_CHANGE, etc.)
        break;
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('[SubscriptionAPI Webhook] Error processing webhook:', error);
    return res.status(500).json({ error: 'Webhook processing failed.' });
  }
});
