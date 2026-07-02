import { getPaystack } from '../../shared/paystack';
import {
  getCreditAccount,
  updateCreditAccount,
  upsertCreditAccount,
} from '../repositories/credit-accounts';
import { getCustomerByAccountId, upsertCustomer } from '../repositories/customers';

export async function resolveLivePaystackCustomerId(accountId: string): Promise<string | null> {
  const existing = await getCustomerByAccountId(accountId);
  // We only care if it's a paystack customer
  if (!existing || existing.provider !== 'paystack') return null;
  try {
    const cust = await getPaystack().fetchCustomer(existing.id);
    if (cust.status && cust.data.customer_code === existing.id) return existing.id;
  } catch (err: any) {
    if (err.message && err.message.includes('404')) {
      console.warn(`[billing] Paystack customer ${existing.id} for ${accountId} not found in the current Paystack account`);
    } else {
      throw err;
    }
  }
  return null;
}

export async function getOrCreatePaystackCustomer(
  accountId: string,
  email: string,
): Promise<string> {
  const live = await resolveLivePaystackCustomerId(accountId);
  if (live) return live;

  try {
    const cust = await getPaystack().createCustomer({
      email,
      metadata: { account_id: accountId },
    });

    if (!cust.status) {
      throw new Error(`Failed to create Paystack customer: ${cust.message}`);
    }

    await upsertCustomer({
      accountId,
      id: cust.data.customer_code,
      email,
      provider: 'paystack',
      active: true,
    });

    return cust.data.customer_code;
  } catch (err: any) {
    if (err.message && err.message.includes('already exists')) {
      // Fetch it
      const existing = await getPaystack().fetchCustomer(email);
      if (existing.status) {
        await upsertCustomer({
          accountId,
          id: existing.data.customer_code,
          email,
          provider: 'paystack',
          active: true,
        });
        return existing.data.customer_code;
      }
    }
    throw err;
  }
}
