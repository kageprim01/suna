import { config } from '../config';

const PAYSTACK_API_BASE = 'https://api.paystack.co';

export interface PaystackInitializeTransactionResponse {
  status: boolean;
  message: string;
  data: {
    authorization_url: string;
    access_code: string;
    reference: string;
  };
}

export interface PaystackVerifyTransactionResponse {
  status: boolean;
  message: string;
  data: {
    amount: number;
    currency: string;
    transaction_date: string;
    status: string;
    reference: string;
    domain: string;
    metadata: any;
    gateway_response: string;
    message: null | string;
    channel: string;
    ip_address: string;
    log: any;
    fees: number;
    authorization: {
      authorization_code: string;
      bin: string;
      last4: string;
      exp_month: string;
      exp_year: string;
      channel: string;
      card_type: string;
      bank: string;
      country_code: string;
      brand: string;
      reusable: boolean;
      signature: string;
      account_name: string | null;
    };
    customer: {
      id: number;
      first_name: string | null;
      last_name: string | null;
      email: string;
      customer_code: string;
      phone: string | null;
      metadata: any | null;
      risk_action: string;
    };
    plan: any;
  };
}

export interface PaystackCreateCustomerResponse {
  status: boolean;
  message: string;
  data: {
    email: string;
    integration: number;
    domain: string;
    customer_code: string;
    id: number;
    identified: boolean;
    identifications: any | null;
    createdAt: string;
    updatedAt: string;
  };
}

export interface PaystackCreateSubscriptionResponse {
  status: boolean;
  message: string;
  data: {
    customer: number;
    plan: number;
    integration: number;
    domain: string;
    start: number;
    status: string;
    quantity: number;
    amount: number;
    subscription_code: string;
    email_token: string;
    authorization: number;
    next_payment_date: string;
    id: number;
    createdAt: string;
    updatedAt: string;
  };
}

export interface PaystackListPlansResponse {
  status: boolean;
  message: string;
  data: Array<{
    id: number;
    name: string;
    plan_code: string;
    description: string | null;
    amount: number;
    interval: string;
    send_invoices: boolean;
    send_sms: boolean;
    currency: string;
  }>;
}

class PaystackClient {
  private getHeaders() {
    if (!config.PAYSTACK_SECRET_KEY) {
      throw new Error('PAYSTACK_SECRET_KEY is not configured');
    }
    return {
      Authorization: `Bearer ${config.PAYSTACK_SECRET_KEY}`,
      'Content-Type': 'application/json',
    };
  }

  async initializeTransaction(params: {
    email: string;
    amount: number; // in cents
    currency?: string;
    reference?: string;
    callback_url?: string;
    plan?: string;
    invoice_limit?: number;
    metadata?: any;
    channels?: string[];
  }): Promise<PaystackInitializeTransactionResponse> {
    const res = await fetch(`${PAYSTACK_API_BASE}/transaction/initialize`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(params),
    });
    
    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Paystack initialize transaction failed: ${res.status} ${errBody}`);
    }
    return res.json();
  }

  async verifyTransaction(reference: string): Promise<PaystackVerifyTransactionResponse> {
    const res = await fetch(`${PAYSTACK_API_BASE}/transaction/verify/${reference}`, {
      method: 'GET',
      headers: this.getHeaders(),
    });
    
    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Paystack verify transaction failed: ${res.status} ${errBody}`);
    }
    return res.json();
  }

  async createCustomer(params: { email: string; first_name?: string; last_name?: string; metadata?: any }): Promise<PaystackCreateCustomerResponse> {
    const res = await fetch(`${PAYSTACK_API_BASE}/customer`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(params),
    });
    
    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Paystack create customer failed: ${res.status} ${errBody}`);
    }
    return res.json();
  }

  async fetchCustomer(emailOrCode: string): Promise<PaystackCreateCustomerResponse> {
    const res = await fetch(`${PAYSTACK_API_BASE}/customer/${emailOrCode}`, {
      method: 'GET',
      headers: this.getHeaders(),
    });
    
    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Paystack fetch customer failed: ${res.status} ${errBody}`);
    }
    return res.json();
  }

  async createSubscription(params: { customer: string; plan: string; authorization?: string; start_date?: string }): Promise<PaystackCreateSubscriptionResponse> {
    const res = await fetch(`${PAYSTACK_API_BASE}/subscription`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(params),
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Paystack create subscription failed: ${res.status} ${errBody}`);
    }
    return res.json();
  }

  async cancelSubscription(subscriptionCode: string, emailToken: string): Promise<any> {
    const res = await fetch(`${PAYSTACK_API_BASE}/subscription/disable`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ code: subscriptionCode, token: emailToken }),
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Paystack cancel subscription failed: ${res.status} ${errBody}`);
    }
    return res.json();
  }

  async listPlans(): Promise<PaystackListPlansResponse> {
    const res = await fetch(`${PAYSTACK_API_BASE}/plan`, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Paystack list plans failed: ${res.status} ${errBody}`);
    }
    return res.json();
  }
}

let paystackClient: PaystackClient | null = null;

export function getPaystack(): PaystackClient {
  if (!paystackClient) {
    paystackClient = new PaystackClient();
  }
  return paystackClient;
}
