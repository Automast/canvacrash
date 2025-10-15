const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
require('dotenv').config();

const app = express();

// Middleware
app.use(cors()); // Open to all domains for testing
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Environment variables needed
const PORT = process.env.PORT || 3000;
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// --- Sender.net (email delivery via welcome automation) ---
const SENDER_API_KEY = process.env.SENDER_API_KEY;
const SENDER_GROUP_ID = process.env.SENDER_GROUP_ID; // Group that triggers the welcome email

// Course details
const COURSE_TITLE = process.env.COURSE_TITLE || 'Your Course';

// HTML escape helper for Telegram HTML parse_mode
const esc = (s = '') => String(s)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

// Initialize Paystack transaction
app.post('/api/initialize-payment', async (req, res) => {
    try {
        const { email, fullName, amount, gclid } = req.body;

        // Validate input
        if (!email || !fullName || !amount) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: email, fullName, amount'
            });
        }

        // Generate unique reference
        const reference = `txn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        // Initialize Paystack transaction
        const paystackResponse = await axios.post(
            'https://api.paystack.co/transaction/initialize',
            {
                email: email,
                amount: amount * 100, // Convert to kobo (smallest unit)
                reference: reference,
                metadata: {
                    full_name: fullName,
                    gclid: gclid || 'direct',
                    custom_fields: [
                        {
                            display_name: "Full Name",
                            variable_name: "full_name",
                            value: fullName
                        }
                    ]
                },
                callback_url: `${req.headers.origin}/paycomplete.html`
            },
            {
                headers: {
                    Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        if (paystackResponse.data.status) {
            res.json({
                success: true,
                data: {
                    authorization_url: paystackResponse.data.data.authorization_url,
                    access_code: paystackResponse.data.data.access_code,
                    reference: reference
                }
            });
        } else {
            res.status(400).json({
                success: false,
                message: 'Failed to initialize payment'
            });
        }
    } catch (error) {
        console.error('Payment initialization error:', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            message: 'Server error during payment initialization',
            error: error.message
        });
    }
});

// Verify Paystack transaction
app.get('/api/verify-payment/:reference', async (req, res) => {
    try {
        const { reference } = req.params;

        const paystackResponse = await axios.get(
            `https://api.paystack.co/transaction/verify/${reference}`,
            {
                headers: {
                    Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`
                }
            }
        );

        if (paystackResponse.data.status && paystackResponse.data.data.status === 'success') {
            res.json({
                success: true,
                data: paystackResponse.data.data
            });
        } else {
            res.json({
                success: false,
                message: 'Payment verification failed'
            });
        }
    } catch (error) {
        console.error('Payment verification error:', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            message: 'Server error during payment verification',
            error: error.message
        });
    }
});


// Send conversion data to Telegram
app.post('/api/send-telegram-notification', async (req, res) => {
    try {
        const { fullName, email, gclid, amount, reference, country, ip } = req.body;

        // Format message for easy Google Ads upload (Telegram HTML)
        const message = [
            '🎉 <b>NEW CONVERSION</b> 🎉',
            '',
            '<b>Customer Details:</b>',
            `Full Name: ${esc(fullName)}`,
            `Email: ${esc(email)}`,
            '',
            '<b>Transaction Details:</b>',
            `Amount: ${esc('₦' + String(amount))}`,
            `Reference: ${esc(reference)}`,
            `Country: ${esc(country || 'NG')}`,
            `IP Address: ${esc(ip || 'N/A')}`,
            '',
            '<b>Google Ads Data:</b>',
            `GCLID: ${esc(gclid || 'direct')}`,
            `Conversion Time: ${esc(new Date().toISOString())}`,
            '',
            '<b>For Google Ads Upload:</b>',
            `<pre>GCLID: ${esc(gclid || 'direct')}
Conversion Name: Purchase
Conversion Time: ${esc(new Date().toISOString())}
Conversion Value: ${esc(String(amount))}
Conversion Currency: NGN</pre>`
        ].join('\n');

        await axios.post(
            `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
            {
                chat_id: TELEGRAM_CHAT_ID,
                text: message,
                parse_mode: 'HTML',
                disable_web_page_preview: true
            }
        );

        res.json({ success: true, message: 'Telegram notification sent' });
    } catch (error) {
        console.error('Telegram notification error:', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            message: 'Failed to send Telegram notification',
            error: error.message
        });
    }
});

// --- Idempotency cache for processed references (in-memory) ---
const processedReferences = new Set();

// Add a buyer to Sender.net list/group so their Welcome email goes out automatically
async function addSubscriberToSender({ email, fullName, gclid = 'direct' }) {
  console.log('\n📧 Adding subscriber to Sender.net...');
  console.log(`   Email: ${email}`);
  console.log(`   Name: ${fullName}`);
  console.log(`   GCLID: ${gclid}`);
  console.log(`   Debug - fullName type: ${typeof fullName}`);
  console.log(`   Debug - fullName value: "${fullName}"`);
  
  try {
    if (!SENDER_API_KEY || !SENDER_GROUP_ID) {
      console.warn('❌ Sender.net not configured (missing SENDER_API_KEY or SENDER_GROUP_ID). Skipping.');
      return { skipped: true };
    }

    // Ensure we have a valid name
    const safeName = String(fullName || '').trim();
    const finalName = safeName || 'Customer';
    
    console.log(`   Debug - final name to use: "${finalName}"`);

    // Prepare payload for Sender.net API (use full name as first_name for simplicity)
    const payload = {
      email,
      first_name: finalName,
      last_name: '',
      groups: [SENDER_GROUP_ID],
      trigger_automation: true, // This will trigger the welcome email automation
      tags: ['customer', 'paystack', gclid ? `gclid:${gclid}` : 'gclid:none']
    };

    console.log(`   Debug - payload being sent:`, JSON.stringify(payload, null, 2));
    console.log(`   Sending to Sender.net API...`);
    
    const response = await axios.post(
      'https://api.sender.net/v2/subscribers',
      payload,
      {
        headers: {
          Authorization: `Bearer ${SENDER_API_KEY}`,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        }
      }
    );

    console.log('✅ SENDER.NET SUCCESS!');
    console.log(`   Status: ${response.status} ${response.statusText}`);
    console.log(`   Response: ${JSON.stringify(response.data)}`);
    console.log(`   Subscriber added to group: ${SENDER_GROUP_ID}`);
    console.log(`   Welcome automation should trigger automatically\n`);
    
    return { success: true, data: response.data };
  } catch (err) {
    console.error('❌ SENDER.NET FAILED!');
    console.error(`   Status: ${err.response?.status || 'Unknown'}`);
    console.error(`   Error: ${err.response?.data?.message || err.message}`);
    console.error(`   Full Response: ${JSON.stringify(err.response?.data || {})}`);
    console.error('');
    return { success: false, error: err.message };
  }
}


// --- Shared processor: send Telegram, add to Sender.net ---
async function handleSuccessfulPayment({
  reference,
  email,
  fullName,
  amountNaira,
  currency = 'NGN',
  gclid = 'direct',
  ipAddress = 'N/A',
  country = 'NG'
}) {
  console.log('\n🔄 Processing payment...');
  console.log(`   Reference: ${reference}`);
  console.log(`   Customer: ${fullName} (${email})`);
  console.log(`   Amount: ${currency} ${amountNaira}`);
  
  if (processedReferences.has(reference)) {
    console.log('⚠️  Payment already processed (duplicate prevented)');
    return { alreadyProcessed: true };
  }

  try {
    // 1) Send Telegram notification
    console.log('\n📱 Sending Telegram notification...');
    const message = [
      '🎉 <b>NEW CONVERSION</b> 🎉',
      '',
      '<b>Customer Details:</b>',
      `Full Name: ${esc(fullName)}`,
      `Email: ${esc(email)}`,
      '',
      '<b>Transaction Details:</b>',
      `Amount: ${esc(`${currency} ${amountNaira}`)}`,
      `Reference: ${esc(reference)}`,
      `Country: ${esc(country)}`,
      `IP Address: ${esc(ipAddress)}`,
      '',
      '<b>Google Ads Data:</b>',
      `GCLID: ${esc(gclid)}`,
      `Conversion Time: ${esc(new Date().toISOString())}`,
      '',
      '<b>For Google Ads Upload:</b>',
      `<pre>GCLID: ${esc(gclid)}
Conversion Name: Purchase
Conversion Time: ${esc(new Date().toISOString())}
Conversion Value: ${esc(String(amountNaira))}
Conversion Currency: ${esc(currency)}</pre>`
    ].join('\n');

    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      { chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: 'HTML', disable_web_page_preview: true }
    );
    console.log('✅ Telegram notification sent successfully');

    // 2) Add to Sender.net so the Welcome email (with download link) is sent automatically
    const senderResult = await addSubscriberToSender({ email, fullName, gclid });

    processedReferences.add(reference);
    console.log('✅ Payment processing completed successfully!\n');
    
    return { 
      alreadyProcessed: false, 
      senderSuccess: senderResult.success,
      senderData: senderResult.data 
    };
  } catch (error) {
    console.error('❌ Error during payment processing:', error.message);
    throw error;
  }
}

// --- Orchestrator endpoint the frontend calls from paycomplete.html ---
app.post('/api/process-order', async (req, res) => {
    try {
        const { email, fullName, reference, gclid, ipAddress, country } = req.body;
        if (!email || !fullName || !reference) {
            return res.status(400).json({ success: false, message: 'Missing email, fullName or reference' });
        }

        // Verify the transaction status via Paystack (required best-practice)
        const verify = await axios.get(
            `https://api.paystack.co/transaction/verify/${reference}`,
            { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` } }
        );

        const data = verify.data?.data;
        if (!(verify.data?.status && data?.status === 'success')) {
            return res.status(400).json({ success: false, message: 'Verification failed' });
        }

        // Convert kobo -> naira
        const amountNaira = Math.round(Number(data.amount) || 0) / 100;
        const currency = data.currency || 'NGN';

        const result = await handleSuccessfulPayment({
            reference,
            email,
            fullName,
            amountNaira,
            currency,
            gclid,
            ipAddress,
            country
        });

        return res.json({
            success: true,
            message: result.alreadyProcessed ? 'Already processed' : 'Processed',
            senderSuccess: result.senderSuccess || false
        });
    } catch (error) {
        console.error('process-order error:', error.response?.data || error.message);
        return res.status(500).json({ 
            success: false, 
            message: 'Server error', 
            error: error.message 
        });
    }
});


// --- Enhanced webhook: also calls the shared processor (server-side fallback) ---
app.post('/api/webhook/paystack', (req, res) => {
    try {
        const hash = crypto
            .createHmac('sha512', PAYSTACK_SECRET_KEY)
            .update(JSON.stringify(req.body))
            .digest('hex');

        if (hash !== req.headers['x-paystack-signature']) {
            console.log('❌ Invalid webhook signature');
            return res.sendStatus(400);
        }

        const event = req.body;
        if (event?.event === 'charge.success') {
            const ref = event.data?.reference;
            console.log('\n🔔 Webhook received: Payment successful');
            console.log(`   Reference: ${ref}`);

            // Pull details from event payload
            const email = event.data?.customer?.email || event.data?.authorization?.email;
            const fullName = event.data?.metadata?.full_name || `${event.data?.customer?.first_name || ''} ${event.data?.customer?.last_name || ''}`.trim() || 'Customer';
            const gclid = event.data?.metadata?.gclid || 'direct';
            const amountNaira = Math.round(Number(event.data?.amount) || 0) / 100;
            const currency = event.data?.currency || 'NGN';
            const ipAddress = event.data?.ip_address || req.ip;
            const country = event.data?.customer?.country || 'NG';

            // Fire and forget; don't block the webhook response
            handleSuccessfulPayment({
                reference: ref,
                email,
                fullName,
                amountNaira,
                currency,
                gclid,
                ipAddress,
                country
            }).catch(err => {
                const resp = err.response;
                console.error('Webhook processing error:', {
                    status: resp?.status,
                    statusText: resp?.statusText,
                    data: resp?.data || err.message
                });
            });
        }

        return res.sendStatus(200);
    } catch (error) {
        console.error('Webhook error:', error);
        return res.sendStatus(500);
    }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({
        success: true,
        message: 'Server is running',
        timestamp: new Date().toISOString()
    });
});

// Start server
app.listen(PORT, () => {
    console.log('==========================================');
    console.log(`🚀 Server is running on port ${PORT}`);
    console.log(`🏥 Health check: http://localhost:${PORT}/api/health`);
    console.log('==========================================\n');
    
    // Show Sender.net configuration status
    if (SENDER_API_KEY && SENDER_GROUP_ID) {
        console.log('✅ Sender.net configured');
        console.log(`   Group ID: ${SENDER_GROUP_ID}`);
    } else {
        console.log('⚠️  Sender.net NOT configured');
        console.log('   Please add SENDER_API_KEY and SENDER_GROUP_ID to .env file');
    }
    console.log('==========================================\n');
});
