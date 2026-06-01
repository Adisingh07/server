import express from 'express';
import admin from 'firebase-admin';
import { adminDb } from './firebase-admin';

export const subscriptionRouter = express.Router();

/**
 * GET /api/subscriptions/:userId
 * 
 * Check if the user has an active app ad-free subscription.
 * Verifies if the 'adFreeActiveUntil' timestamp inside 'adfree_subscriptions'
 * collection is in the future. Handles VIP tier checking and self-healing authority syncing.
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
    let tier = 'standard';

    if (docSnap.exists) {
      const data = docSnap.data();
      localExpiry = data?.adFreeActiveUntil;
      tier = data?.tier || 'standard';

      if (localExpiry) {
        const expiryDate = new Date(localExpiry);
        localActive = expiryDate.getTime() > Date.now();
        
        // If local database confirms user is active, return immediately for speed
        if (localActive) {
          // --- SELF-HEALING SYNC ---
          // Ensure user's primary account authority and verifiedReson fields are synced!
          try {
            const userRef = adminDb.collection('users').doc(userId);
            const userDoc = await userRef.get();
            if (userDoc.exists) {
              const userData = userDoc.data();
              if (tier === 'vip') {
                if (userData?.authority !== 'verified' || userData?.verifiedReson !== 'Verified by subscription') {
                  console.log(`[SubscriptionAPI] Self-healing authority for VIP user ${userId}...`);
                  await userRef.update({
                    authority: 'verified',
                    verifiedReson: 'Verified by subscription'
                  });
                }
              } else {
                // If tier is standard but they still have "verified" with "Verified by subscription", revert it
                if (userData?.authority === 'verified' && userData?.verifiedReson === 'Verified by subscription') {
                  console.log(`[SubscriptionAPI] Self-healing reverting authority for Standard user ${userId}...`);
                  await userRef.update({
                    authority: 'user',
                    verifiedReson: admin.firestore.FieldValue.delete()
                  });
                }
              }
            }
          } catch (e) {
            console.error('[SubscriptionAPI] Self-healing user document sync failed:', e);
          }

          return res.status(200).json({ 
            active: true, 
            tier,
            adFreeActiveUntil: localExpiry 
          });
        }
      }
    }

    // --- SELF-HEALING SYNC FOR EXPIRED VIP USERS ---
    // If expired/inactive, ensure authority is reverted ONLY if it was "Verified by subscription"
    try {
      const userRef = adminDb.collection('users').doc(userId);
      const userDoc = await userRef.get();
      if (userDoc.exists) {
        const userData = userDoc.data();
        if (userData?.authority === 'verified' && userData?.verifiedReson === 'Verified by subscription') {
          console.log(`[SubscriptionAPI] Reverting expired VIP user ${userId} to standard user...`);
          await userRef.update({
            authority: 'user',
            verifiedReson: admin.firestore.FieldValue.delete()
          });
        }
      }
    } catch (e) {
      console.error('[SubscriptionAPI] Error reverting expired VIP user authority:', e);
    }

    // --- SELF-HEALING SYNC WITH REVENUECAT ---
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
          const standardEntitlement = rcData?.subscriber?.entitlements?.adfree_access;
          const vipEntitlement = rcData?.subscriber?.entitlements?.vip_verified_access;
          
          // Select the entitlement that is actually active in the future
          let activeEntitlement = null;
          let liveTier = 'standard';

          const nowMs = Date.now();
          const isVipActive = vipEntitlement && vipEntitlement.expires_date && (new Date(vipEntitlement.expires_date).getTime() > nowMs);
          const isStandardActive = standardEntitlement && standardEntitlement.expires_date && (new Date(standardEntitlement.expires_date).getTime() > nowMs);

          if (isVipActive) {
            activeEntitlement = vipEntitlement;
            liveTier = 'vip';
          } else if (isStandardActive) {
            activeEntitlement = standardEntitlement;
            liveTier = 'standard';
          }

          if (activeEntitlement) {
            const expiresDate = activeEntitlement.expires_date;
            if (expiresDate && new Date(expiresDate).getTime() > Date.now()) {
              // Self-heal: update Firestore with the verified active status
              await docRef.set({
                userId,
                tier: liveTier,
                adFreeActiveUntil: expiresDate,
                isActive: true,
                updatedAt: new Date().toISOString(),
                lastSyncEvent: 'SELF_HEALING_GET'
              }, { merge: true });

              const userRef = adminDb.collection('users').doc(userId);
              const userDoc = await userRef.get();
              const userData = userDoc.exists ? userDoc.data() : null;

              if (userDoc.exists) {
                if (liveTier === 'vip') {
                  await userRef.update({
                    authority: 'verified',
                    verifiedReson: 'Verified by subscription'
                  });
                } else {
                  // Revert ONLY if their existing reason is 'Verified by subscription'
                  if (userData?.authority === 'verified' && userData?.verifiedReson === 'Verified by subscription') {
                    await userRef.update({
                      authority: 'user',
                      verifiedReson: admin.firestore.FieldValue.delete()
                    });
                  }
                }
              }

              console.log(`[SubscriptionAPI] Self-healing successful! Restored active ${liveTier} status for user ${userId} until ${expiresDate}`);
              return res.status(200).json({ 
                active: true, 
                tier: liveTier,
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
    console.log("[SubscriptionAPI Debug] Received activate request from App:", { userId, packageId, transactionId });

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
        console.log(`[SubscriptionAPI Debug] RevenueCat API Response for user ${userId}:`, JSON.stringify(rcData, null, 2));
        
        const standardEntitlement = rcData?.subscriber?.entitlements?.adfree_access;
        const vipEntitlement = rcData?.subscriber?.entitlements?.vip_verified_access;
        
        // Select the entitlement that is actually active in the future
        let activeEntitlement = null;
        let tier = 'standard';

        const nowMs = Date.now();
        const isVipActive = vipEntitlement && vipEntitlement.expires_date && (new Date(vipEntitlement.expires_date).getTime() > nowMs);
        const isStandardActive = standardEntitlement && standardEntitlement.expires_date && (new Date(standardEntitlement.expires_date).getTime() > nowMs);

        if (isVipActive) {
          activeEntitlement = vipEntitlement;
          tier = 'vip';
        } else if (isStandardActive) {
          activeEntitlement = standardEntitlement;
          tier = 'standard';
        }

        // Check if the entitlement exists and its expiration date is in the future
        if (activeEntitlement) {
          const expiresDate = activeEntitlement.expires_date;
          if (expiresDate && new Date(expiresDate).getTime() > Date.now()) {
            const batch = adminDb.batch();
            
            // 1. Update subscription doc
            const subRef = adminDb.collection('adfree_subscriptions').doc(userId);
            batch.set(subRef, {
              userId,
              tier,
              adFreeActiveUntil: expiresDate,
              isActive: true,
              updatedAt: new Date().toISOString(),
              purchaseDetails: { packageId, transactionId }
            });

            // 2. Update user doc (Strict Safety Check)
            const userRef = adminDb.collection('users').doc(userId);
            const userSnap = await userRef.get();
            const userData = userSnap.exists ? userSnap.data() : null;

            if (userSnap.exists) {
              if (tier === 'vip') {
                batch.update(userRef, { 
                  authority: 'verified', 
                  verifiedReson: 'Verified by subscription' 
                });
              } else {
                // Revert ONLY if their existing reason is 'Verified by subscription'
                if (userData?.authority === 'verified' && userData?.verifiedReson === 'Verified by subscription') {
                  batch.update(userRef, { 
                    authority: 'user', 
                    verifiedReson: admin.firestore.FieldValue.delete() 
                  });
                }
              }
            }

            await batch.commit();

            console.log(`[SubscriptionAPI] Securely verified and activated ${tier} subscription for ${userId} until ${expiresDate}`);
            return res.status(200).json({ success: true, tier, adFreeActiveUntil: expiresDate });
          }
        }
        console.warn(`[SubscriptionAPI] Security alert: User ${userId} attempted activate API, but entitlement was missing or expired in RevenueCat.`);
        return res.status(403).json({ error: 'Purchase verification failed: active entitlement not found.' });
      } else {
        const errText = await rcRes.text().catch(() => '');
        console.error(`[SubscriptionAPI] RevenueCat API responded with status ${rcRes.status}. Error body: ${errText}`);
      }
    } else {
      console.warn('[SubscriptionAPI] WARNING: REVENUECAT_SECRET_KEY not set in .env. Falling back to client-trusted calculation (DEV MODE ONLY).');
    }

    // --- Dev Mode Fallback (If Secret Key is not configured yet in .env) ---
    const thirtyDaysInMs = 30 * 24 * 60 * 60 * 1000;
    const expiryDateStr = new Date(Date.now() + thirtyDaysInMs).toISOString();
    
    // Check if the sandbox package is the VIP plan
    const isVipPackage = packageId?.includes('verified') || packageId?.includes('vip');
    const tier = isVipPackage ? 'vip' : 'standard';

    const batch = adminDb.batch();
    const subRef = adminDb.collection('adfree_subscriptions').doc(userId);
    batch.set(subRef, {
      userId,
      tier,
      adFreeActiveUntil: expiryDateStr,
      isActive: true,
      updatedAt: new Date().toISOString(),
      purchaseDetails: { packageId, transactionId }
    });

    const userRef = adminDb.collection('users').doc(userId);
    const userSnap = await userRef.get();
    const userData = userSnap.exists ? userSnap.data() : null;

    if (userSnap.exists) {
      if (tier === 'vip') {
        batch.update(userRef, { 
          authority: 'verified', 
          verifiedReson: 'Verified by subscription' 
        });
      } else {
        // Revert ONLY if their existing reason is 'Verified by subscription'
        if (userData?.authority === 'verified' && userData?.verifiedReson === 'Verified by subscription') {
          batch.update(userRef, { 
            authority: 'user', 
            verifiedReson: admin.firestore.FieldValue.delete() 
          });
        }
      }
    }

    await batch.commit();

    return res.status(200).json({ 
      success: true, 
      tier,
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
 * Handles automatic renewals, refunds, upgrades, and cancellations instantly in the database.
 */
subscriptionRouter.post('/webhook', async (req: express.Request, res: express.Response) => {
  try {
    console.log("[SubscriptionAPI Webhook Debug] Received webhook payload:", JSON.stringify(req.body, null, 2));

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
    
    // Ensure the event relates to our standard ad-free entitlement (conceptually matches old working version)
    if (!entitlement_ids || !entitlement_ids.includes('adfree_access')) {
      return res.status(200).json({ received: true, message: 'Event not related to adfree_access' });
    }

    console.log(`[SubscriptionAPI Webhook] Event received: ${type} for user: ${app_user_id}`);

    const docRef = adminDb.collection('adfree_subscriptions').doc(app_user_id);
    const hasVip = entitlement_ids && entitlement_ids.includes('vip_verified_access');
    const tier = hasVip ? 'vip' : 'standard';

    switch (type) {
      case 'TRANSFER':
        // 1. Grant active premium status to the new user ID
        if (expiration_at_ms) {
          const expiryDateStr = new Date(expiration_at_ms).toISOString();
          await docRef.set({
            userId: app_user_id,
            tier,
            adFreeActiveUntil: expiryDateStr,
            isActive: true,
            updatedAt: new Date().toISOString(),
            lastWebhookEvent: type
          }, { merge: true });

          // Sync user authority in background safely (non-blocking)
          try {
            const userRef = adminDb.collection('users').doc(app_user_id);
            const userSnap = await userRef.get();
            if (userSnap.exists) {
              const userData = userSnap.data();
              if (tier === 'vip') {
                await userRef.update({
                  authority: 'verified',
                  verifiedReson: 'Verified by subscription'
                });
              } else {
                if (userData?.authority === 'verified' && userData?.verifiedReson === 'Verified by subscription') {
                  await userRef.update({
                    authority: 'user',
                    verifiedReson: admin.firestore.FieldValue.delete()
                  });
                }
              }
            }
          } catch (e) {
            console.error('[SubscriptionAPI Webhook] TRANSFER user update error:', e);
          }

          console.log(`[SubscriptionAPI Webhook] Transferred active ${tier} active status to user ${app_user_id} until ${expiryDateStr}`);
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

            try {
              const oldUserRef = adminDb.collection('users').doc(oldUserId);
              const oldUserSnap = await oldUserRef.get();
              if (oldUserSnap.exists) {
                const oldUserData = oldUserSnap.data();
                if (oldUserData?.authority === 'verified' && oldUserData?.verifiedReson === 'Verified by subscription') {
                  await oldUserRef.update({
                    authority: 'user',
                    verifiedReson: admin.firestore.FieldValue.delete()
                  });
                }
              }
            } catch (e) {
              console.error('[SubscriptionAPI Webhook] TRANSFER old user update error:', e);
            }
            console.log(`[SubscriptionAPI Webhook] Revoked premium access from transferred user ${oldUserId}`);
          }
        }
        break;

      case 'INITIAL_PURCHASE':
      case 'RENEWAL':
      case 'PRODUCT_CHANGE': // Upgrade/Downgrade event natively supported
      case 'UNCANCELLATION': // User resumed subscription
        if (expiration_at_ms) {
          const expiryDateStr = new Date(expiration_at_ms).toISOString();
          await docRef.set({
            userId: app_user_id,
            tier,
            adFreeActiveUntil: expiryDateStr,
            isActive: true,
            updatedAt: new Date().toISOString(),
            lastWebhookEvent: type
          }, { merge: true });

          // Sync user authority in background safely (non-blocking)
          try {
            const userRef = adminDb.collection('users').doc(app_user_id);
            const userSnap = await userRef.get();
            if (userSnap.exists) {
              const userData = userSnap.data();
              if (tier === 'vip') {
                await userRef.update({
                  authority: 'verified',
                  verifiedReson: 'Verified by subscription'
                });
              } else {
                if (userData?.authority === 'verified' && userData?.verifiedReson === 'Verified by subscription') {
                  await userRef.update({
                    authority: 'user',
                    verifiedReson: admin.firestore.FieldValue.delete()
                  });
                }
              }
            }
          } catch (e) {
            console.error('[SubscriptionAPI Webhook] Webhook purchase sync error:', e);
          }

          console.log(`[SubscriptionAPI Webhook] Updated user ${app_user_id} active ${tier} status until ${expiryDateStr} (Reason: ${type})`);
        }
        break;

      case 'CANCELLATION':
      case 'EXPIRATION':
      case 'BILLING_ISSUE':
        // SAFETY GUARD: If the database already has an active VIP subscription,
        // do not allow a standard tier expiration event to overwrite or deactivate it!
        try {
          const subSnap = await docRef.get();
          const subData = subSnap.exists ? subSnap.data() : null;

          if (subData && subData.isActive && subData.tier === 'vip' && tier === 'standard') {
            console.log(`[SubscriptionAPI Webhook] Safety Guard: Ignored standard expiration/cancellation for ${app_user_id} because their VIP tier is active.`);
            break;
          }

          // SAFETY GUARD 2: If the incoming expiration timestamp is in the past, but the DB already has a newer active expiration date, ignore it.
          if (expiration_at_ms) {
            const currentExpiryTime = subData?.adFreeActiveUntil ? new Date(subData.adFreeActiveUntil).getTime() : 0;
            if (expiration_at_ms < currentExpiryTime && subData?.isActive) {
              console.log(`[SubscriptionAPI Webhook] Safety Guard: Ignored old expiration event for ${app_user_id} because DB has a newer active expiration date.`);
              break;
            }
          }
        } catch (e) {
          console.error('[SubscriptionAPI Webhook] Safety guards execution error:', e);
        }

        if (expiration_at_ms) {
          const expiryDateStr = new Date(expiration_at_ms).toISOString();
          const isStillActive = new Date(expiration_at_ms).getTime() > Date.now();

          await docRef.set({
            adFreeActiveUntil: expiryDateStr,
            isActive: isStillActive,
            updatedAt: new Date().toISOString(),
            lastWebhookEvent: type
          }, { merge: true });

          if (!isStillActive) {
            try {
              const userRef = adminDb.collection('users').doc(app_user_id);
              const userSnap = await userRef.get();
              if (userSnap.exists) {
                const userData = userSnap.data();
                if (userData?.authority === 'verified' && userData?.verifiedReson === 'Verified by subscription') {
                  await userRef.update({
                    authority: 'user',
                    verifiedReson: admin.firestore.FieldValue.delete()
                  });
                }
              }
            } catch (e) {
              console.error('[SubscriptionAPI Webhook] Expired user revert error:', e);
            }
          }
        } else {
          await docRef.set({
            isActive: false,
            updatedAt: new Date().toISOString(),
            lastWebhookEvent: type
          }, { merge: true });

          try {
            const userRef = adminDb.collection('users').doc(app_user_id);
            const userSnap = await userRef.get();
            if (userSnap.exists) {
              const userData = userSnap.data();
              if (userData?.authority === 'verified' && userData?.verifiedReson === 'Verified by subscription') {
                await userRef.update({
                  authority: 'user',
                  verifiedReson: admin.firestore.FieldValue.delete()
                });
              }
            }
          } catch (e) {
            console.error('[SubscriptionAPI Webhook] Expired user revert error:', e);
          }
        }
        console.log(`[SubscriptionAPI Webhook] Updated user ${app_user_id} cancellation/expiration status (Reason: ${type})`);
        break;

      default:
        break;
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('[SubscriptionAPI Webhook] Error processing webhook:', error);
    return res.status(500).json({ error: 'Webhook processing failed.' });
  }
});
